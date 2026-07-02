-- off_rofo_comments: Off Rofo 시트의 채널×거래처 월별 리뷰 코멘트
-- (On 프로젝트 elqammnozbfhkitnncsz SQL Editor에서 실행 — Off는 On 프로젝트로 통합됨)
-- On의 rofo_comments와 동일 모델: 공유 편집(anon), 월별 독립 코멘트.

create table if not exists public.off_rofo_comments (
  channel    text not null,
  account    text not null,
  month      int  not null,
  comment    text,
  updated_by text,
  updated_at timestamptz default now(),
  primary key (channel, account, month)
);

alter table public.off_rofo_comments enable row level security;
drop policy if exists off_rofo_cmt_all on public.off_rofo_comments;
create policy off_rofo_cmt_all on public.off_rofo_comments for all using (true) with check (true);
grant all on public.off_rofo_comments to anon, authenticated;

notify pgrst, 'reload schema';
