-- ════════════════════════════════════════════════════════════════════
--  On-Trade WS Range DC — 변경 히스토리 (1회 실행)
--  On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
--  · on_range_dc 의 분기 입력 행('q:...')과 SR 맵('_srmap')이 바뀌거나 지워질 때마다
--    "바뀌기 직전 값"을 on_range_dc_history 에 자동 보관한다 (트리거 — 클라이언트 수정 불필요).
--  · 월별 실적('m:YYYY-MM')은 업로드로 언제든 재생성 가능 + 용량이 커서 제외.
--  · 2026-09-29 구버전 탭의 행 전체 덮어쓰기로 3Q 부산·대구·제주 입력이 사라진 사고 대응.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.on_range_dc_history (
  hist_id     bigserial    primary key,
  row_id      text         not null,                  -- 'q:2026Q3' | '_srmap' ...
  op          text         not null,                  -- 'UPDATE' | 'DELETE'
  old_data    jsonb        not null,                  -- 변경 직전 data
  n_fcst      int,                                    -- 빠른 확인용: 직전 fcst 셀 수
  n_dec       int,                                    -- 빠른 확인용: 직전 dec 셀 수
  changed_at  timestamptz  not null default now()
);
create index if not exists on_range_dc_history_row_idx
  on public.on_range_dc_history (row_id, changed_at desc);

alter table public.on_range_dc_history enable row level security;

-- 읽기만 허용. 쓰기는 아래 트리거(security definer)만 — 클라이언트가 이력을 지우거나 조작할 수 없음.
drop policy if exists on_range_dc_history_read on public.on_range_dc_history;
create policy on_range_dc_history_read
  on public.on_range_dc_history
  for select using (true);

create or replace function public.on_range_dc_keep_history()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.id like 'q:%' or old.id = '_srmap' then
    -- 내용이 실제로 바뀐 경우만 기록 (updated_at만 바뀐 저장은 건너뜀)
    if tg_op = 'DELETE'
       or (old.data - 'updated_at') is distinct from (new.data - 'updated_at') then
      insert into public.on_range_dc_history (row_id, op, old_data, n_fcst, n_dec)
      values (
        old.id, tg_op, old.data,
        (select count(*) from jsonb_object_keys(coalesce(old.data->'fcst', '{}'::jsonb))),
        (select count(*) from jsonb_object_keys(coalesce(old.data->'dec',  '{}'::jsonb)))
      );
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists on_range_dc_history_trg on public.on_range_dc;
create trigger on_range_dc_history_trg
  before update or delete on public.on_range_dc
  for each row execute function public.on_range_dc_keep_history();

notify pgrst, 'reload schema';

-- ────────────────────────────────────────────────────────────────────
--  사용법
-- ────────────────────────────────────────────────────────────────────
--  ① 이력 훑어보기 — 셀 수가 갑자기 줄어든 시점을 찾는다
--     select hist_id, changed_at, n_fcst, n_dec
--       from on_range_dc_history where row_id = 'q:2026Q4'
--      order by changed_at desc limit 50;
--
--  ② 특정 시점으로 통째 복원 (hist_id = ①에서 찾은 "사라지기 직전" 행)
--     update on_range_dc set data = h.old_data, updated_at = now()
--       from on_range_dc_history h
--      where h.hist_id = <hist_id> and on_range_dc.id = h.row_id;
--     (복원 자체도 이력에 남으므로 잘못 복원해도 되돌릴 수 있음)
--
--  ③ 사라진 셀만 되살리기(이후 다른 사람이 입력한 값은 유지) — fcst/dec 키 단위 병합
--     update on_range_dc t set data = jsonb_set(jsonb_set(t.data,
--         '{fcst}', coalesce(h.old_data->'fcst','{}') || coalesce(t.data->'fcst','{}')),
--         '{dec}',  coalesce(h.old_data->'dec','{}')  || coalesce(t.data->'dec','{}')),
--         updated_at = now()
--       from on_range_dc_history h
--      where h.hist_id = <hist_id> and t.id = h.row_id;
