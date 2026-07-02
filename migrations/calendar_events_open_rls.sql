-- calendar_events: open RLS policies for the anon role
--
-- Context: this app uses a single Supabase anon key for every user and tracks
-- identity purely client-side via sessionStorage.auth_label (returned by the
-- validate-token edge function). There is no Supabase auth.uid() to bind RLS to.
--
-- The client code is the authoritative ownership guard:
--   - INSERT always sets payload.owner_label = me
--   - UPDATE/DELETE add .eq('owner_label', me) for non-admin users
--   - SELECT filters via .or(`owner_label.eq.${me},is_broadcast.eq.true`)
--
-- The `todos` table already works for every user under this model, so
-- calendar_events needs the same permissive setup. Symptom before this:
-- non-admin users got "일정 저장 실패: ..." because an existing policy
-- limited writes to the original owner_label '김성원'.

alter table public.calendar_events enable row level security;

-- Drop any pre-existing policies that may restrict by owner_label.
-- (Idempotent — IF EXISTS so re-running the migration is safe.)
drop policy if exists "calendar_events_select_all"  on public.calendar_events;
drop policy if exists "calendar_events_insert_all"  on public.calendar_events;
drop policy if exists "calendar_events_update_all"  on public.calendar_events;
drop policy if exists "calendar_events_delete_all"  on public.calendar_events;

create policy "calendar_events_select_all"
  on public.calendar_events
  for select
  using (true);

create policy "calendar_events_insert_all"
  on public.calendar_events
  for insert
  with check (true);

create policy "calendar_events_update_all"
  on public.calendar_events
  for update
  using (true)
  with check (true);

create policy "calendar_events_delete_all"
  on public.calendar_events
  for delete
  using (true);

notify pgrst, 'reload schema';
