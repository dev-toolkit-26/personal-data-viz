-- Off-Trade와 On-Trade 대시보드가 같은 Supabase 프로젝트의 회의록/캘린더/할일 테이블을
-- 공유하므로, 'dashboard' 디스크리미네이터 컬럼을 추가해 행을 격리한다.
-- 기존 행은 모두 'on_trade'로 남고, Off-Trade 클라이언트는 'off_trade'로 INSERT/SELECT.

alter table public.meeting_minutes  add column if not exists dashboard text not null default 'on_trade';
alter table public.calendar_events  add column if not exists dashboard text not null default 'on_trade';
alter table public.todos            add column if not exists dashboard text not null default 'on_trade';

-- 인덱스 (dashboard 컬럼 기반 필터 가속)
create index if not exists meeting_minutes_dashboard_idx on public.meeting_minutes (dashboard);
create index if not exists calendar_events_dashboard_idx on public.calendar_events (dashboard);
create index if not exists todos_dashboard_idx           on public.todos (dashboard);

-- PostgREST 스키마 캐시 새로고침
notify pgrst, 'reload schema';

-- ---------------------------------------------------------------------------
-- 검증 쿼리 (실행 후 수동 확인용)
-- ---------------------------------------------------------------------------
-- select dashboard, count(*) from public.meeting_minutes group by dashboard;
-- select dashboard, count(*) from public.calendar_events group by dashboard;
-- select dashboard, count(*) from public.todos           group by dashboard;
