-- Off 회의록 동시 저장 충돌 감지용 버전 컬럼.
-- 클라이언트는 저장 시 "읽은 rev와 같을 때만" update(rev+1) → 그 사이 누가 저장했으면 0행이 되어
-- 최신본을 다시 읽고 카드 단위로 재병합한다. 컬럼이 없으면 조건 없이 병합 저장(이전보다 안전하지만 경합 창 존재).
alter table public.off_meeting_minutes add column if not exists rev integer not null default 0;

notify pgrst, 'reload schema';
