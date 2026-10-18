const cfg = window.FISCORD_CONFIG;
if (!cfg || cfg.SUPABASE_URL.includes('DEIN-')) {
  document.body.textContent = 'Bitte trage zuerst deine Supabase-URL und den Key in config.js ein.';
  throw new Error('config.js nicht ausgefüllt');
}

const db = supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
const $ = (id) => document.getElementById(id);

const state = {
  user: null,
  servers: [],
  server: null,     // aktiver Server
  channels: [],
  channel: null,    // aktiver Kanal
  names: new Map(), // user_id -> Benutzername
  sub: null,        // Realtime-Abo für den aktiven Kanal
};

// ---------------------------------------------------------------------
// Anmeldung & Registrierung
// ---------------------------------------------------------------------

function setAuthMsg(text, type = 'error') {
  const el = $('auth-msg');
  el.textContent = text;
  el.className = `msg-box ${type}`;
  el.hidden = false;
}

function switchTab(mode) {
  const login = mode === 'login';
  $('tab-login').classList.toggle('active', login);
  $('tab-register').classList.toggle('active', !login);
  $('login-form').hidden = !login;
  $('register-form').hidden = login;
  $('auth-msg').hidden = true;
}
$('tab-login').onclick = () => switchTab('login');
$('tab-register').onclick = () => switchTab('register');

// Zurück-Link aus der Bestätigungs-E-Mail (muss in Supabase als Redirect-URL erlaubt sein)
const redirectTo = location.origin + location.pathname;

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
    options: {
      data: { username },
      emailRedirectTo: redirectTo,
    },
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

$('btn-logout').onclick = () => db.auth.signOut();

// Sitzung überwachen (inkl. Rückkehr aus dem E-Mail-Bestätigungslink)
db.auth.onAuthStateChange((_event, session) => {
  // setTimeout: Supabase-Aufrufe direkt im Callback können sich gegenseitig blockieren
  setTimeout(() => (session?.user ? enterApp(session.user) : leaveApp()), 0);
});

function leaveApp() {
  if (state.sub) db.removeChannel(state.sub);
  state.user = null;
  state.servers = [];
  state.server = null;
  state.channels = [];
  state.channel = null;
  state.sub = null;
  state.names.clear();
  clearChat();
  $('app').hidden = true;
  $('auth').hidden = false;
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

  $('auth').hidden = true;
  $('app').hidden = false;
  await loadServers();
}

// ---------------------------------------------------------------------
// Server & Kanäle
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
  if (target) {
    await selectServer(target.id);
  } else {
    state.server = null;
    $('server-name').textContent = 'Kein Server';
    $('btn-invite').hidden = true;
    $('btn-add-channel').hidden = true;
    state.channels = [];
    renderChannels();
    clearChat();
    $('channel-title').textContent = 'Erstelle einen Server oder tritt einem bei (+)';
  }
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

async function selectServer(id) {
  const server = state.servers.find((s) => s.id === id);
  if (!server) return;

  state.server = server;
  renderServers();
  $('server-name').textContent = server.name;
  $('btn-invite').hidden = false;
  $('btn-add-channel').hidden = server.owner_id !== state.user.id;

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

async function selectChannel(id) {
  const channel = state.channels.find((c) => c.id === id);
  if (!channel) return;

  state.channel = channel;
  renderChannels();
  $('channel-title').textContent = `# ${channel.name}`;
  $('msg-input').disabled = false;
  $('msg-input').placeholder = `Nachricht an #${channel.name}`;
  $('messages').replaceChildren();

  const { data, error } = await db
    .from('messages')
    .select('id, content, created_at, user_id')
    .eq('channel_id', id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return alert(`Nachrichten konnten nicht geladen werden: ${error.message}`);
  if (state.channel?.id !== id) return;

  await ensureNames(data.map((m) => m.user_id));
  if (state.channel?.id !== id) return;

  $('messages').replaceChildren();
  data.reverse().forEach(addMessage);
  scrollToBottom();

  subscribe(id);
}

function clearChat() {
  $('messages').replaceChildren();
  $('channel-title').textContent = '';
  $('msg-input').disabled = true;
  $('msg-input').placeholder = 'Kein Kanal ausgewählt';
  state.channel = null;
}

// ---------------------------------------------------------------------
// Nachrichten (Realtime)
// ---------------------------------------------------------------------

function subscribe(channelId) {
  if (state.sub) db.removeChannel(state.sub);

  state.sub = db
    .channel(`messages-${channelId}`)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
      },
      async ({ new: msg }) => {
        if (state.channel?.id !== channelId) return;
        await ensureNames([msg.user_id]);
        if (state.channel?.id !== channelId) return;
        addMessage(msg);
      }
    )
    .subscribe();
}

async function ensureNames(ids) {
  const missing = [...new Set(ids)].filter((id) => !state.names.has(id));
  if (!missing.length) return;

  const { data } = await db.from('profiles').select('id, username').in('id', missing);
  (data ?? []).forEach((p) => state.names.set(p.id, p.username));
}

function addMessage(msg) {
  const box = $('messages');
  if (box.querySelector(`[data-id="${msg.id}"]`)) return; // schon angezeigt

  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 120;

  const article = document.createElement('article');
  article.className = 'msg';
  article.dataset.id = msg.id;

  const header = document.createElement('header');
  const author = document.createElement('strong');
  author.textContent = state.names.get(msg.user_id) ?? 'Unbekannt';
  const time = document.createElement('time');
  time.dateTime = msg.created_at;
  time.textContent = new Date(msg.created_at).toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
  header.append(author, time);

  const text = document.createElement('p');
  text.textContent = msg.content; // textContent statt innerHTML: kein XSS möglich

  article.append(header, text);
  box.append(article);

  if (nearBottom || msg.user_id === state.user?.id) scrollToBottom();
}

function scrollToBottom() {
  const box = $('messages');
  box.scrollTop = box.scrollHeight;
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
// Dialoge: Server erstellen / beitreten, Kanal erstellen
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

$('btn-invite').onclick = async () => {
  const code = state.server.invite_code;
  try {
    await navigator.clipboard.writeText(code);
    alert(`Einladungscode kopiert: ${code}`);
  } catch {
    alert(`Einladungscode: ${code}`);
  }
};
