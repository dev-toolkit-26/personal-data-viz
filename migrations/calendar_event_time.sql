-- Calendar event start/end time (both nullable → all-day events still supported).
alter table public.calendar_events
  add column if not exists start_time time,
  add column if not exists end_time   time;

-- Sanity: end_time must be >= start_time when both present.
alter table public.calendar_events drop constraint if exists calendar_events_time_chk;
alter table public.calendar_events add  constraint calendar_events_time_chk
  check (start_time is null or end_time is null or end_time >= start_time);

notify pgrst, 'reload schema';
