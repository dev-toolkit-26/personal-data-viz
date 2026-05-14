-- Extend `todos` table to support standalone To-Do list (decoupled from calendar)
-- Adds: start_date, due_date, importance.
-- Backfills due_date from existing todo_date so historical rows remain visible.

alter table public.todos
  add column if not exists start_date  date,
  add column if not exists due_date    date,
  add column if not exists importance  text not null default 'medium';

-- Backfill: if due_date is null but todo_date exists, copy it over.
update public.todos
   set due_date = todo_date
 where due_date is null
   and todo_date is not null;

-- Sanity check on importance values (low/medium/high). Loose constraint so future
-- expansion (e.g., 'critical') doesn't require dropping it first.
alter table public.todos
  drop constraint if exists todos_importance_chk;
alter table public.todos
  add  constraint todos_importance_chk
       check (importance in ('low','medium','high'));

-- Helpful index for the priority-sorted list view.
create index if not exists todos_due_date_idx on public.todos (due_date);
