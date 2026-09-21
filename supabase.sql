-- PriceFlow shared backend storage
-- Run this ONCE in Supabase SQL Editor.
-- This site is public/no-login, so these policies allow the browser anon key
-- to read and write PriceFlow backend data. Do NOT use a service_role key in the browser.

create table if not exists public.backend_asins (asin text primary key, sku text, weight numeric, ref_fee numeric, brand text, restriction_type text, updated_at timestamptz default now());
create table if not exists public.backend_history (id bigint generated always as identity primary key, asin text not null, sku text, weight numeric, ref_fee numeric, brand text, restriction_type text, recorded_at timestamptz default now());
create table if not exists public.price_history (id bigint generated always as identity primary key, asin text not null, observed_price numeric not null, recorded_at timestamptz default now());

alter table public.backend_asins enable row level security;
alter table public.backend_history enable row level security;
alter table public.price_history enable row level security;

drop policy if exists "PriceFlow public read backend" on public.backend_asins;
drop policy if exists "PriceFlow public insert backend" on public.backend_asins;
drop policy if exists "PriceFlow public update backend" on public.backend_asins;
drop policy if exists "PriceFlow public delete backend" on public.backend_asins;
create policy "PriceFlow public read backend" on public.backend_asins for select to anon, authenticated using (true);
create policy "PriceFlow public insert backend" on public.backend_asins for insert to anon, authenticated with check (true);
create policy "PriceFlow public update backend" on public.backend_asins for update to anon, authenticated using (true) with check (true);
create policy "PriceFlow public delete backend" on public.backend_asins for delete to anon, authenticated using (true);

drop policy if exists "PriceFlow public read backend history" on public.backend_history;
drop policy if exists "PriceFlow public insert backend history" on public.backend_history;
create policy "PriceFlow public read backend history" on public.backend_history for select to anon, authenticated using (true);
create policy "PriceFlow public insert backend history" on public.backend_history for insert to anon, authenticated with check (true);

drop policy if exists "PriceFlow public read price history" on public.price_history;
drop policy if exists "PriceFlow public insert price history" on public.price_history;
create policy "PriceFlow public read price history" on public.price_history for select to anon, authenticated using (true);
create policy "PriceFlow public insert price history" on public.price_history for insert to anon, authenticated with check (true);
