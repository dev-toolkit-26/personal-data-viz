-- Off-Trade 대시보드 스냅샷 테이블
-- On-Trade의 dashboard_snapshots(id=1, data jsonb) 패턴을 그대로 미러링한다.
-- off_trade.html 이 id=1 행의 data(채널▸거래처▸SKU 트리)를 통째로 읽고 upsert 한다.

create table if not exists public.off_dashboard_snapshots (
  id          int primary key,
  data        jsonb        not null default '{}'::jsonb,
  updated_at  timestamptz  not null default now()
);

-- 단일 정규 행(id=1) 보장
insert into public.off_dashboard_snapshots (id, data)
values (1, '{}'::jsonb)
on conflict (id) do nothing;

alter table public.off_dashboard_snapshots enable row level security;

-- 공개 읽기 (publishable 키로 조회)
drop policy if exists off_snap_read on public.off_dashboard_snapshots;
create policy off_snap_read
  on public.off_dashboard_snapshots
  for select using (true);

-- 공개 쓰기 — On-Trade 대시보드와 동일하게 일단 열어둠.
-- TODO(보안): access_tokens 기반으로 조이기. 비밀번호는 repo가 아니라 Supabase access_tokens 테이블에 있음. (auth_architecture 참고)
drop policy if exists off_snap_write on public.off_dashboard_snapshots;
create policy off_snap_write
  on public.off_dashboard_snapshots
  for all using (true) with check (true);
