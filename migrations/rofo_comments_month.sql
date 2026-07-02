-- rofo_comments: 월별 코멘트로 확장 (On 프로젝트 elqammnozbfhkitnncsz SQL Editor에서 실행)
--
-- 기존: PK (region, sku) — 모든 월이 하나의 코멘트를 공유(6월 코멘트가 7월에도 딸려옴).
-- 변경: month 컬럼 추가 + PK (region, sku, month) — 월마다 독립 코멘트.
--       기존 행은 6월분으로 백필(default 6) → 6월 코멘트 보존, 7월 이후는 빈칸에서 시작.

alter table public.rofo_comments add column if not exists month int not null default 6;

alter table public.rofo_comments drop constraint if exists rofo_comments_pkey;
alter table public.rofo_comments add constraint rofo_comments_pkey primary key (region, sku, month);

notify pgrst, 'reload schema';
