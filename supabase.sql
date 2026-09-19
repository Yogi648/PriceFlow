-- Run once in Supabase SQL Editor if you want shared permanent storage.
create table if not exists public.backend_asins (
  asin text primary key, sku text, weight numeric, ref_fee numeric,
  brand text, restriction_type text, updated_at timestamptz default now()
);
create table if not exists public.backend_history (
  id bigint generated always as identity primary key, asin text not null,
  sku text, weight numeric, ref_fee numeric, brand text, restriction_type text,
  recorded_at timestamptz default now()
);
create table if not exists public.price_history (
  id bigint generated always as identity primary key, asin text not null,
  observed_price numeric not null, recorded_at timestamptz default now()
);

alter table public.backend_asins enable row level security;
alter table public.backend_history enable row level security;
alter table public.price_history enable row level security;
-- Add signed-in user policies here before connecting this site to Supabase.
