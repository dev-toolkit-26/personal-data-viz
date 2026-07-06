-- ════════════════════════════════════════════════════════════════════
--  access_tokens 로그인 스코프: On만 / Off만 / 둘다
--  · scope 컬럼 추가('on'|'off'|'both'). 기존 토큰은 'both'(양쪽) 기본값 → 하위호환.
--  · validate-token 엣지함수가 응답에 scope를 실어주면(아래 참고),
--    index.html(On) / Off/index.html(Off)의 로그인 게이팅이 자동 적용됨.
-- ════════════════════════════════════════════════════════════════════

alter table public.access_tokens
  add column if not exists scope text not null default 'both';

alter table public.access_tokens drop constraint if exists access_tokens_scope_chk;
alter table public.access_tokens
  add constraint access_tokens_scope_chk check (scope in ('on','off','both'));

-- PostgREST 스키마 캐시 새로고침
notify pgrst, 'reload schema';

-- ── 토큰별 범위 지정 (명단) ──────────────────────────────────────────
-- update public.access_tokens set scope = 'off'  where token = '<Off 전용 비밀번호>';
-- update public.access_tokens set scope = 'on'   where token = '<On 전용 비밀번호>';
-- update public.access_tokens set scope = 'both' where token = '<둘 다 접근 비밀번호>';
-- 확인:
-- select token, label, is_admin, scope from public.access_tokens order by scope, label;

-- ── validate-token 엣지함수 수정 (핵심 2줄) ─────────────────────────
-- 1) SELECT에 scope 추가:   .select('label, is_admin, scope')
-- 2) 응답에 scope 추가:      { ok:true, label, is_admin, scope: data.scope || 'both' }
-- (scope 미반환이어도 프론트는 'both'로 간주 → 잠기지 않음. 반환해야 실제 제한 적용.)
