-- ════════════════════════════════════════════════════════════════════
--  On-Trade 공케그 · CO2 현황 테이블 (1회 실행)
--  On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
--  · index.html Cost › 공케그·CO2 탭(keg_co2.html iframe) / Data Update "🛢 공케그·CO2 SAP RAW" 슬롯이 사용.
--  · id = 'meta'      → {updated, sources[], map[[SAP Code, SR, Customer]...]}
--         'branch'    → {sr:{SR:지점}, wh:{KRSR코드:{name, br}}}
--         'm:YYYY-MM' → {rows:[[SAP RAW 16열]...]}  (Delivery Date 월별, 바뀐 월만 upsert)
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.on_keg_co2 (
  id          text primary key,
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);

alter table public.on_keg_co2 enable row level security;

drop policy if exists on_keg_co2_read on public.on_keg_co2;
create policy on_keg_co2_read
  on public.on_keg_co2
  for select using (true);

-- 쓰기 — 다른 스냅샷 테이블과 동일하게 anon 허용 (TODO 보안: access_tokens 기반으로 조이기)
drop policy if exists on_keg_co2_write on public.on_keg_co2;
create policy on_keg_co2_write
  on public.on_keg_co2
  for all using (true) with check (true);

notify pgrst, 'reload schema';
