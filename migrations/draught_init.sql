-- ════════════════════════════════════════════════════════════════════
-- Draught System Analysis 테이블 (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- 소스: "260611_Draught Analysis Progress&Status_XXW.xlsx" 의 Summary / Progress / 26Y BLADE Plan 시트.
-- kpi.html "데이터 업데이트" 탭에서 엑셀 업로드 → 파싱 → 적재.
-- 업로드는 "전체 삭제 후 재삽입"(sDel+sIns) 방식 → unique 제약 불필요.
-- ════════════════════════════════════════════════════════════════════

-- ① Movement Progress : 자산별 설치/철거/교체 (YTD + 월별 추이)
--   소스: Progress 시트 (자산×action 헤더행: YTD=F, 월 Total=L/Q/V/...)
create table if not exists public.draught_movement (
  id         bigserial primary key,
  brand      text not null default '',   -- Heineken / Paulaner
  asset      text not null default '',   -- DAVID / BLADE / Normal / Cooler(s) / Cooler(m) / PA Column / PA Coupler / Regulator
  action     text not null default '',   -- install(신규설치) / withdraw(단순철수) / replace_in(교체설치) / replace_out(교체철수)
  qty        numeric,                     -- YTD 누계
  m1 numeric, m2 numeric, m3 numeric, m4 numeric, m5 numeric, m6 numeric,
  m7 numeric, m8 numeric, m9 numeric, m10 numeric, m11 numeric, m12 numeric,
  updated_at timestamptz default now()
);

-- ② Paulaner Installation Stock : 자산×상태 재고 현황
--   소스: Summary 시트 cols J–M
create table if not exists public.draught_stock (
  id         bigserial primary key,
  asset      text not null default '',   -- DAVID / Normal / Cooler(s) / Cooler(m) / PA Column / PA Coupler / Regulator
  status     text not null default '',   -- Operation Total / Installation(_HE/_PA) / Available Stock / Broken Stock / Test
  qty        numeric,
  ratio      numeric,                     -- Operation Total 대비 비율 (0~1)
  updated_at timestamptz default now()
);

-- ③ BLADE Status & Plan
--   kind='status' : Summary cols X–Y (ESG KCTC 1st / Resales / Disposal Total)
--   kind='plan'   : 26Y BLADE Plan 시트 (월별 기말재고 추이)
create table if not exists public.draught_blade (
  id         bigserial primary key,
  kind       text not null default '',   -- 'status' | 'plan'
  label      text not null default '',   -- status: 항목명 / plan: 'Jan 2026' 등 월
  month      int,                         -- plan용 정렬 시퀀스 (1..N), status는 null
  inq        numeric,                     -- plan: 월 입고
  outq       numeric,                     -- plan: 월 출고
  ending     numeric,                     -- plan: 월 기말재고
  qty        numeric,                     -- status: 건수
  updated_at timestamptz default now()
);

alter table public.draught_movement enable row level security;
alter table public.draught_stock    enable row level security;
alter table public.draught_blade    enable row level security;

drop policy if exists "open" on public.draught_movement;
drop policy if exists "open" on public.draught_stock;
drop policy if exists "open" on public.draught_blade;
create policy "open" on public.draught_movement for all using (true) with check (true);
create policy "open" on public.draught_stock    for all using (true) with check (true);
create policy "open" on public.draught_blade     for all using (true) with check (true);
