const cfg = window.FISCORD_CONFIG;
if (!cfg || cfg.SUPABASE_URL.includes('DEIN-')) {
  document.body.textContent = 'Bitte trage zuerst deine Supabase-URL und den Key in config.js ein.';
  throw new Error('config.js nicht ausgefüllt');
}

const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);
const PAGE_SIZE = 50;

const state = {
  user: null,
  servers: [],
  server: null,       // aktiver Server
  channels: [],
  channel: null,      // aktiver Kanal
  names: new Map(),   // user_id -> Benutzername
  oldestAt: null,     // Zeitstempel der ältesten geladenen Nachricht
  sub: null,          // Realtime-Abo für den aktiven Kanal
  membersOpen: false,
  recovery: false,    // true, während ein neues Passwort gesetzt wird
};

// ---------------------------------------------------------------------
// Anmeldung, Registrierung, Passwort zurücksetzen
// ---------------------------------------------------------------------

// Zurück-Link aus Bestätigungs- und Reset-Mails (muss in Supabase als Redirect-URL erlaubt sein)
const redirectTo = location.origin + location.pathname;

function setAuthMsg(text, type = 'error') {
  const el = $('auth-msg');
  el.textContent = text;
  el.className = `msg-box ${type}`;
  el.hidden = false;
}

function showScreen(isAuth) {
  $('auth').hidden = !isAuth;
  $('app').hidden = isAuth;
}

// name: 'login' | 'register' | 'forgot' | 'update'
function showAuthForm(name) {
  ['login', 'register', 'forgot', 'update'].forEach((n) => {
    $(`${n}-form`).hidden = n !== name;
  });
  const withTabs = name === 'login' || name === 'register';
  $('tabs').hidden = !withTabs;
  if (withTabs) {
    $('tab-login').classList.toggle('active', name === 'login');
    $('tab-register').classList.toggle('active', name === 'register');
  }
  $('auth-msg').hidden = true;
}

$('tab-login').onclick = () => showAuthForm('login');
$('tab-register').onclick = () => showAuthForm('register');
$('forgot-link').onclick = () => showAuthForm('forgot');
$('back-to-login').onclick = () => showAuthForm('login');

$('register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = $('reg-username').value.trim();
  const email = $('reg-email').value.trim();
  const password = $('reg-password').value;

  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) {
    return setAuthMsg('Benutzername: 3–32 Zeichen, nur Buchstaben, Zahlen, _ . und -.');
  }
  if (password.length < 8) {
    return setAuthMsg('Das Passwort muss mindestens 8 Zeichen lang sein.');
  }

  const { data: free, error: checkError } = await db.rpc('username_available', { name: username });
  if (checkError) return setAuthMsg(checkError.message);
  if (!free) return setAuthMsg('Dieser Benutzername ist schon vergeben.');

  const { error } = await db.auth.signUp({
    email,
    password,
    options: { data: { username }, emailRedirectTo: redirectTo },
  });
  if (error) return setAuthMsg(error.message);

  e.target.reset();
  setAuthMsg(
    `Fast geschafft! Wir haben eine Bestätigungs-E-Mail an ${email} geschickt. ` +
    'Klicke auf den Link darin, dann bist du angemeldet. (Auch der Spam-Ordner lohnt einen Blick.)',
    'ok'
  );
});

$('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const { error } = await db.auth.signInWithPassword({
    email: $('login-email').value.trim(),
    password: $('login-password').value,
  });
  if (error) {
    const unconfirmed = /not confirmed/i.test(error.message);
    setAuthMsg(
      unconfirmed
        ? 'Bitte bestätige zuerst deine E-Mail-Adresse. Schau auch im Spam-Ordner nach.'
        : 'E-Mail oder Passwort ist falsch.'
    );
  }
});

$('forgot-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('forgot-email').value.trim();
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) return setAuthMsg(error.message);

  e.target.reset();
  setAuthMsg('Wenn die Adresse registriert ist, haben wir dir einen Link zum Zurücksetzen geschickt.', 'ok');
});

$('update-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = $('new-password').value;
  if (password.length < 8) return setAuthMsg('Das Passwort muss mindestens 8 Zeichen lang sein.');

  const { error } = await db.auth.updateUser({ password });
  if (error) return setAuthMsg(error.message);

  state.recovery = false;
  e.target.reset();
  const { data } = await db.auth.getSession();
  if (data.session) enterApp(data.session.user);
});

