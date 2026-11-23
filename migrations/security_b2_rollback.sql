-- ════════════════════════════════════════════════════════════════════
--  보안 B안 2단계 롤백 — security_b2_lockdown.sql 이전 상태로 복원
--  · granted_all 정책 삭제 → 백업해 둔 원래 정책 재생성 → 원래 RLS 켜짐/꺼짐 복원
--  · 1단계(session_grants·claim_session)는 그대로 둠 (지워도 되면 1단계 파일의 롤백 실행)
--  · 프론트(data_session.js)는 되돌리지 않아도 됨: 권한 실패 시 공개 키로 동작하도록 만들어져 있음
-- ════════════════════════════════════════════════════════════════════

begin;

do $$
declare
  r record;
  sql text;
begin
  -- ① 잠금 정책 제거 + RLS 원상태
  for r in select tablename, rowsecurity from public._sec_bak_rls loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = r.tablename) then
      continue;
    end if;
    execute format('drop policy if exists granted_all on public.%I', r.tablename);
    execute format('alter table public.%I %s row level security', r.tablename,
                   case when r.rowsecurity then 'enable' else 'disable' end);
  end loop;

  -- ② 원래 정책 재생성
  for r in select * from public._sec_bak_policies loop
    if not exists (select 1 from pg_tables where schemaname = 'public' and tablename = r.tablename) then
      continue;
    end if;
    sql := format('create policy %I on public.%I as %s for %s to %s',
                  r.policyname, r.tablename, r.permissive, r.cmd,
                  (select string_agg(case when x = 'public' then 'public' else quote_ident(x) end, ', ')
                     from unnest(r.roles::text[]) as x));
    if r.qual is not null then sql := sql || ' using (' || r.qual || ')'; end if;
    if r.with_check is not null then sql := sql || ' with check (' || r.with_check || ')'; end if;
    execute format('drop policy if exists %I on public.%I', r.policyname, r.tablename);
    execute sql;
  end loop;
end $$;

commit;

notify pgrst, 'reload schema';

-- 백업 테이블은 남겨 둠. 복원이 확인되면 지워도 됨:
-- drop table public._sec_bak_policies; drop table public._sec_bak_rls;
