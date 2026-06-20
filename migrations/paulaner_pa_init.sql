-- ════════════════════════════════════════════════════════════════════
-- Paulaner PA Draught Install (PA Normal / PA Column) — raw 원본 적재 (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- 소스: "260611_Draught Analysis Progress&Status_XXW.xlsx" 의 'Progress Raw data' 시트 (신규설치 이벤트).
-- 필터: 설치사유=신규설치 & 브랜드=Paulaner & 자산(수식0)∈{Normal, PA Column}.
--   Normal→'PA Normal', 'PA Column'→'PA Column'. (Draught System 탭 YTD 신규설치 25/25와 동일 모집단)
-- 설치월 = 변경일자(월). region = Office에서 'On ' 제거, NKA Check='NKA'면 region=NKA.
-- 업장 dedup 없음 = 설치 건(대) 단위.
-- kpi.html "데이터 업데이트" 탭에서 엑셀 업로드 → 파싱 → 적재.
-- 업로드는 "전체 삭제 후 재삽입"(sDel+sIns) 방식 → unique 제약 불필요.
-- ⚠ paulaner_outlets_v2(20L 키그)와 절대 섞지 말 것 — 별도 테이블/별도 섹션.
-- ════════════════════════════════════════════════════════════════════
create table if not exists public.paulaner_pa_installs (
  id         bigserial primary key,
  region     text not null default '',   -- Seoul/Busan/Daejeon/Daegu/Gwangju/Jeju/NKA
  ws         text not null default '',   -- 도매상
  outlet     text not null default '',   -- 거래처명
  addr       text not null default '',   -- 주소
  system     text not null default '',   -- 'PA Normal' | 'PA Column'
  m3 numeric, m4 numeric, m5 numeric, m6 numeric, m7 numeric,
  m8 numeric, m9 numeric, m10 numeric, m11 numeric, m12 numeric,
  updated_at timestamptz default now()
);

alter table public.paulaner_pa_installs enable row level security;
drop policy if exists "open" on public.paulaner_pa_installs;
create policy "open" on public.paulaner_pa_installs for all using (true) with check (true);
