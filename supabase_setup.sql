-- かわりに会議: 共有データベースの準備（Supabase の SQL Editor に貼り付けて1回だけ実行）
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

-- ---- AIサーバー（関数「claude」）の使いすぎ防止 ----
-- 会議ごと・全体で、1日に呼べる回数を数える。この表はアプリからは読み書きできない（下の関数だけが触る）
create table if not exists public.relay_usage (
  day date not null,
  scope text not null,
  calls int not null default 0,
  primary key (day, scope)
);
alter table public.relay_usage enable row level security;
revoke all on public.relay_usage from anon, authenticated;

-- 1回分を数えて、上限内なら true を返す（会議ごと 1日200回、全体 1日1000回）
create or replace function public.relay_take(p_room text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  d date := (now() at time zone 'Asia/Tokyo')::date;
  n_room int;
  n_all int;
begin
  if p_room is null or length(p_room) = 0 or length(p_room) > 100 then
    return false;
  end if;
  insert into relay_usage as u (day, scope, calls) values (d, 'all', 1)
    on conflict (day, scope) do update set calls = u.calls + 1
    returning calls into n_all;
  insert into relay_usage as u (day, scope, calls) values (d, 'room:' || p_room, 1)
    on conflict (day, scope) do update set calls = u.calls + 1
    returning calls into n_room;
  return n_all <= 1000 and n_room <= 200;
end;
$$;
revoke all on function public.relay_take(text) from public;
grant execute on function public.relay_take(text) to anon, authenticated;
