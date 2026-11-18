-- MeetForMe: 会議をサーバーで進めるための追加設定（任意。関数「meeting」を入れたあとで、SQL Editor で1回だけ実行）
-- これを入れると、だれの画面も開いていなくても、1分ごとの見回りで「預ける締切」を過ぎた会議が始まる。
-- 入れなくても、だれかが画面を開いていれば会議は進む。

-- 関数「meeting」の見回りは、サーバーの鍵で回数を数えるので、その権限を足す
grant execute on function public.relay_take(text) to service_role;

-- 1分ごとの見回り。下の2か所を、自分のプロジェクトのものに書き換えてから実行する。
--   <PROJECT_URL>       例: https://xxxx.supabase.co
--   <SERVICE_ROLE_KEY>  Project Settings → API の service_role の鍵（公開しないこと。このファイルに書いたままコミットしない）
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.unschedule('rusuban-meeting-tick') where exists (select 1 from cron.job where jobname = 'rusuban-meeting-tick');
select cron.schedule(
  'rusuban-meeting-tick',
  '* * * * *',
  $$ select net.http_post(
       url := '<PROJECT_URL>/functions/v1/meeting',
       headers := jsonb_build_object('content-type', 'application/json', 'authorization', 'Bearer <SERVICE_ROLE_KEY>'),
       body := '{"tick":true}'::jsonb
     ) $$
);
-- 止めるとき: select cron.unschedule('rusuban-meeting-tick');
