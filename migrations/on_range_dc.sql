-- ════════════════════════════════════════════════════════════════════
--  On-Trade WS Range DC 테이블 (1회 실행)
--  On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
--  · index.html Range DC 탭 / 통합 DSR 업로드 · 운송비(Freight) 백필 슬롯이 함께 upsert.
--  · id = 'm:YYYY-MM' → { ym, codes:{배송처코드:[환산케이스, HL]}, meta:{maxDay,nDays,rows} }
--  · id = 'q:YYYYQn' / 'q:YYYYY' → { fcst:{code:cs}, dec:{code:{r,memo}}, updated_at }
--    (분기 마감 FCST 입력과 차기 분기 Range 결정 — Range DC 탭에서 자동 저장)
--  · 가이드라인·도매장 원장·파생코드 매핑은 range_master.js(정적)에 있음.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.on_range_dc (
  id          text primary key,                       -- 'm:YYYY-MM' | 'q:YYYYQn' | 'q:YYYYY'
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);

alter table public.on_range_dc enable row level security;

drop policy if exists on_range_dc_read on public.on_range_dc;
create policy on_range_dc_read
  on public.on_range_dc
  for select using (true);

-- 쓰기 — 다른 스냅샷 테이블과 동일하게 anon 허용 (TODO 보안: access_tokens 기반으로 조이기)
drop policy if exists on_range_dc_write on public.on_range_dc;
create policy on_range_dc_write
  on public.on_range_dc
  for all using (true) with check (true);

notify pgrst, 'reload schema';
