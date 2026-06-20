-- ════════════════════════════════════════════════════════════════════
-- Paulaner PA Normal/Column 지역(NKA) 수동 재분류 override (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- 용도: paulaner_pa_installs 의 자동 분류(NKA Check 컬럼)가 잘못된 업장을
--       업장명(outlet) 단위로 화면에서 수동으로 지역/NKA 재지정.
--       Draught Analysis 재업로드로 paulaner_pa_installs 가 전체 재생성돼도
--       kpi.html 로드/업로드 직후 applyPaOverrides() 로 자동 재적용되어 유지됨.
-- 키: outlet(업장명). 같은 업장의 PA Normal·PA Column 행은 함께 이동.
-- ════════════════════════════════════════════════════════════════════
create table if not exists public.paulaner_pa_overrides (
  outlet     text primary key,   -- 거래처명 (override 키)
  region     text not null,      -- 강제 지정 지역: Seoul/Busan/Daejeon/Daegu/Gwangju/Jeju/NKA
  updated_at timestamptz default now()
);

alter table public.paulaner_pa_overrides enable row level security;
drop policy if exists "open" on public.paulaner_pa_overrides;
create policy "open" on public.paulaner_pa_overrides for all using (true) with check (true);
