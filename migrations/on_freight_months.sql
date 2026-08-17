-- ════════════════════════════════════════════════════════════════════
--  On-Trade 운송비(Freight) 월별 배송건 테이블 (1회 실행)
--  On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
--  · index.html Freight 탭 / Data Update "🚚 운송비 DSR 백필" · 통합 DSR 업로드가 월 단위로 upsert.
--  · id = 'YYYY-MM', data = { ym, y, m, deliv:[[key, day, box, hl, branch, ncodes]...],
--                              names:{key:name}, unmapped:{code:[name,box,hl,n,branch]}, meta:{...} }
--  · 요율표·코드 매핑은 freight_master.js(정적)에 있고, 이 테이블은 DSR에서 뽑은 배송건만 저장.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.on_freight_months (
  id          text primary key,                       -- 'YYYY-MM'
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);

alter table public.on_freight_months enable row level security;

drop policy if exists on_freight_read on public.on_freight_months;
create policy on_freight_read
  on public.on_freight_months
  for select using (true);

-- 쓰기 — 다른 스냅샷 테이블과 동일하게 anon 허용 (TODO 보안: access_tokens 기반으로 조이기)
drop policy if exists on_freight_write on public.on_freight_months;
create policy on_freight_write
  on public.on_freight_months
  for all using (true) with check (true);

notify pgrst, 'reload schema';
