-- =====================================================================
-- paulaner_outlets_v2: NKA 채널을 별도 region 값으로 승격하는 1회성 마이그레이션
-- 실행: Supabase Dashboard > SQL Editor 에 붙여넣고 순차 실행
-- =====================================================================

-- (1) 사전 점검: 옮기려는 NKA 행이 이미 region='NKA' 공간에 동일 키로 존재하는지
--     결과 0건이면 안전하게 (2) 진행
SELECT region, ws, outlet, system, count(*) AS n
  FROM paulaner_outlets_v2
 WHERE channel = 'NKA'
 GROUP BY region, ws, outlet, system
HAVING count(*) > 1;

-- (2) channel='NKA' 행의 region 을 'NKA' 로 승격
UPDATE paulaner_outlets_v2
   SET region = 'NKA'
 WHERE channel = 'NKA';

-- (3) channel 컬럼을 'Outlet' 으로 통일 (컬럼 자체는 DROP 하지 않음)
UPDATE paulaner_outlets_v2
   SET channel = 'Outlet'
 WHERE channel IS DISTINCT FROM 'Outlet';

-- (4) 검증: 지역별 행 수 확인 — NKA 행 수가 마이그레이션 전 channel='NKA' 개수와 일치해야 함
SELECT region, count(*) AS rows
  FROM paulaner_outlets_v2
 GROUP BY region
 ORDER BY region;
