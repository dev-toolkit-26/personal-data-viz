-- rofo_comments: Rofo 탭의 지점×SKU 리뷰 코멘트 (공유 편집)
--
-- Context: 이 앱은 단일 Supabase anon key를 모든 사용자가 공유하고, 신원은
-- 클라이언트(sessionStorage.auth_label)로만 추적한다. auth.uid()가 없으므로
-- RLS는 todos / calendar_events와 동일하게 "공개(using true)"로 둔다.
--
-- 이전엔 코멘트를 deploy-snapshot(=관리자 전용 엣지함수)으로 저장해 비관리자
-- 직원은 저장이 실패했다. 이 테이블 + 클라이언트 직접 upsert로 모든 직원이 저장 가능.
--
-- (region, sku) 당 1개의 공유 코멘트. region 키는 대시보드 sku_detail 키
-- (Seoul, BuSan, DaeGu&JeJu, DaeJeon, GwangJu).

create table if not exists public.rofo_comments (
  region     text not null,
  sku        text not null,
  comment    text,
  updated_by text,
  updated_at timestamptz default now(),
  primary key (region, sku)
);

alter table public.rofo_comments enable row level security;

drop policy if exists "rofo_comments_select_all" on public.rofo_comments;
drop policy if exists "rofo_comments_insert_all" on public.rofo_comments;
drop policy if exists "rofo_comments_update_all" on public.rofo_comments;
drop policy if exists "rofo_comments_delete_all" on public.rofo_comments;

create policy "rofo_comments_select_all" on public.rofo_comments for select using (true);
create policy "rofo_comments_insert_all" on public.rofo_comments for insert with check (true);
create policy "rofo_comments_update_all" on public.rofo_comments for update using (true) with check (true);
create policy "rofo_comments_delete_all" on public.rofo_comments for delete using (true);

grant all on public.rofo_comments to anon, authenticated;

notify pgrst, 'reload schema';
