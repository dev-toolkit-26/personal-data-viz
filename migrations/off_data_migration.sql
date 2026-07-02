-- ════════════════════════════════════════════════════════════════════
-- Off 데이터 이전 — 공유 Supabase (elqammnozbfhkitnncsz) → 새 off-trade
-- 두 프로젝트의 SQL Editor를 동시에 열고 진행.
-- ════════════════════════════════════════════════════════════════════

-- ─────────────────────────────────────────────
-- STEP A. 공유 프로젝트(elqammnozbfhkitnncsz)의 SQL Editor에서 실행
--   off_dashboard_snapshots id=1 행을 INSERT 문으로 export
-- ─────────────────────────────────────────────
select 'insert into public.off_dashboard_snapshots (id,data,updated_at) values (1,$migrate$' ||
       data::text ||
       '$migrate$::jsonb,' || quote_literal(updated_at) || '::timestamptz) ' ||
       'on conflict (id) do update set data=excluded.data, updated_at=excluded.updated_at;'
  as migration_sql
from public.off_dashboard_snapshots
where id = 1;

-- 결과 셀(`migration_sql`)의 문자열을 복사 → 새 off-trade 프로젝트의 SQL Editor에 붙여 실행.
-- $migrate$ ... $migrate$ 는 dollar-quoting이라 jsonb 안에 따옴표가 있어도 안전.


-- ─────────────────────────────────────────────
-- STEP B (선택). 회의록/캘린더/할일 dashboard='off_trade' 행 이전
--   필요 시 — 새로 시작할거면 생략 가능.
-- ─────────────────────────────────────────────

-- 공유 프로젝트에서 — 회의록
-- select 'insert into public.meeting_minutes (week_label,meeting_date,attendees,agenda,action_items,created_at) values (' ||
--        quote_literal(week_label) || ',' ||
--        quote_nullable(meeting_date) || ',' ||
--        quote_literal(coalesce(attendees,'')) || ',' ||
--        '$mm$' || coalesce(agenda::text, '[]') || '$mm$::jsonb,' ||
--        '$mm$' || coalesce(action_items::text, '[]') || '$mm$::jsonb,' ||
--        quote_literal(created_at) || '::timestamptz);'
--   from public.meeting_minutes where dashboard = 'off_trade';

-- 공유 프로젝트에서 — 캘린더
-- select 'insert into public.calendar_events (event_date,event_title,event_type,description,start_time,end_time,recurrence_type,recurrence_by_day,recurrence_until,owner_label,is_broadcast,created_at) values (' ||
--        quote_literal(event_date) || ',' || quote_literal(event_title) || ',' || quote_nullable(event_type) || ',' ||
--        quote_nullable(description) || ',' || quote_nullable(start_time) || ',' || quote_nullable(end_time) || ',' ||
--        quote_nullable(recurrence_type) || ',' || quote_nullable(recurrence_by_day) || ',' || quote_nullable(recurrence_until) || ',' ||
--        quote_literal(owner_label) || ',' || is_broadcast || ',' || quote_literal(created_at) || '::timestamptz);'
--   from public.calendar_events where dashboard = 'off_trade';

-- 공유 프로젝트에서 — 할일
-- select 'insert into public.todos (text,done,start_date,due_date,importance,note,owner_label,is_broadcast,created_at) values (' ||
--        quote_literal(text) || ',' || done || ',' ||
--        quote_nullable(start_date) || ',' || quote_nullable(due_date) || ',' ||
--        quote_literal(coalesce(importance,'medium')) || ',' || quote_nullable(note) || ',' ||
--        quote_literal(owner_label) || ',' || is_broadcast || ',' || quote_literal(created_at) || '::timestamptz);'
--   from public.todos where dashboard = 'off_trade';

-- 각 select 결과를 복사해 새 off-trade 프로젝트의 SQL Editor에 붙여 실행.

-- ─────────────────────────────────────────────
-- STEP C. 새 프로젝트에서 검증
-- ─────────────────────────────────────────────
-- select id, jsonb_typeof(data) data_type, jsonb_array_length(data->'rows') rows_n, updated_at
--   from public.off_dashboard_snapshots;
-- → 1행: rows_n ≈ 469 (또는 더 많을 수도), updated_at 기존 값
