-- ════════════════════════════════════════════════════════════════════
-- Bottle Incentive (Market Visit / Bottle Boost) 방문·집행 테이블 (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- 할당(예산) 금액은 kpi.html 의 BI_ALLOC 상수로 고정 관리하고,
-- 변동되는 방문 단위 집행 데이터만 이 테이블에 적재한다.
-- 업로드는 "해당 지점 전체 삭제 후 재삽입"(sDel+sIns) 방식 → unique 제약 불필요.
-- ════════════════════════════════════════════════════════════════════

create table if not exists public.bottle_incentive (
  id         bigserial primary key,
  team       text not null default '',   -- 한글 지점명(서울/부산/대전/광주/대구/제주)
  no         int,
  year       int,
  mv_month   int,
  mv_date    text,
  outlet     text default '',
  ws         text default '',
  brand      text default '',
  sr         text default '',
  volume     numeric,                     -- Volume impact
  budget     numeric,                     -- 집행 금액(원)
  mgr        text default '',
  updated_at timestamptz default now()
);

alter table public.bottle_incentive enable row level security;

drop policy if exists "open" on public.bottle_incentive;
create policy "open" on public.bottle_incentive for all using (true) with check (true);