$('btn-logout').onclick = () => db.auth.signOut();

// ---------------------------------------------------------------------
// Sitzung
// ---------------------------------------------------------------------

function leaveApp() {
  state.user = null;
  state.servers = [];
  state.server = null;
  state.channels = [];
  state.names.clear();
  state.membersOpen = false;
  clearChat();
  showScreen(true);
}

async function enterApp(user) {
  if (state.user?.id === user.id) return;
  state.user = user;

  const { data: profile } = await db
    .from('profiles')
    .select('username')
    .eq('id', user.id)
    .maybeSingle();
  const username = profile?.username ?? user.user_metadata?.username ?? 'Unbekannt';
  state.names.set(user.id, username);
  $('me-name').textContent = username;

  showScreen(false);
  await loadServers();
}

// ---------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------

async function loadServers(preferId) {
  const { data, error } = await db
    .from('server_members')
    .select('servers(id, name, owner_id, invite_code)')
    .eq('user_id', state.user.id);
  if (error) return alert(`Server konnten nicht geladen werden: ${error.message}`);

  state.servers = data.map((row) => row.servers).filter(Boolean);
  renderServers();

  const target = state.servers.find((s) => s.id === preferId) ?? state.servers[0];
  if (target) return selectServer(target.id);

  state.server = null;
  state.channels = [];
  renderChannels();
  $('server-name').textContent = 'Kein Server';
  clearChat();
  $('channel-title').textContent = 'Erstelle einen Server oder tritt einem bei (+)';
}

function renderServers() {
  $('server-list').replaceChildren(
    ...state.servers.map((s) => {
      const btn = document.createElement('button');
      btn.className = 'server-btn' + (state.server?.id === s.id ? ' active' : '');
      btn.type = 'button';
      btn.title = s.name;
      btn.textContent = s.name.slice(0, 2).toUpperCase();
      btn.onclick = () => selectServer(s.id);
      return btn;
    })
  );
}

function isOwner() {
  return !!state.server && state.server.owner_id === state.user?.id;
}

// Zeigt/versteckt die Buttons im Kopfbereich passend zum Zustand
function updateHeadButtons() {
  $('btn-add-channel').hidden = !isOwner();
  $('btn-server-menu').hidden = !state.server;
  $('btn-members').hidden = !state.server;
  $('btn-delete-channel').hidden = !(isOwner() && state.channel);
  $('members').hidden = !(state.server && state.membersOpen);
}

async function selectServer(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) return;

  state.server = server;
  renderServers();
  $('server-name').textContent = server.name;
  updateHeadButtons();
  if (state.membersOpen) loadMembers();

  const channels = await loadChannels();
  if (state.server?.id !== id) return; // inzwischen anderen Server gewählt

  if (channels.length) selectChannel(channels[0].id);
  else clearChat();
}

async function loadChannels() {
  const serverId = state.server.id;
  const { data, error } = await db
    .from('channels')
    .select('id, name')
    .eq('server_id', serverId)
    .order('created_at');
  if (error) {
    alert(`Kanäle konnten nicht geladen werden: ${error.message}`);
    return [];
  }
  if (state.server?.id !== serverId) return [];

  state.channels = data;
  renderChannels();
  return data;
}

function renderChannels() {
  $('channel-list').replaceChildren(
    ...state.channels.map((c) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.className = 'channel-btn' + (state.channel?.id === c.id ? ' active' : '');
      btn.type = 'button';
      btn.textContent = `# ${c.name}`;
      btn.onclick = () => selectChannel(c.id);
      li.append(btn);
      return li;
    })
  );
}

// Serverinfo: Einladungscode, Verlassen bzw. Löschen
$('btn-server-menu').onclick = () => {
  const s = state.server;
  if (!s) return;
  $('info-title').textContent = s.name;
  $('info-code').textContent = s.invite_code;
  $('btn-leave-server').hidden = isOwner();
  $('btn-delete-server').hidden = !isOwner();
  openDialog('sec-server-info');
};

$('btn-copy-code').onclick = async () => {
  const code = state.server.invite_code;
  try {
    await navigator.clipboard.writeText(code);
    alert(`Einladungscode kopiert: ${code}`);
  } catch {
    alert(`Einladungscode: ${code}`);
  }
};

