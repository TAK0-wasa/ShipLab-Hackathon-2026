-- AI代理人会議: 共有データベースの準備（Supabase の SQL Editor に貼り付けて1回だけ実行）
create table if not exists public.docs (
  room text not null,
  kind text not null,
  id text not null,
  data jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (room, kind, id)
);

alter table public.docs enable row level security;

drop policy if exists "docs_open" on public.docs;
create policy "docs_open" on public.docs
  for all to anon, authenticated
  using (true) with check (true);

grant select, insert, update, delete on public.docs to anon, authenticated;
