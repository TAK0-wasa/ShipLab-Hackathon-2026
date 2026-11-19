-- AIの利用回数の上限を「会議ごと 1日2000回・全体 1日2000回」に変えます。
-- Supabase の SQL Editor に貼り付けて、Run を1回押してください（すでにある関数を置き換えます。データは消えません）。
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
  return n_all <= 2000 and n_room <= 2000;
end;
$$;
revoke all on function public.relay_take(text) from public;
grant execute on function public.relay_take(text) to anon, authenticated;