$('btn-leave-server').onclick = async () => {
  const s = state.server;
  if (!confirm(`Server „${s.name}“ wirklich verlassen?`)) return;
  const { error } = await db
    .from('server_members')
    .delete()
    .eq('server_id', s.id)
    .eq('user_id', state.user.id);
  if (error) return dlgError(error.message);

  dlg.close();
  await loadServers();
};

$('btn-delete-server').onclick = async () => {
  const s = state.server;
  if (!confirm(`Server „${s.name}“ wirklich löschen? Alle Kanäle und Nachrichten gehen verloren.`)) return;
  const { error } = await db.from('servers').delete().eq('id', s.id);
  if (error) return dlgError(error.message);

  dlg.close();
  await loadServers();
};

// ---------------------------------------------------------------------
// Mitglieder
// ---------------------------------------------------------------------

$('btn-members').onclick = () => {
  state.membersOpen = !state.membersOpen;
  updateHeadButtons();
  if (state.membersOpen) loadMembers();
};

async function loadMembers() {
  const serverId = state.server?.id;
  if (!serverId) return;

  const { data, error } = await db
    .from('server_members')
    .select('user_id, profiles(username)')
    .eq('server_id', serverId);
  if (error) return alert(`Mitglieder konnten nicht geladen werden: ${error.message}`);
  if (state.server?.id !== serverId) return;

  data.forEach((m) => {
    if (m.profiles) state.names.set(m.user_id, m.profiles.username);
  });

  $('member-list').replaceChildren(
    ...data.map((m) => {
      const li = document.createElement('li');
      li.className = 'member';

      const name = document.createElement('span');
      name.textContent = m.profiles?.username ?? 'Unbekannt';
      li.append(name);

      if (m.user_id === state.server.owner_id) {
        const badge = document.createElement('small');
        badge.className = 'badge';
        badge.textContent = 'Owner';
        li.append(badge);
      } else if (isOwner()) {
        const kick = document.createElement('button');
        kick.type = 'button';
        kick.className = 'link-btn danger-text';
        kick.textContent = 'Entfernen';
        kick.onclick = () => kickMember(m.user_id, name.textContent);
        li.append(kick);
      }
      return li;
    })
  );
}

async function kickMember(userId, name) {
  if (!confirm(`${name} wirklich aus dem Server entfernen?`)) return;
  const { error } = await db
    .from('server_members')
    .delete()
    .eq('server_id', state.server.id)
    .eq('user_id', userId);
  if (error) return alert(error.message);
  loadMembers();
}

// ---------------------------------------------------------------------
// Kanäle
// ---------------------------------------------------------------------

async function selectChannel(id) {
  const channel = state.channels.find((c) => c.id === id);
  if (!channel) return;

  state.channel = channel;
  state.oldestAt = null;
  renderChannels();
  $('channel-title').textContent = `# ${channel.name}`;
  $('msg-input').disabled = false;
  $('msg-input').placeholder = `Nachricht an #${channel.name}`;
  $('messages').replaceChildren(olderButton(false));
  updateHeadButtons();

  const { data, error } = await fetchMessages(id);
  if (error) return alert(`Nachrichten konnten nicht geladen werden: ${error.message}`);
  if (state.channel?.id !== id) return;

  await ensureNames(data.map((m) => m.user_id));
  if (state.channel?.id !== id) return;

  data.reverse(); // chronologisch: ältestes zuerst
  $('load-older').hidden = data.length < PAGE_SIZE;
  state.oldestAt = data[0]?.created_at ?? null;
  $('messages').append(...data.map(buildMessage));
  scrollToBottom();

  subscribe(id);
}

async function deleteChannel() {
  const ch = state.channel;
  if (!ch) return;
  if (!confirm(`Kanal #${ch.name} mit allen Nachrichten löschen?`)) return;

  const { error } = await db.from('channels').delete().eq('id', ch.id);
  if (error) return alert(error.message);

  state.channel = null;
  const channels = await loadChannels();
  if (channels.length) selectChannel(channels[0].id);
  else clearChat();
}

$('btn-delete-channel').onclick = deleteChannel;

function clearChat() {
  if (state.sub) {
    db.removeChannel(state.sub);
    state.sub = null;
  }
  $('messages').replaceChildren();
  $('channel-title').textContent = '';
  $('msg-input').disabled = true;
  $('msg-input').placeholder = 'Kein Kanal ausgewählt';
  state.channel = null;
  updateHeadButtons();
}

