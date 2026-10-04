-- 預算選股台：每個帳號的資料表。到 Supabase → SQL Editor 貼上整段執行一次即可。
-- 每張表都開 RLS，規則是「只能讀寫自己的資料」，所以 anon key 放在網頁上也安全。

create table if not exists public.user_settings (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  budget     numeric not null default 100000 check (budget > 0),
  t_num      numeric not null default 1 check (t_num > 0),
  t_unit     int     not null default 365 check (t_unit in (1, 7, 30, 365)),
  risk       int     not null default 2 check (risk between 1 and 3),
  n_pick     int     not null default 0 check (n_pick between 0 and 30),
  updated_at timestamptz not null default now()
);

create table if not exists public.holdings (
  id         bigint generated always as identity primary key,
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code       text not null check (code ~ '^[0-9A-Z]{4,6}$'),
  cost       numeric not null check (cost > 0),
  qty        int not null check (qty > 0),
  note       text,
  created_at timestamptz not null default now()
);
create index if not exists holdings_user_idx on public.holdings(user_id);

create table if not exists public.watchlist (
  user_id    uuid not null default auth.uid() references auth.users(id) on delete cascade,
  code       text not null check (code ~ '^[0-9A-Z]{4,6}$'),
  created_at timestamptz not null default now(),
  primary key (user_id, code)
);

alter table public.user_settings enable row level security;
alter table public.holdings      enable row level security;
alter table public.watchlist     enable row level security;

drop policy if exists "own settings" on public.user_settings;
create policy "own settings" on public.user_settings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own holdings" on public.holdings;
create policy "own holdings" on public.holdings
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "own watchlist" on public.watchlist;
create policy "own watchlist" on public.watchlist
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
