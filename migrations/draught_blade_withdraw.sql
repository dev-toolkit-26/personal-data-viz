-- ════════════════════════════════════════════════════════════════════
-- BLADE 철수 진척 (지점 × 주차 운영대수) 테이블 (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- 소스: "Draught Analysis Progress&Status_XXW.xlsx" 의 'BLADE Withdraw Progress' 시트,
--       각 지점의 'Installation in Outlet' 행(= BLADE 운영대수)을 주차별로 적재.
-- kpi.html "데이터 업데이트" 탭 Draught 업로드 시 함께 갱신(전체 삭제 후 재삽입).
-- Total 행은 저장하지 않고 프론트에서 지점 합으로 계산.
-- 주별 철수 = 이번주 − 지난주 운영대수, 진척률 = (현재 − 14W) ÷ 14W → 목표 -100%.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.draught_blade_withdraw (
  id           bigserial primary key,
  region       text not null default '',   -- 'On Seoul' / 'On Busan' / ... (Total 제외)
  week         text not null default '',   -- '14W' / '15W' ...
  week_num     int,                         -- 14 (정렬용)
  installation int,                         -- BLADE 운영대수(Installation in Outlet)
  updated_at   timestamptz default now()
);

alter table public.draught_blade_withdraw enable row level security;
drop policy if exists "open" on public.draught_blade_withdraw;
create policy "open" on public.draught_blade_withdraw for all using (true) with check (true);