// ---------------------------------------------------------------------
// Nachrichten laden, anzeigen, bearbeiten, löschen
// ---------------------------------------------------------------------

function fetchMessages(channelId, before) {
  let query = db
    .from('messages')
    .select('id, content, created_at, edited_at, user_id')
    .eq('channel_id', channelId)
    .order('created_at', { ascending: false })
    .limit(PAGE_SIZE);
  if (before) query = query.lt('created_at', before);
  return query;
}

function olderButton(visible) {
  const btn = document.createElement('button');
  btn.id = 'load-older';
  btn.type = 'button';
  btn.className = 'link-btn center';
  btn.textContent = 'Ältere Nachrichten laden';
  btn.hidden = !visible;
  btn.onclick = loadOlder;
  return btn;
}

async function loadOlder() {
  const channelId = state.channel?.id;
  if (!channelId || !state.oldestAt) return;

  const btn = $('load-older');
  btn.disabled = true;
  const { data, error } = await fetchMessages(channelId, state.oldestAt);
  btn.disabled = false;
  if (error) return alert(error.message);
  if (state.channel?.id !== channelId) return;

  await ensureNames(data.map((m) => m.user_id));
  data.reverse();

  const box = $('messages');
  const heightBefore = box.scrollHeight;
  btn.after(...data.map(buildMessage));
  btn.hidden = data.length < PAGE_SIZE;
  state.oldestAt = data[0]?.created_at ?? state.oldestAt;
  box.scrollTop += box.scrollHeight - heightBefore; // Ansicht nicht springen lassen
}

