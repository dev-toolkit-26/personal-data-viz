-- Per-user ownership + admin broadcast flag + todo comments
-- Frontend stores user identifier as sessionStorage.auth_label (returned by validate-token).
-- All client-side filter: select where owner_label = me OR is_broadcast = true.

-- 1) Ownership column on both tables
alter table public.calendar_events add column if not exists owner_label  text;
alter table public.todos           add column if not exists owner_label  text;

-- 2) Broadcast flag (admin-only at the UI layer)
alter table public.calendar_events add column if not exists is_broadcast boolean not null default false;
alter table public.todos           add column if not exists is_broadcast boolean not null default false;

-- 3) Todo comment / note
alter table public.todos add column if not exists note text;

-- 4) Backfill existing rows to the current single user (auth_label='김성원').
update public.calendar_events set owner_label = '김성원' where owner_label is null;
update public.todos           set owner_label = '김성원' where owner_label is null;

-- 5) Indexes for the per-user + broadcast query pattern
create index if not exists calendar_events_owner_idx      on public.calendar_events (owner_label);
create index if not exists calendar_events_broadcast_idx  on public.calendar_events (is_broadcast) where is_broadcast = true;
create index if not exists todos_owner_idx                on public.todos (owner_label);
create index if not exists todos_broadcast_idx            on public.todos (is_broadcast) where is_broadcast = true;
