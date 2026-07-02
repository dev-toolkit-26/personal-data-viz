-- ════════════════════════════════════════════════════════════════════
-- Off-Trade → On-Trade 프로젝트 통합 (1회 실행)
-- On-Trade Supabase 프로젝트(elqammnozbfhkitnncsz)의 SQL Editor에서 실행.
--
-- 목적: Off 채널을 On 프로젝트 하나로 흡수. 인증(access_tokens/validate-token)은
--       On 것을 그대로 재사용하고, Off 데이터는 off_ 접두 테이블로 네임스페이스해
--       On 데이터(dashboard_snapshots, meeting_minutes 등)와 완전히 격리한다.
--
-- 주의: On의 기존 테이블/엣지함수/access_tokens 는 건드리지 않는다.
-- ════════════════════════════════════════════════════════════════════

-- ① Off 대시보드 스냅샷 (Off/index.html 이 이 이름 그대로 read/write)
create table if not exists public.off_dashboard_snapshots (
  id          int primary key,
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);
insert into public.off_dashboard_snapshots (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

-- ② Off 회의록
create table if not exists public.off_meeting_minutes (
  id            bigserial primary key,
  week_label    text,
  meeting_date  date,
  attendees     text default '',
  agenda        jsonb default '[]'::jsonb,
  action_items  jsonb default '[]'::jsonb,
  created_at    timestamptz default now()
);

-- ③ Off 캘린더 이벤트
create table if not exists public.off_calendar_events (
  id                bigserial primary key,
  event_date        date not null,
  event_title       text not null default '',
  event_type        text,
  description       text,
  start_time        time,
  end_time          time,
  recurrence_type   text default 'none',
  recurrence_by_day text,
  recurrence_until  date,
  owner_label       text default '',
  is_broadcast      boolean default false,
  created_at        timestamptz default now()
);

-- ④ Off 할일
create table if not exists public.off_todos (
  id            bigserial primary key,
  text          text not null default '',
  done          boolean default false,
  start_date    date,
  due_date      date,
  importance    text default 'medium' check (importance in ('low','medium','high')),
  note          text,
  owner_label   text default '',
  is_broadcast  boolean default false,
  created_at    timestamptz default now()
);

-- ⑤ RLS — off_ 4개 테이블 모두 open_all (On의 기존 publishable 키 read/write 패턴과 동일)
alter table public.off_dashboard_snapshots enable row level security;
alter table public.off_meeting_minutes     enable row level security;
alter table public.off_calendar_events     enable row level security;
alter table public.off_todos               enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array['off_dashboard_snapshots','off_meeting_minutes','off_calendar_events','off_todos'])
  loop
    execute format('drop policy if exists open_all on public.%I', t);
    execute format('create policy open_all on public.%I for all using (true) with check (true)', t);
  end loop;
end $$;

-- ⑥ 인증: 신규 생성 없음. On의 access_tokens + validate-token 엣지함수 그대로 재사용.
--    본인 On 비밀번호가 Off 로그인도 됨. 전체 권한 원하면 아래로 admin 확인:
--    select token, label, is_admin from public.access_tokens where token = '<내 비밀번호>';
--    update public.access_tokens set is_admin = true where token = '<내 비밀번호>';

-- ⑦ PostgREST 스키마 캐시 새로고침
notify pgrst, 'reload schema';

-- ─────────────────────────────────────────────────────────────────────
-- 검증 쿼리 (실행 후 수동 확인용)
-- select 'off_dashboard_snapshots' tbl, count(*) from public.off_dashboard_snapshots
--   union all select 'off_meeting_minutes', count(*) from public.off_meeting_minutes
--   union all select 'off_calendar_events', count(*) from public.off_calendar_events
--   union all select 'off_todos',           count(*) from public.off_todos;
-- ─────────────────────────────────────────────────────────────────────
