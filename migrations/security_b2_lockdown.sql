-- ════════════════════════════════════════════════════════════════════
--  보안 B안 2단계: 잠금 — 공개(anon) 키만으로는 데이터 테이블을 읽기·쓰기 못하게
--  · 전제: 1단계(security_b1_session_grants.sql) 적용 + 익명 로그인 켜짐
--          + 새 프론트(data_session.js) 배포 + session_grants 건수 1 이상 확인
--  · public 스키마의 모든 테이블에서 기존 정책을 백업 후 삭제하고,
--    "비밀번호로 권한 받은 세션만 전체 허용" 정책 하나로 바꾼다.
--  · 제외: access_tokens(이미 잠겨 있음), session_grants, session_claim_fails, 백업 테이블
--  · 엣지함수(service_role)는 RLS를 무시하므로 deploy-snapshot·save-minutes 등은 영향 없음.
--  · 롤백: security_b2_rollback.sql (이 파일이 만든 백업으로 원래 정책·RLS 상태 복원)
-- ════════════════════════════════════════════════════════════════════

begin;

-- ① 백업 (두 번 실행해도 첫 백업을 덮어쓰지 않음)
create table if not exists public._sec_bak_rls (
  tablename   text primary key,
  rowsecurity boolean not null,
  backed_up_at timestamptz not null default now()
);
create table if not exists public._sec_bak_policies (
  tablename  text not null,
  policyname text not null,
  permissive text,
  roles      name[],
  cmd        text,
  qual       text,
  with_check text,
  backed_up_at timestamptz not null default now(),
  primary key (tablename, policyname)
);
alter table public._sec_bak_rls      enable row level security;
alter table public._sec_bak_policies enable row level security;
revoke all on public._sec_bak_rls, public._sec_bak_policies from anon, authenticated;

insert into public._sec_bak_rls (tablename, rowsecurity)
select t.tablename, t.rowsecurity
  from pg_tables t
 where t.schemaname = 'public'
   and t.tablename not in ('access_tokens', 'session_grants', 'session_claim_fails')
   and t.tablename not like '\_sec\_bak\_%'
on conflict (tablename) do nothing;

insert into public._sec_bak_policies (tablename, policyname, permissive, roles, cmd, qual, with_check)
select p.tablename, p.policyname, p.permissive, p.roles, p.cmd, p.qual, p.with_check
  from pg_policies p
  join public._sec_bak_rls b on b.tablename = p.tablename
 where p.schemaname = 'public'
   and p.policyname <> 'granted_all'
on conflict (tablename, policyname) do nothing;

-- ② 잠금: 기존 정책 삭제 → RLS 켜기 → 권한 받은 세션 전용 정책
do $$
declare
  r record;
  p record;
begin
  for r in select tablename from public._sec_bak_rls loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = r.tablename) then
      continue;
    end if;
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = r.tablename loop
      execute format('drop policy %I on public.%I', p.policyname, r.tablename);
    end loop;
    execute format('alter table public.%I enable row level security', r.tablename);
    execute format(
      'create policy granted_all on public.%I for all to authenticated '
      'using ((select public.has_data_access())) with check ((select public.has_data_access()))',
      r.tablename);
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';

-- ── 확인 ──────────────────────────────────────────────────────────────
-- 1) RLS 꺼진 public 테이블이 없어야 함 (0행)
-- select tablename from pg_tables where schemaname = 'public' and not rowsecurity;
-- 2) anon/public 대상 정책이 남아 있지 않아야 함 (access_tokens 제외, 0행)
-- select tablename, policyname, roles from pg_policies
--  where schemaname = 'public' and tablename <> 'access_tokens'
--    and (roles && array['anon','public']::name[]);
