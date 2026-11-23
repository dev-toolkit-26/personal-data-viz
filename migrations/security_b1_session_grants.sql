-- ════════════════════════════════════════════════════════════════════
--  보안 B안 1단계: 로그인 세션 권한 (추가만 — 기존 동작에 영향 없음)
--  · 비밀번호(access_tokens)를 통과한 브라우저 세션(Supabase 익명 로그인)에만
--    데이터 접근 권한(session_grants 행)을 붙인다.
--  · 이 파일만 실행해서는 아무것도 잠기지 않는다. 잠금은 2단계(security_b2_lockdown.sql).
--  · 사전 작업: Supabase 대시보드 → Authentication → Sign In / Providers
--              → "Allow anonymous sign-ins" 켜기
--  · 롤백: 파일 맨 아래 주석의 롤백 SQL
-- ════════════════════════════════════════════════════════════════════

-- ① 세션 ↔ 비밀번호 연결 (브라우저에서 직접 읽기/쓰기 불가: RLS on + 정책 없음)
create table if not exists public.session_grants (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  token      text not null,             -- access_tokens.token (토큰 삭제·변경 시 권한 즉시 소멸)
  scope      text not null default 'both',
  is_admin   boolean not null default false,
  label      text,
  granted_at timestamptz not null default now(),
  last_seen  timestamptz not null default now()
);
alter table public.session_grants enable row level security;
revoke all on public.session_grants from anon, authenticated;

-- ② 비밀번호 대입 방지용 실패 기록 (세션당 10분에 10회 초과 실패 시 거절)
create table if not exists public.session_claim_fails (
  user_id uuid not null,
  at      timestamptz not null default now()
);
create index if not exists session_claim_fails_user_at on public.session_claim_fails (user_id, at);
alter table public.session_claim_fails enable row level security;
revoke all on public.session_claim_fails from anon, authenticated;

-- ③ 로그인 세션에 권한 부여: 비밀번호가 맞으면 현재 세션(auth.uid())에 권한 행 생성
create or replace function public.claim_session(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  t   record;
  n_fail int;
begin
  if uid is null then
    return jsonb_build_object('ok', false, 'error', 'no_session');
  end if;

  select count(*) into n_fail from public.session_claim_fails
   where user_id = uid and at > now() - interval '10 minutes';
  if n_fail >= 10 then
    return jsonb_build_object('ok', false, 'error', 'too_many_attempts');
  end if;

  select a.token, a.label, a.is_admin, a.scope into t
    from public.access_tokens a
   where a.token = p_token
   limit 1;

  if not found then
    insert into public.session_claim_fails (user_id) values (uid);
    delete from public.session_grants where user_id = uid;
    return jsonb_build_object('ok', false);
  end if;

  insert into public.session_grants (user_id, token, scope, is_admin, label)
  values (uid, t.token, coalesce(t.scope, 'both'), coalesce(t.is_admin, false), t.label)
  on conflict (user_id) do update
     set token = excluded.token, scope = excluded.scope, is_admin = excluded.is_admin,
         label = excluded.label, last_seen = now();

  delete from public.session_claim_fails where at < now() - interval '1 day';

  return jsonb_build_object('ok', true, 'scope', coalesce(t.scope, 'both'),
                            'is_admin', coalesce(t.is_admin, false), 'label', t.label);
end;
$$;
revoke all on function public.claim_session(text) from public, anon;
grant execute on function public.claim_session(text) to authenticated;

-- ④ RLS 정책에서 쓰는 판정 함수: 현재 세션이 유효한 비밀번호로 권한을 받았는가
create or replace function public.has_data_access()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
      from public.session_grants g
      join public.access_tokens  a on a.token = g.token
     where g.user_id = auth.uid()
  );
$$;
revoke all on function public.has_data_access() from public;
grant execute on function public.has_data_access() to anon, authenticated;

notify pgrst, 'reload schema';

-- ── 사전 확인 (프론트 푸시 전에 실행, 결과를 Claude에 붙여넣기) ────────
-- 로그인 세션(authenticated)으로는 안 열리는 정책이 있으면, 새 프론트를 올렸을 때
-- 2단계 전이라도 그 테이블이 막힌다. 0행이어야 안전. (테이블·정책 이름만 나옴)
-- select tablename, policyname, roles from pg_policies
--  where schemaname = 'public'
--    and not (roles && array['public','authenticated']::name[])
--  order by tablename;

-- ── 확인 (건수만) ─────────────────────────────────────────────────────
-- 프론트 배포 후 대시보드에 한 번 로그인한 뒤 실행 → n이 1 이상이면 정상
-- select count(*) as n, max(last_seen) as last from public.session_grants;

-- ── 롤백 ──────────────────────────────────────────────────────────────
-- (2단계를 이미 적용했다면 security_b2_rollback.sql 먼저 실행)
-- drop function if exists public.has_data_access();
-- drop function if exists public.claim_session(text);
-- drop table if exists public.session_claim_fails;
-- drop table if exists public.session_grants;
