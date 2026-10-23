-- ════════════════════════════════════════════════════════════════════
--  Snow Incentive RSP — SPT수량 소수 허용 (1회 실행)
--  On-Trade 프로젝트(https://elqammnozbfhkitnncsz.supabase.co) SQL Editor에서 실행.
--  · 2026-10-23 RSP 업로드 실패 원인: SPT수량 0.5 → integer 칸이라 22P02 "invalid input syntax for type integer".
--  · 기존 정수 값은 그대로 유지됨.
-- ════════════════════════════════════════════════════════════════════

alter table public.snow_incentive_rsp
  alter column spt type numeric using spt::numeric;

notify pgrst, 'reload schema';