function subscribe(channelId) {
  if (state.sub) db.removeChannel(state.sub);
  const filter = `channel_id=eq.${channelId}`;

  state.sub = db
    .channel(`messages-${channelId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter }, async ({ new: msg }) => {
      if (state.channel?.id !== channelId) return;
      await ensureNames([msg.user_id]);
      if (state.channel?.id !== channelId) return;
      addMessage(msg);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter }, ({ new: msg }) => {
      if (state.channel?.id !== channelId) return;
      document.querySelector(`[data-id="${msg.id}"]`)?.replaceWith(buildMessage(msg));
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'messages', filter }, ({ old }) => {
      if (state.channel?.id !== channelId) return;
      document.querySelector(`[data-id="${old.id}"]`)?.remove();
    })
    .subscribe();
}

async function ensureNames(ids) {
  const missing = [...new Set(ids)].filter((id) => !state.names.has(id));
  if (!missing.length) return;

  const { data } = await db.from('profiles').select('id, username').in('id', missing);
  (data ?? []).forEach((p) => state.names.set(p.id, p.username));
}

function formatTime(iso) {
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

// Zeigt **fett**, *kursiv* und `code`. Es wird nur textContent verwendet, kein innerHTML.
function renderFormatted(el, text) {
  el.replaceChildren();
  const parts = text.split(/(\*\*[^*\n]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/);
  for (const part of parts) {
    if (!part) continue;
    let node;
    if (part.length > 4 && part.startsWith('**') && part.endsWith('**')) {
      node = document.createElement('strong');
      node.textContent = part.slice(2, -2);
    } else if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      node = document.createElement('code');
      node.textContent = part.slice(1, -1);
    } else if (part.length > 2 && part.startsWith('*') && part.endsWith('*')) {
      node = document.createElement('em');
      node.textContent = part.slice(1, -1);
    } else {
      node = document.createTextNode(part);
    }
    el.append(node);
  }
}

function iconButton(label, title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'icon-btn small';
  btn.title = title;
  btn.textContent = label;
  btn.onclick = onClick;
  return btn;
}

function buildMessage(msg) {
  const article = document.createElement('article');
  article.className = 'msg';
  article.dataset.id = msg.id;

  const header = document.createElement('header');
  const author = document.createElement('strong');
  author.textContent = state.names.get(msg.user_id) ?? 'Unbekannt';
  const time = document.createElement('time');
  time.dateTime = msg.created_at;
  time.textContent = formatTime(msg.created_at);
  header.append(author, time);
  if (msg.edited_at) {
    const edited = document.createElement('span');
    edited.className = 'edited';
    edited.textContent = '(bearbeitet)';
    header.append(edited);
  }

  const text = document.createElement('p');
  renderFormatted(text, msg.content);
  article.append(header, text);

  if (msg.user_id === state.user?.id) {
    const actions = document.createElement('div');
    actions.className = 'msg-actions';
    actions.append(
      iconButton('✎', 'Bearbeiten', () => startEdit(article, msg)),
      iconButton('🗑', 'Löschen', () => deleteMessage(msg.id))
    );
    article.append(actions);
  }
  return article;
}

function addMessage(msg) {
  const box = $('messages');
  if (box.querySelector(`[data-id="${msg.id}"]`)) return; // schon angezeigt

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  box.append(buildMessage(msg));
  if (nearBottom || msg.user_id === state.user?.id) scrollToBottom();
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
}

function startEdit(article, msg) {
  const p = article.querySelector('p');
  const input = document.createElement('input');
  input.className = 'edit-input';
  input.maxLength = 2000;
  input.value = msg.content;
  p.replaceWith(input);
  article.querySelector('.msg-actions').hidden = true;
  input.focus();

  const cancel = () => article.replaceWith(buildMessage(msg));

  input.addEventListener('keydown', async (e) => {
    if (e.key === 'Escape') return cancel();
    if (e.key !== 'Enter') return;

    const content = input.value.trim();
    if (!content || content === msg.content) return cancel();

    const editedAt = new Date().toISOString();
    const { error } = await db
      .from('messages')
      .update({ content, edited_at: editedAt })
      .eq('id', msg.id);
    if (error) return alert(`Nachricht konnte nicht bearbeitet werden: ${error.message}`);

    article.replaceWith(buildMessage({ ...msg, content, edited_at: editedAt }));
  });
}

async function deleteMessage(id) {
  if (!confirm('Nachricht wirklich löschen?')) return;
  const { error } = await db.from('messages').delete().eq('id', id);
  if (error) return alert(`Nachricht konnte nicht gelöscht werden: ${error.message}`);
  document.querySelector(`[data-id="${id}"]`)?.remove();
}

$('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = $('msg-input');
  const content = input.value.trim();
  if (!content || !state.channel) return;

  const channelId = state.channel.id;
  input.value = '';
  const { error } = await db
    .from('messages')
    .insert({ channel_id: channelId, user_id: state.user.id, content });

  if (error) {
    input.value = content;
    alert(`Nachricht konnte nicht gesendet werden: ${error.message}`);
  }
});

// ---------------------------------------------------------------------
// Dialoge
// ---------------------------------------------------------------------

const dlg = $('dlg');

function openDialog(sectionId) {
  document.querySelectorAll('.dlg-section').forEach((s) => {
    s.hidden = s.id !== sectionId;
  });
  $('dlg-error').hidden = true;
  dlg.showModal();
}

function dlgError(message) {
  $('dlg-error').textContent = message;
  $('dlg-error').hidden = false;
}

document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.onclick = () => dlg.close();
});
$('btn-add-server').onclick = () => openDialog('sec-create-server');
$('btn-show-join').onclick = () => openDialog('sec-join-server');
$('btn-show-create').onclick = () => openDialog('sec-create-server');
$('btn-add-channel').onclick = () => openDialog('sec-create-channel');

$('form-create-server').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('create-server-name').value.trim();
  const { data: serverId, error } = await db.rpc('create_server', { server_name: name });
  if (error) return dlgError(error.message);

  e.target.reset();
  dlg.close();
  await loadServers(serverId);
});

$('form-join-server').addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = $('join-code').value.trim().toLowerCase();
  const { data: serverId, error } = await db.rpc('join_server', { code });
  if (error) return dlgError(error.message);

  e.target.reset();
  dlg.close();
  await loadServers(serverId);
});

$('form-create-channel').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('channel-name').value.trim().toLowerCase().replace(/\s+/g, '-');
  const { data: channel, error } = await db
    .from('channels')
    .insert({ server_id: state.server.id, name })
    .select('id')
    .single();
  if (error) return dlgError(error.message);

  e.target.reset();
  dlg.close();
  await loadChannels();
  selectChannel(channel.id);
});

// ---------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------

db.auth.onAuthStateChange((event, session) => {
  // setTimeout: Supabase-Aufrufe direkt im Callback können sich gegenseitig blockieren
  setTimeout(() => {
    if (event === 'PASSWORD_RECOVERY') {
      state.recovery = true;
      showScreen(true);
      showAuthForm('update');
      return;
    }
    if (state.recovery) return;
    if (session?.user) enterApp(session.user);
    else leaveApp();
  }, 0);
});
