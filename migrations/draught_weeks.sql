-- ════════════════════════════════════════════════════════════════════
-- Draught Movement 주차(weekly) + 지점(office) 컬럼 추가 (1회 실행)
-- On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
-- Progress 시트의 자산×동작(설치/철거/교체)을:
--   · weeks jsonb : 주차 추이(1W~52W) 배열
--   · office text : 지점(On Seoul~Jeju). null = 전 지점 합계(총계 행)
-- 로 저장. 실행 후 kpi.html "데이터 업데이트" 탭에서 Draught Analysis 파일을
-- 재업로드해야 값이 채워진다 (기존 행은 weeks/office=null).
-- ════════════════════════════════════════════════════════════════════

alter table public.draught_movement
  add column if not exists weeks  jsonb,
  add column if not exists office text;
