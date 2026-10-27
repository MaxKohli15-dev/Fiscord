-- =====================================================================
-- Fiscord – Datenbankschema für Supabase
-- Im Supabase-Dashboard: SQL Editor → New query → einfügen → Run
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------
-- Tabellen
-- ---------------------------------------------------------------------

create table if not exists public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  username   text not null check (char_length(username) between 3 and 32),
  created_at timestamptz not null default now()
);
create unique index if not exists profiles_username_lower on public.profiles (lower(username));

create table if not exists public.servers (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(name) between 1 and 100),
  owner_id    uuid not null references public.profiles(id) on delete cascade,
  invite_code text not null unique default substr(md5(random()::text || clock_timestamp()::text), 1, 8),
  created_at  timestamptz not null default now()
);

create table if not exists public.server_members (
  server_id uuid not null references public.servers(id) on delete cascade,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  joined_at timestamptz not null default now(),
  primary key (server_id, user_id)
);

create table if not exists public.channels (
  id         uuid primary key default gen_random_uuid(),
  server_id  uuid not null references public.servers(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 50),
  created_at timestamptz not null default now()
);

create table if not exists public.messages (
  id         bigint generated always as identity primary key,
  channel_id uuid not null references public.channels(id) on delete cascade,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  content    text not null check (char_length(content) between 1 and 2000),
  created_at timestamptz not null default now()
);
create index if not exists messages_channel_created on public.messages (channel_id, created_at);

-- ---------------------------------------------------------------------
-- Hilfsfunktionen (SECURITY DEFINER, damit RLS sich nicht selbst blockiert)
-- ---------------------------------------------------------------------

create or replace function public.is_member(sid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.server_members
    where server_id = sid and user_id = auth.uid()
  );
$$;

create or replace function public.channel_server(cid uuid)
returns uuid
language sql
security definer
stable
set search_path = public
as $$
  select server_id from public.channels where id = cid;
$$;

create or replace function public.is_owner(sid uuid)
returns boolean
language sql
security definer
stable
set search_path = public
as $$
  select exists (
    select 1 from public.servers
    where id = sid and owner_id = auth.uid()
  );
$$;

-- Prüft vor der Registrierung, ob ein Benutzername frei ist (auch für anonyme Nutzer aufrufbar)
create or replace function public.username_available(name text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select not exists (select 1 from public.profiles where lower(username) = lower(name));
$$;

-- ---------------------------------------------------------------------
-- Profil automatisch anlegen, sobald sich jemand registriert
-- (Benutzername kommt aus den Registrierungs-Metadaten)
-- ---------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, username)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'username', 'user_' || substr(new.id::text, 1, 8))
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------
-- RPC-Funktionen
-- ---------------------------------------------------------------------

-- Server erstellen: legt Server, Mitgliedschaft und Kanal "allgemein" an
create or replace function public.create_server(server_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  new_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  insert into public.servers (name, owner_id)
  values (server_name, auth.uid())
  returning id into new_id;

  insert into public.server_members (server_id, user_id)
  values (new_id, auth.uid());

  insert into public.channels (server_id, name)
  values (new_id, 'allgemein');

  return new_id;
end;
$$;

-- Server über Einladungscode betreten
create or replace function public.join_server(code text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  sid uuid;
begin
  if auth.uid() is null then
    raise exception 'Nicht angemeldet';
  end if;

  select id into sid from public.servers where invite_code = lower(trim(code));
  if sid is null then
    raise exception 'Einladungscode ungültig';
  end if;

  insert into public.server_members (server_id, user_id)
  values (sid, auth.uid())
  on conflict do nothing;

  return sid;
end;
$$;

revoke execute on function public.create_server(text) from anon;
revoke execute on function public.join_server(text) from anon;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------

alter table public.profiles       enable row level security;
alter table public.servers        enable row level security;
alter table public.server_members enable row level security;
alter table public.channels       enable row level security;
alter table public.messages       enable row level security;

-- profiles: alle angemeldeten Nutzer sehen Namen, nur man selbst ändert sein Profil
create policy "profiles_select" on public.profiles
  for select to authenticated using (true);
create policy "profiles_update_own" on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- servers: nur Mitglieder sehen den Server, nur der Owner ändert/löscht ihn
create policy "servers_select_members" on public.servers
  for select to authenticated using (public.is_member(id));
create policy "servers_update_owner" on public.servers
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());
create policy "servers_delete_owner" on public.servers
  for delete to authenticated using (owner_id = auth.uid());

-- server_members: Mitglieder sehen Mitglieder; man kann nur sich selbst entfernen (Owner nicht)
create policy "members_select" on public.server_members
  for select to authenticated using (public.is_member(server_id));
create policy "members_leave_self" on public.server_members
  for delete to authenticated using (
    user_id = auth.uid() and not public.is_owner(server_id)
  );

-- channels: Mitglieder lesen, nur Owner erstellt/löscht
create policy "channels_select" on public.channels
  for select to authenticated using (public.is_member(server_id));
create policy "channels_insert_owner" on public.channels
  for insert to authenticated with check (public.is_owner(server_id));
create policy "channels_delete_owner" on public.channels
  for delete to authenticated using (public.is_owner(server_id));

-- messages: Mitglieder lesen und schreiben, man kann nur als sich selbst posten
create policy "messages_select" on public.messages
  for select to authenticated using (public.is_member(public.channel_server(channel_id)));
create policy "messages_insert" on public.messages
  for insert to authenticated with check (
    user_id = auth.uid() and public.is_member(public.channel_server(channel_id))
  );

-- ---------------------------------------------------------------------
-- Realtime: neue Nachrichten live an die Clients schicken
-- ---------------------------------------------------------------------

alter publication supabase_realtime add table public.messages;
