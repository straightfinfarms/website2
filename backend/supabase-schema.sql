-- ============================================================================
-- Balance Nature Property Fund — Supabase schema
-- ----------------------------------------------------------------------------
-- Run this once in your Supabase project: SQL Editor -> New query -> paste ->
-- Run. It creates the tables, row-level security (RLS) policies, and the
-- signup trigger that powers logins, shared property data, connections, and
-- crowdfunding deals/commitments.
--
-- Security model:
--   * Every table has RLS ON. Nothing is readable without an authenticated
--     session that satisfies a policy.
--   * properties are shared by MEMBERSHIP: a user sees a property only if they
--     created it or their user id is in member_ids. This is how co-investors
--     get transparent, view-only access to the same live property.
--   * connections are strictly per-user.
--   * deals are publicly readable (a crowdfunding raise is meant to be shared);
--     only the creator can write them.
--   * commitments are readable by the investor who made them and by the deal
--     owner.
-- ============================================================================

-- ---- profiles -------------------------------------------------------------
create table if not exists public.profiles (
  id         uuid primary key references auth.users on delete cascade,
  email      text,
  full_name  text,
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;

drop policy if exists "profiles_self_select" on public.profiles;
create policy "profiles_self_select" on public.profiles
  for select using (auth.uid() = id);

drop policy if exists "profiles_self_upsert" on public.profiles;
create policy "profiles_self_upsert" on public.profiles
  for insert with check (auth.uid() = id);

drop policy if exists "profiles_self_update" on public.profiles;
create policy "profiles_self_update" on public.profiles
  for update using (auth.uid() = id) with check (auth.uid() = id);

-- create a profile row automatically on signup
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''))
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---- properties (shared by membership) ------------------------------------
create table if not exists public.properties (
  id         text primary key,
  created_by uuid not null default auth.uid() references auth.users on delete cascade,
  member_ids uuid[] not null default array[auth.uid()],
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.properties enable row level security;

drop policy if exists "properties_select_member" on public.properties;
create policy "properties_select_member" on public.properties
  for select using (auth.uid() = created_by or auth.uid() = any(member_ids));

drop policy if exists "properties_insert_owner" on public.properties;
create policy "properties_insert_owner" on public.properties
  for insert with check (auth.uid() = created_by);

drop policy if exists "properties_update_owner" on public.properties;
create policy "properties_update_owner" on public.properties
  for update using (auth.uid() = created_by) with check (auth.uid() = created_by);

drop policy if exists "properties_delete_owner" on public.properties;
create policy "properties_delete_owner" on public.properties
  for delete using (auth.uid() = created_by);

-- ---- connections (per user) -----------------------------------------------
create table if not exists public.connections (
  id         text not null,
  user_id    uuid not null default auth.uid() references auth.users on delete cascade,
  data       jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);
alter table public.connections enable row level security;

drop policy if exists "connections_owner_all" on public.connections;
create policy "connections_owner_all" on public.connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- ---- deals (crowdfunding — public read, owner write) ----------------------
create table if not exists public.deals (
  id         text primary key,
  created_by uuid default auth.uid(),
  is_public  boolean not null default true,
  data       jsonb not null,
  updated_at timestamptz not null default now()
);
alter table public.deals enable row level security;

drop policy if exists "deals_select_public" on public.deals;
create policy "deals_select_public" on public.deals
  for select using (is_public or auth.uid() = created_by);

drop policy if exists "deals_insert_owner" on public.deals;
create policy "deals_insert_owner" on public.deals
  for insert with check (auth.uid() = created_by);

drop policy if exists "deals_update_owner" on public.deals;
create policy "deals_update_owner" on public.deals
  for update using (auth.uid() = created_by) with check (auth.uid() = created_by);

-- ---- commitments ----------------------------------------------------------
create table if not exists public.commitments (
  id         uuid primary key default gen_random_uuid(),
  deal_id    text references public.deals(id) on delete cascade,
  user_id    uuid default auth.uid(),
  data       jsonb not null,
  created_at timestamptz not null default now()
);
alter table public.commitments enable row level security;

-- any authenticated user can pledge
drop policy if exists "commitments_insert_auth" on public.commitments;
create policy "commitments_insert_auth" on public.commitments
  for insert with check (auth.uid() is not null);

-- a user sees their own commitments; a deal owner sees commitments on their deal
drop policy if exists "commitments_select_own_or_dealowner" on public.commitments;
create policy "commitments_select_own_or_dealowner" on public.commitments
  for select using (
    auth.uid() = user_id
    or auth.uid() in (select d.created_by from public.deals d where d.id = deal_id)
  );

-- ---- helper: add a co-investor to a property by email ----------------------
-- Lets a property owner grant a registered user (co-investor) read access.
-- Usage from the app: select public.add_property_member('p-xxx','partner@email.com');
create or replace function public.add_property_member(p_id text, p_email text)
returns void
language plpgsql
security definer set search_path = public
as $$
declare
  v_uid uuid;
begin
  select id into v_uid from public.profiles where lower(email) = lower(p_email) limit 1;
  if v_uid is null then
    raise exception 'No registered user with that email yet';
  end if;
  update public.properties
     set member_ids = (select array(select distinct unnest(member_ids || v_uid)))
   where id = p_id and created_by = auth.uid();
  if not found then
    raise exception 'Property not found or you are not its owner';
  end if;
end;
$$;

-- ============================================================================
-- Done. Enable Email auth under Authentication -> Providers (it is on by
-- default). For a smooth demo you may also turn OFF "Confirm email" under
-- Authentication -> Providers -> Email so test logins work immediately.
-- ============================================================================
