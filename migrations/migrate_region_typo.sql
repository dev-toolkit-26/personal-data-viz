-- =====================================================================
-- paulaner_outlets_v2: 지역명 'Daeug' 오타를 'Daegu' 정본으로 교정
-- 실행: Supabase Dashboard > SQL Editor 에 붙여넣고 순차 실행
-- 배경: kpi.html 커밋 458cddd 이전 normalizer(PL_REGION_NORM)는
--       canonical이 'Daeug'였어서 해당 시점까지 대구 업로드분이
--       region='Daeug'로 저장되어 있음. 현재 UI/집계 상수는
--       'Daegu'만 인식하므로 레거시 행이 누락·오표시됨.
-- =====================================================================

-- (1) 사전 점검: 교정 대상 행 수 확인
SELECT count(*) AS daeug_rows
  FROM paulaner_outlets_v2
 WHERE region = 'Daeug';

-- (2) 사전 점검: 같은 (ws, outlet, system) 키로 'Daegu' 쪽에 이미
--     중복 행이 있는지 확인 — 결과 0건이면 (3) 진행
SELECT ws, outlet, system, count(*) AS n
  FROM paulaner_outlets_v2
 WHERE region IN ('Daeug','Daegu')
 GROUP BY ws, outlet, system
HAVING count(*) > 1;

-- (3) region='Daeug' → 'Daegu' 교정
UPDATE paulaner_outlets_v2
   SET region = 'Daegu'
 WHERE region = 'Daeug';

-- (4) 검증: 'Daeug' 잔존 0, 'Daegu' 행 수 증가 확인
SELECT region, count(*) AS rows
  FROM paulaner_outlets_v2
 WHERE region IN ('Daeug','Daegu')
 GROUP BY region
 ORDER BY region;
