-- Legacy `todo_date` column is no longer used by the new To-Do UI
-- (which writes start_date / due_date / importance instead). The original
-- schema still has NOT NULL on todo_date, so inserts from the new form fail
-- with: null value in column "todo_date" of relation "todos" violates not-null constraint.
--
-- Drop the NOT NULL constraint so todo_date can be left blank on new rows.
-- Existing rows keep their values; due_date was already backfilled from todo_date
-- by migrations/todos_priority.sql.
alter table public.todos
  alter column todo_date drop not null;
