-- =====================================================================
-- Fiscord – Migration 2: Bearbeiten, Löschen, Mitglieder verwalten
-- Nach schema.sql ausführen: SQL Editor → New query → einfügen → Run
-- =====================================================================

-- Bearbeitungszeitpunkt speichern
alter table public.messages add column if not exists edited_at timestamptz;

-- Bei Löschungen muss Realtime auch die channel_id mitschicken
alter table public.messages replica identity full;

-- Eigene Nachrichten bearbeiten (nur im eigenen Kanal, in dem man Mitglied ist)
create policy "messages_update_own" on public.messages
  for update to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid() and public.is_member(public.channel_server(channel_id))
  );

-- Eigene Nachrichten löschen
create policy "messages_delete_own" on public.messages
  for delete to authenticated
  using (user_id = auth.uid());

-- Owner kann andere Mitglieder entfernen
create policy "members_kick_by_owner" on public.server_members
  for delete to authenticated
  using (public.is_owner(server_id) and user_id <> auth.uid());
