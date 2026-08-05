-- ════════════════════════════════════════════════════════════════════
-- Bottle Incentive: Channel / Sales tool 항목 추가 (기존 테이블 1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- "Sales Market Visit (Bottle boost)" 파일에 Outlet 다음 Channel·Sales tool
-- 두 컬럼이 추가되어, 이를 적재하기 위한 스키마 확장.
-- 이미 컬럼이 있으면 무시(if not exists) → 여러 번 실행해도 안전.
-- 이 SQL을 먼저 실행해야 업로드(대시보드 반영) 시 오류(PGRST204)가 나지 않음.
-- ════════════════════════════════════════════════════════════════════

alter table public.bottle_incentive add column if not exists channel    text default '';
alter table public.bottle_incentive add column if not exists sales_tool text default '';
