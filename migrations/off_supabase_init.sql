-- ════════════════════════════════════════════════════════════════════
-- Off-Trade 전용 Supabase 프로젝트 초기화 (1회 실행)
-- 새 프로젝트 (이전 "sales-tool" → "off-trade" 리네임)의 SQL Editor에서 실행.
-- 모든 테이블 + 인증 RPC + RLS 오픈 정책 생성.
-- ════════════════════════════════════════════════════════════════════

-- ① 대시보드 스냅샷 (전체 OFF 데이터 트리: channels/rows/meta/revenue)
create table if not exists public.off_dashboard_snapshots (
  id          int primary key,
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);
insert into public.off_dashboard_snapshots (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- ② 회의록 (agenda·action_items는 jsonb; 클라이언트가 직렬화 후 저장)
create table if not exists public.meeting_minutes (
  id            bigserial primary key,
  week_label    text,
  meeting_date  date,
  attendees     text default '',
  agenda        jsonb default '[]'::jsonb,
  action_items  jsonb default '[]'::jsonb,
  created_at    timestamptz default now()
);

-- ③ 캘린더 이벤트 (반복·시간 + owner_label + is_broadcast)
create table if not exists public.calendar_events (
  id                bigserial primary key,
  event_date        date not null,
  event_title       text not null default '',
  event_type        text,
  description       text,
  start_time        time,
  end_time          time,
  recurrence_type   text default 'none',
  recurrence_by_day text,
  recurrence_until  date,
  owner_label       text default '',
  is_broadcast      boolean default false,
  created_at        timestamptz default now()
);

-- ④ 할일 (우선순위·날짜·소유자·방송)
create table if not exists public.todos (
  id            bigserial primary key,
  text          text not null default '',
  done          boolean default false,
  start_date    date,
  due_date      date,
  importance    text default 'medium' check (importance in ('low','medium','high')),
  note          text,
  owner_label   text default '',
  is_broadcast  boolean default false,
  created_at    timestamptz default now()
);

-- ⑤ 인증 토큰 + SECURITY DEFINER RPC (validate-token 엣지함수 대체)
create table if not exists public.access_tokens (
  token       text primary key,
  label       text not null,
  is_admin    boolean default false,
  created_at  timestamptz default now()
);
alter table public.access_tokens enable row level security;
drop policy if exists at_no_direct on public.access_tokens;
create policy at_no_direct on public.access_tokens
  for all using (false) with check (false);   -- anon 직접 조회 차단

-- 토큰 검증 RPC: 평문 비밀번호 외부 노출 없이 결과만 반환
create or replace function public.verify_off_token(t text) returns jsonb
  language sql
  security definer
  set search_path = public
as $$
  select case
    when exists (select 1 from access_tokens where token = t) then
      jsonb_build_object(
        'ok',       true,
        'label',    (select label    from access_tokens where token = t),
        'is_admin', (select is_admin from access_tokens where token = t)
      )
    else jsonb_build_object('ok', false)
  end;
$$;
grant execute on function public.verify_off_token(text) to anon, authenticated;

-- ⑥ RLS — 별도 DB라 안전. 4개 테이블 모두 publishable 키로 read/write 허용.
alter table public.off_dashboard_snapshots enable row level security;
alter table public.meeting_minutes         enable row level security;
alter table public.calendar_events         enable row level security;
alter table public.todos                   enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['off_dashboard_snapshots','meeting_minutes','calendar_events','todos'])
  loop
    execute format('drop policy if exists open_all on public.%I', t);
    execute format('create policy open_all on public.%I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ⑦ 사용자 토큰 등록 — 운영자/영업담당자 비번 추가 (실행 전 token/label/is_admin 채워서)
-- insert into public.access_tokens (token, label, is_admin) values
--   ('<your-password-1>', '김성원',  true),
--   ('<your-password-2>', '영업담당A', false),
--   ('<your-password-3>', '영업담당B', false);

-- ⑧ PostgREST 스키마 캐시 새로고침
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (실행 후 수동 확인용)
-- ─────────────────────────────────────────────────────────────────────
-- select 'off_dashboard_snapshots' as tbl, count(*) from public.off_dashboard_snapshots
--   union all select 'meeting_minutes', count(*) from public.meeting_minutes
--   union all select 'calendar_events', count(*) from public.calendar_events
--   union all select 'todos',           count(*) from public.todos
--   union all select 'access_tokens',   count(*) from public.access_tokens;
-- select public.verify_off_token('<your-password>');   -- {ok:true, label:'...', is_admin:true} 반환 확인
