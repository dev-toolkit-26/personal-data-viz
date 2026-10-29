-- 여러 날 일정(워크샵 등): 종료일 컬럼. null = 단일 날짜 일정(기존 동작).
-- 반복 일정은 하루 단위라 end_date를 쓰지 않음(클라이언트에서 null로 저장).
alter table public.calendar_events     add column if not exists end_date date;
alter table public.off_calendar_events add column if not exists end_date date;

alter table public.calendar_events drop constraint if exists calendar_events_end_date_chk;
alter table public.calendar_events add  constraint calendar_events_end_date_chk
  check (end_date is null or end_date >= event_date);
alter table public.off_calendar_events drop constraint if exists off_calendar_events_end_date_chk;
alter table public.off_calendar_events add  constraint off_calendar_events_end_date_chk
  check (end_date is null or end_date >= event_date);

-- 시간 체크는 같은 날 일정에만 적용 (1일 14:00 ~ 2일 11:00 허용)
alter table public.calendar_events drop constraint if exists calendar_events_time_chk;
alter table public.calendar_events add  constraint calendar_events_time_chk
  check (start_time is null or end_time is null
         or (end_date is not null and end_date > event_date)
         or end_time >= start_time);

notify pgrst, 'reload schema';
