'use strict';

/* =====================================================================
   Hangimiz? — party voting game.
   One player (the room owner) is the "host": their browser keeps the
   whole game state and talks to everyone else directly over WebRTC
   (PeerJS). No game server needed; the room lives as long as the
   host's tab is open.
   ===================================================================== */

const PEER_PREFIX = 'hangimiz-oda-v1-';
const CODE_CHARS = 'ABCDEFGHJKLMNPRSTUVYZ';
const CODE_LEN = 4;
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 16;
const MAX_NAME = 16;
const MAX_Q_LEN = 90;
const HEARTBEAT_MS = 3000;
const TIMEOUT_MS = 12000;
const AUTO_REVEAL_MS = 8000;
const WRITE_GRACE_MS = 1200;
const LOBBY_DROP_MS = 45000;
const HOST_RECORD_MAX_AGE = 12 * 3600 * 1000;
const PEER_OPTS = { debug: 0 };

const DEFAULT_SETTINGS = {
  writeTime: 20,
  qPerPlayer: 4,
  answerTime: 10,
  startMode: 'host',
  revealMode: 'host',
  selfVote: true,
  showAuthor: false,
  showVoters: false,
};

const SETTING_DEFS = [
  { key: 'writeTime', label: 'Soru yazma süresi', type: 'num', min: 10, max: 180, step: 5, unit: 'sn' },
  { key: 'qPerPlayer', label: 'Kişi başı soru', type: 'num', min: 1, max: 8, step: 1, unit: 'soru' },
  { key: 'answerTime', label: 'Soru başına cevap süresi', type: 'num', min: 0, max: 60, step: 5, unit: 'sn', zero: 'Sınırsız' },
  { key: 'startMode', label: 'Oyunu kim başlatır?', type: 'choice', options: [['host', 'Lider'], ['ready', 'Herkes hazır olunca']] },
  { key: 'revealMode', label: 'Sonuçları kim geçirir?', type: 'choice', options: [['host', 'Lider'], ['auto', 'Otomatik']] },
  { key: 'selfVote', label: 'Kendine oy verebilsin', type: 'bool' },
  { key: 'showAuthor', label: 'Soruyu kimin yazdığı görünsün', type: 'bool' },
  { key: 'showVoters', label: 'Kim kime oy verdi görünsün', type: 'bool' },
];

const AVATARS = ['🦊', '🐸', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🐨', '🦁', '🐷', '🐰', '🐻', '🐶', '🐱', '🦉'];
const COLORS = ['#ffb36b', '#8be28b', '#cfd8e3', '#ff9fc4', '#d7b8ff', '#ffd36b', '#c9a27e', '#9fd3ff', '#b8c4cf', '#ffc94d', '#ffb0c0', '#f2e2ff', '#d9a77a', '#ffe08a', '#a8e6cf', '#c7b3ff'];

const RANDOM_QUESTIONS = [
  'Grubun en zekisi kim?',
  'En yakışıklı / en güzel kim?',
  'Zombi kıyametinde ilk kim ölür?',
  'Mesajlara en geç kim cevap verir?',
  'Buluşmaya en çok kim geç kalır?',
  'Filmde gizlice en çok kim ağlar?',
  'Bir gün kim ünlü olur?',
  'En iyi yemeği kim yapar?',
  'En kötü şoför kim olur?',
  'İlk kim evlenir?',
  'En çok parayı kim kazanır?',
  'En komik kim?',
  'Sır tutamayan kim?',
  'Telefona en çok kim bakıyor?',
  'En tembel kim?',
  'Issız adada en uzun kim hayatta kalır?',
  'Karaokede en kötü kim söyler?',
  'En çok kim yer?',
  'Gece 3\'te mesaj atan kim?',
  'En dramatik kim?',
  'En iyi sevgili kim olur?',
  'Realite şovuna kim katılır?',
  'En kıskanç kim?',
  'En saf kim?',
  'En iyi yalanı kim söyler?',
  'Korku filminde ilk kim çığlık atar?',
  'En iyi kim dans eder?',
  'En çok selfie çeken kim?',
  'En uzun kim uyur?',
  '"5 dakikaya oradayım" deyip 1 saat gelmeyen kim?',
  'YouTuber kim olur?',
  'Parasını en hızlı kim harcar?',
  'Bir gün başkan kim olur?',
  'Süper güç alsa en işe yaramazını kim alır?',
  'En kolay kim kandırılır?',
  'Grubun annesi / babası kim?',
  'Yanlışlıkla en çok kim rezil olur?',
  'Kimin tarayıcı geçmişi en tehlikeli?',
  'En çok kim plan yapıp sonra iptal eder?',
  'Kaybolsak bizi kim kurtarır?',
  'En kötü espriyi kim yapar?',
  'Kim gizli bir yetenek saklıyor?',
  'En çok kim "ben demiştim" der?',
  'Kim 10 yıl sonra hiç değişmemiş olur?',
  'Kim bir hayvanla konuşabiliyor gibi?',
];

/* ---------------------------------------------------------------- utils */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lower = (s) => String(s).toLocaleLowerCase('tr');

const store = {
  area(session) { return session ? window.sessionStorage : window.localStorage; },
  get(key, session) {
    try { const v = this.area(session).getItem(key); return v == null ? null : JSON.parse(v); } catch { return null; }
  },
  set(key, value, session) {
    try { this.area(session).setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
  },
  del(key, session) {
    try { this.area(session).removeItem(key); } catch { /* storage unavailable */ }
  },
};

function randomId(len = 10) {
  const abc = 'abcdefghijkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let s = '';
  for (const b of bytes) s += abc[b % abc.length];
  return s;
}

function newRoomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LEN));
  let s = '';
  for (const b of bytes) s += CODE_CHARS[b % CODE_CHARS.length];
  return s;
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function cleanName(name) {
  return String(name ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

function cleanCode(code) {
  return String(code ?? '').toLocaleUpperCase('tr').replace(/İ/g, 'I').replace(/[^A-Z]/g, '').slice(0, CODE_LEN);
}

function roomLink(code) {
  return location.origin + location.pathname + '?oda=' + code;
}

function avatarHTML(p, size = '') {
  if (!p) return '<span class="av ' + size + '">❔</span>';
  return '<span class="av ' + size + '" style="--c:' + esc(p.col) + '">' + esc(p.av) + '</span>';
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  el.style.animation = 'none';
  void el.offsetWidth;
  el.style.animation = '';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function setNetBar(msg) {
  const el = $('#netbar');
  if (msg) { el.textContent = msg; el.hidden = false; } else { el.hidden = true; }
}

/* ---------------------------------------------------------------- sound */

const Sound = {
  ctx: null,
  muted: store.get('hz-muted') === true,
  beep(freq = 660, dur = 0.08, type = 'sine', vol = 0.08) {
    if (this.muted) return;
    try {
      this.ctx = this.ctx || new (window.AudioContext || window.webkitAudioContext)();
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = type;
      o.frequency.setValueAtTime(freq, t);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      o.connect(g).connect(this.ctx.destination);
      o.start(t);
      o.stop(t + dur + 0.02);
    } catch { /* audio not available */ }
  },
  tick() { this.beep(880, 0.05, 'square', 0.03); },
  click() { this.beep(520, 0.07, 'triangle', 0.09); },
  join() { this.beep(660, 0.08); setTimeout(() => this.beep(990, 0.1), 90); },
  fanfare() { [523, 659, 784, 1047].forEach((f, i) => setTimeout(() => this.beep(f, 0.18, 'triangle', 0.08), i * 120)); },
  toggle() { this.muted = !this.muted; store.set('hz-muted', this.muted); },
};

/* ---------------------------------------------------------------- identity */

let myId = store.get('hz-id', true) || randomId();
store.set('hz-id', myId, true);
let myName = store.get('hz-name') || '';

/* ---------------------------------------------------------------- app state (view side) */

const App = {
  role: null,          // 'host' | 'client'
  code: null,
  state: null,         // last public state received
  screenKey: null,
  deadline: null,      // local timestamp when the phase timer hits 0
  deadlineTotal: 0,
  deadlineKey: null,
  lastSecond: null,
  ans: null,           // local answering progress
  wDone: false,        // "I'm done writing" flag
  draftTimer: null,
};

function send(msg) {
  if (App.role === 'host') Host.handle(Host.S.hostId, msg);
  else Client.send(msg);
}

/* =====================================================================
   HOST
   ===================================================================== */

const Host = {
  peer: null,
  S: null,
  conns: new Map(),     // playerId -> DataConnection
  opened: false,
  ticker: null,
  lastBeat: 0,
  broadcastQueued: false,
  saveTimer: null,

  create(name, code) {
    const S = {
      code,
      hostId: myId,
      phase: 'lobby',
      settings: { ...DEFAULT_SETTINGS, ...(store.get('hz-settings') || {}) },
      players: {},
      order: [],
      round: null,
      notice: null,
    };
    S.settings = sanitizeSettings(S.settings);
    this.S = S;
    this.addPlayer(myId, name);
    S.players[myId].connected = true;
    this.open(code, false, 0);
  },

  resume(rec) {
    myId = rec.hostId;
    store.set('hz-id', myId, true);
    const S = rec.S;
    for (const id of S.order) {
      const p = S.players[id];
      p.connected = id === S.hostId;
      p.lastSeen = Date.now();
    }
    this.S = S;
    this.open(S.code, true, 0);
  },

  open(code, resuming, attempt) {
    App.role = 'host';
    App.code = code;
    showConnecting(resuming ? 'Oda geri açılıyor…' : 'Oda kuruluyor…');
    this.opened = false;
    const peer = new Peer(PEER_PREFIX + code, PEER_OPTS);
    this.peer = peer;

    peer.on('open', () => {
      if (this.peer !== peer) return;
      const first = !this.opened;
      this.opened = true;
      setNetBar(null);
      if (!first) return;
      history.replaceState(null, '', '?oda=' + code);
      store.set('hz-hosting', code, true);
      this.startTicker();
      this.changed();
      if (resuming) toast('Oda geri açıldı, arkadaşların kendiliğinden bağlanacak.');
    });

    peer.on('connection', (conn) => this.attach(conn));

    peer.on('disconnected', () => {
      if (peer.destroyed || this.peer !== peer) return;
      setNetBar('Sunucu bağlantısı koptu, yeniden bağlanılıyor…');
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch { /* retry later */ } } }, 1500);
    });

    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'unavailable-id') {
        peer.destroy();
        if (resuming && attempt < 20) {
          setTimeout(() => this.open(code, true, attempt + 1), 3000);
        } else if (resuming) {
          showError('Oda geri açılamadı 😕', 'Bu oda kodu başka bir sekmede açık olabilir. Ana sayfadan yeni oda kurabilirsin.');
        } else {
          const c = newRoomCode();
          this.S.code = c;
          this.open(c, false, 0);
        }
      } else if (err.type === 'peer-unavailable') {
        /* a client that vanished; nothing to do */
      } else if (!this.opened) {
        peer.destroy();
        if (attempt < 6) setTimeout(() => this.open(code, resuming, attempt + 1), 2500);
        else showError('Oda kurulamadı 😕', 'İnternet bağlantını kontrol edip sayfayı yenile.');
      } else {
        console.warn('peer error', err.type, err);
      }
    });
  },

  attach(conn) {
    conn.on('data', (msg) => {
      if (!msg || typeof msg !== 'object') return;
      if (msg.t === 'hello') { this.hello(conn, msg); return; }
      const pid = conn._pid;
      if (!pid || this.conns.get(pid) !== conn) return;
      this.handle(pid, msg);
    });
    const gone = () => this.connGone(conn);
    conn.on('close', gone);
    conn.on('error', gone);
  },

  hello(conn, msg) {
    const S = this.S;
    let id = String(msg.id || '').slice(0, 24);
    const name = cleanName(msg.name);
    const reply = (m) => { try { conn.send(m); } catch { /* closed */ } };
    if (!id || !name) { reply({ t: 'error', code: 'bad' }); return; }
    if (id === S.hostId) { reply({ t: 'error', code: 'bad' }); return; }

    let p = S.players[id];
    const sameName = S.order.map((x) => S.players[x]).find((x) => x.id !== id && lower(x.name) === lower(name));
    if (!p && sameName) {
      if (sameName.connected || sameName.id === S.hostId) { reply({ t: 'error', code: 'name' }); return; }
      // Same name as someone who dropped out: treat it as them coming back
      // (e.g. their phone killed the tab and they reopened the link).
      id = sameName.id;
      p = sameName;
    } else if (p && sameName) {
      reply({ t: 'error', code: 'name' }); return;
    }

    if (!p) {
      if (S.order.length >= MAX_PLAYERS) { reply({ t: 'error', code: 'full' }); return; }
      p = this.addPlayer(id, name);
    } else if (S.phase === 'lobby') {
      p.name = name;
    }

    const old = this.conns.get(id);
    if (old && old !== conn) { old._pid = null; try { old.close(); } catch { /* ignore */ } }
    conn._pid = id;
    this.conns.set(id, conn);
    p.connected = true;
    p.lastSeen = Date.now();
    p.offSince = null;
    this.changed();
  },

  addPlayer(id, name) {
    const S = this.S;
    const used = new Set(S.order.map((x) => S.players[x].avIndex));
    let idx = 0;
    while (used.has(idx) && idx < AVATARS.length) idx++;
    if (idx >= AVATARS.length) idx = S.order.length % AVATARS.length;
    const p = {
      id, name, avIndex: idx, av: AVATARS[idx], col: COLORS[idx],
      connected: false, ready: false, lastSeen: Date.now(), offSince: null,
    };
    S.players[id] = p;
    S.order.push(id);
    return p;
  },

  removePlayer(id) {
    const S = this.S;
    delete S.players[id];
    S.order = S.order.filter((x) => x !== id);
    const c = this.conns.get(id);
    if (c) { c._pid = null; this.conns.delete(id); try { c.close(); } catch { /* ignore */ } }
  },

  connGone(conn) {
    const pid = conn._pid;
    if (!pid || this.conns.get(pid) !== conn) return;
    this.conns.delete(pid);
    conn._pid = null;
    const p = this.S.players[pid];
    if (p) { p.connected = false; p.ready = false; p.offSince = Date.now(); }
    this.changed();
  },

  handle(pid, msg) {
    const S = this.S;
    const p = S.players[pid];
    if (!p) return;
    p.lastSeen = Date.now();
    const r = S.round;
    const isHost = pid === S.hostId;

    switch (msg.t) {
      case 'ping':
        return;

      case 'leave':
        if (S.phase === 'lobby') this.removePlayer(pid);
        else this.connGone(this.conns.get(pid) || {});
        this.changed();
        return;

      case 'ready':
        if (S.phase !== 'lobby') return;
        p.ready = !!msg.v;
        this.changed();
        this.maybeAutoStart();
        return;

      case 'drafts':
        if (S.phase !== 'writing' || !r || !r.roster.includes(pid)) return;
        r.drafts[pid] = sanitizeDrafts(msg.list, S.settings.qPerPlayer);
        r.done[pid] = !!msg.done;
        this.changed();
        if (this.allWritersDone()) this.endWriting();
        return;

      case 'vote': {
        if (S.phase !== 'answering' || !r || !r.roster.includes(pid)) return;
        const q = r.questions.find((x) => x.id === msg.qid);
        if (!q) return;
        r.answered[pid] = r.answered[pid] || {};
        if (r.answered[pid][q.id]) return;
        let target = msg.target == null ? null : String(msg.target);
        if (target && !r.roster.includes(target)) return;
        if (target === pid && !S.settings.selfVote) return;
        r.answered[pid][q.id] = true;
        if (target) {
          r.votes[q.id] = r.votes[q.id] || {};
          r.votes[q.id][pid] = target;
        }
        this.changed();
        if (this.allAnswered()) this.endAnswering();
        return;
      }
    }

    if (!isHost) return;

    switch (msg.t) {
      case 'settings':
        if (S.phase !== 'lobby') return;
        S.settings = sanitizeSettings({ ...S.settings, ...msg.settings });
        store.set('hz-settings', S.settings);
        this.changed();
        this.maybeAutoStart();
        return;
      case 'start':
        if (S.phase === 'lobby') this.startRound();
        return;
      case 'skip':
        if (S.phase === 'writing') this.endWriting();
        else if (S.phase === 'answering') this.endAnswering();
        return;
      case 'next':
        if (S.phase === 'results') this.nextReveal();
        return;
      case 'prev':
        if (S.phase === 'results' && r.revealIndex > 0) {
          r.revealIndex--;
          r.deadline = S.settings.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
          this.changed();
        }
        return;
      case 'lobby':
        this.backToLobby();
        return;
      case 'kick': {
        const id = String(msg.id || '');
        if (id === S.hostId || !S.players[id]) return;
        const c = this.conns.get(id);
        if (c) { try { c.send({ t: 'kicked' }); } catch { /* ignore */ } }
        setTimeout(() => { this.removePlayer(id); this.changed(); }, 150);
        return;
      }
    }
  },

  connectedIds() {
    return this.S.order.filter((id) => this.S.players[id].connected);
  },

  maybeAutoStart() {
    const S = this.S;
    if (S.phase !== 'lobby' || S.settings.startMode !== 'ready') return;
    const ids = this.connectedIds();
    if (ids.length < MIN_PLAYERS) return;
    if (ids.every((id) => S.players[id].ready || id === S.hostId)) this.startRound();
  },

  startRound() {
    const S = this.S;
    const roster = this.connectedIds();
    if (roster.length < MIN_PLAYERS) { toast('En az ' + MIN_PLAYERS + ' kişi lazım!'); return; }
    const names = {};
    for (const id of roster) {
      const p = S.players[id];
      names[id] = { name: p.name, av: p.av, col: p.col };
    }
    const now = Date.now();
    S.notice = null;
    S.round = {
      id: randomId(6),
      roster,
      names,
      drafts: {},
      done: {},
      questions: [],
      votes: {},
      answered: {},
      results: [],
      revealIndex: 0,
      final: null,
      deadline: now + S.settings.writeTime * 1000,
      deadlineTotal: S.settings.writeTime * 1000,
    };
    for (const id of S.order) S.players[id].ready = false;
    S.phase = 'writing';
    this.changed();
  },

  allWritersDone() {
    const r = this.S.round;
    const live = r.roster.filter((id) => this.S.players[id] && this.S.players[id].connected);
    return live.length > 0 && live.every((id) => r.done[id]);
  },

  endWriting() {
    const S = this.S;
    const r = S.round;
    if (S.phase !== 'writing') return;
    const seen = new Set();
    const qs = [];
    for (const id of r.roster) {
      for (const text of (r.drafts[id] || []).slice(0, S.settings.qPerPlayer)) {
        const key = lower(text).replace(/[^\p{L}\p{N}]+/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        qs.push({ text, author: id });
      }
    }
    if (!qs.length) {
      S.phase = 'lobby';
      S.round = null;
      S.notice = 'Kimse soru yazmadı 😅 Bir daha deneyin!';
      this.changed();
      return;
    }
    r.questions = shuffle(qs).map((q, i) => ({ id: 'q' + i, text: q.text, author: q.author }));
    r.drafts = {};
    const per = S.settings.answerTime;
    r.deadline = per > 0 ? Date.now() + r.questions.length * per * 1000 + 4000 : null;
    r.deadlineTotal = per > 0 ? r.questions.length * per * 1000 + 4000 : 0;
    S.phase = 'answering';
    this.changed();
  },

  allAnswered() {
    const r = this.S.round;
    const live = r.roster.filter((id) => this.S.players[id] && this.S.players[id].connected);
    return live.length > 0 && live.every((id) => Object.keys(r.answered[id] || {}).length >= r.questions.length);
  },

  endAnswering() {
    const S = this.S;
    const r = S.round;
    if (S.phase !== 'answering') return;
    r.results = computeResults(r, S.settings);
    r.final = computeFinal(r);
    r.revealIndex = 0;
    r.deadline = S.settings.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
    r.deadlineTotal = AUTO_REVEAL_MS;
    S.phase = 'results';
    this.changed();
  },

  nextReveal() {
    const S = this.S;
    const r = S.round;
    if (r.revealIndex < r.results.length - 1) {
      r.revealIndex++;
      r.deadline = S.settings.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
    } else {
      S.phase = 'final';
      r.deadline = null;
    }
    this.changed();
  },

  backToLobby() {
    const S = this.S;
    S.phase = 'lobby';
    S.round = null;
    for (const id of S.order.slice()) {
      if (id !== S.hostId && !S.players[id].connected) this.removePlayer(id);
    }
    for (const id of S.order) S.players[id].ready = false;
    this.changed();
  },

  startTicker() {
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 500);
  },

  tick() {
    const S = this.S;
    const now = Date.now();
    let dirty = false;

    for (const [pid, conn] of this.conns) {
      const p = S.players[pid];
      if (!p || now - p.lastSeen > TIMEOUT_MS) {
        try { conn.close(); } catch { /* ignore */ }
        this.connGone(conn);
        dirty = true;
      }
    }

    if (S.phase === 'lobby') {
      for (const id of S.order.slice()) {
        const p = S.players[id];
        if (id !== S.hostId && !p.connected && p.offSince && now - p.offSince > LOBBY_DROP_MS) {
          this.removePlayer(id);
          dirty = true;
        }
      }
    }

    const r = S.round;
    if (r && r.deadline) {
      if (S.phase === 'writing' && now >= r.deadline + WRITE_GRACE_MS) this.endWriting();
      else if (S.phase === 'answering' && now >= r.deadline) this.endAnswering();
      else if (S.phase === 'results' && now >= r.deadline) this.nextReveal();
    }
    // Disconnected players must not hold the round hostage.
    if (S.phase === 'writing' && r && this.allWritersDone()) this.endWriting();
    if (S.phase === 'answering' && r && this.allAnswered()) this.endAnswering();

    if (now - this.lastBeat > HEARTBEAT_MS) {
      this.lastBeat = now;
      for (const conn of this.conns.values()) { if (conn.open) { try { conn.send({ t: 'p' }); } catch { /* ignore */ } } }
    }
    if (dirty) this.changed();
  },

  changed() {
    if (!this.broadcastQueued) {
      this.broadcastQueued = true;
      setTimeout(() => { this.broadcastQueued = false; this.broadcast(); }, 30);
    }
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        store.set('hz-host', { code: this.S.code, hostId: this.S.hostId, S: this.S, t: Date.now() });
      }, 400);
    }
  },

  broadcast() {
    for (const [pid, conn] of this.conns) {
      if (!conn.open) continue;
      try { conn.send({ t: 'state', s: this.publicState(pid) }); } catch (e) { console.warn('send failed', e); }
    }
    onState(this.publicState(this.S.hostId));
  },

  publicState(pid) {
    const S = this.S;
    const r = S.round;
    const now = Date.now();
    const pub = {
      you: pid,
      code: S.code,
      hostId: S.hostId,
      phase: S.phase,
      settings: S.settings,
      notice: S.notice,
      players: S.order.map((id) => {
        const p = S.players[id];
        return { id, name: p.name, av: p.av, col: p.col, connected: p.connected, ready: p.ready, inRound: !!(r && r.roster.includes(id)) };
      }),
      left: r && r.deadline ? Math.max(0, r.deadline - now) : null,
      total: r ? r.deadlineTotal : 0,
    };
    if (!r) return pub;
    pub.roundId = r.id;
    pub.roster = r.roster;
    pub.names = r.names;
    if (S.phase === 'writing') {
      const counts = {};
      for (const id of r.roster) counts[id] = (r.drafts[id] || []).length;
      pub.writing = { counts, done: r.done };
      pub.me = { drafts: r.drafts[pid] || [] };
    } else if (S.phase === 'answering') {
      pub.questions = r.questions.map((q) => ({ id: q.id, text: q.text, by: S.settings.showAuthor ? q.author : null }));
      const progress = {};
      for (const id of r.roster) progress[id] = Object.keys(r.answered[id] || {}).length;
      pub.progress = progress;
      pub.me = { answered: Object.keys(r.answered[pid] || {}) };
    } else if (S.phase === 'results') {
      pub.reveal = { index: r.revealIndex, total: r.results.length, item: r.results[r.revealIndex] };
    } else if (S.phase === 'final') {
      pub.final = r.final;
    }
    return pub;
  },
};

function sanitizeSettings(s) {
  const out = {};
  for (const d of SETTING_DEFS) {
    let v = s[d.key];
    if (d.type === 'num') {
      v = Math.round(Number(v));
      if (!Number.isFinite(v)) v = DEFAULT_SETTINGS[d.key];
      v = Math.min(d.max, Math.max(d.min, v));
    } else if (d.type === 'bool') {
      v = !!v;
    } else if (d.type === 'choice') {
      if (!d.options.some((o) => o[0] === v)) v = DEFAULT_SETTINGS[d.key];
    }
    out[d.key] = v;
  }
  return out;
}

function sanitizeDrafts(list, max) {
  if (!Array.isArray(list)) return [];
  return list
    .slice(0, max)
    .map((x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN))
    .filter(Boolean);
}

function computeResults(r, settings) {
  return r.questions.map((q) => {
    const counts = {};
    const voters = {};
    for (const id of r.roster) { counts[id] = 0; voters[id] = []; }
    for (const [voter, target] of Object.entries(r.votes[q.id] || {})) {
      if (counts[target] === undefined) continue;
      counts[target]++;
      voters[target].push(voter);
    }
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    const bars = r.roster
      .filter((id) => counts[id] > 0)
      .map((id) => ({ id, count: counts[id], voters: settings.showVoters ? voters[id] : null }))
      .sort((a, b) => b.count - a.count);
    const max = bars.length ? bars[0].count : 0;
    const winners = max > 0 ? bars.filter((b) => b.count === max).map((b) => b.id) : [];
    return { qid: q.id, text: q.text, by: settings.showAuthor ? q.author : null, author: q.author, total, bars, winners };
  });
}

function computeFinal(r) {
  const votes = {};
  const titles = {};
  const written = {};
  for (const id of r.roster) { votes[id] = 0; titles[id] = []; written[id] = 0; }
  let totalVotes = 0;
  const unanimous = [];
  for (const res of r.results) {
    totalVotes += res.total;
    for (const b of res.bars) votes[b.id] += b.count;
    const top = res.bars[0] ? res.bars[0].count : 0;
    for (const w of res.winners) titles[w].push({ text: res.text, count: top, total: res.total });
    if (res.total >= 2 && res.winners.length === 1 && top === res.total) unanimous.push({ text: res.text, id: res.winners[0] });
    if (written[res.author] !== undefined) written[res.author]++;
  }
  const ranking = r.roster.slice().sort((a, b) => titles[b].length - titles[a].length || votes[b] - votes[a]);
  const most = Math.max(0, ...Object.values(written));
  const topWriters = most > 0 ? r.roster.filter((id) => written[id] === most) : [];
  return {
    ranking,
    votes,
    titles,
    topWriters,
    topWriterCount: most,
    unanimous,
    questionCount: r.results.length,
    totalVotes,
    recap: r.results.map((res) => ({ text: res.text, winners: res.winners, top: res.bars[0] ? res.bars[0].count : 0, total: res.total })),
  };
}

/* =====================================================================
   CLIENT (everyone except the host)
   ===================================================================== */

const Client = {
  peer: null,
  conn: null,
  joined: false,
  stopped: false,
  retryTimer: null,
  lastMsg: 0,
  lastPing: 0,
  missSince: null,
  ticker: null,

  start(code, name) {
    App.role = 'client';
    App.code = code;
    myName = name;
    store.set('hz-name', name);
    store.set('hz-joined', { code, name }, true);
    history.replaceState(null, '', '?oda=' + code);
    this.stopped = false;
    showConnecting('Odaya bağlanılıyor…');
    this.ensurePeer();
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.tick(), 1000);
  },

  ensurePeer() {
    if (this.stopped) return;
    const peer = this.peer;
    if (peer && !peer.destroyed) {
      if (peer.open) { this.connect(); return; }
      if (peer.disconnected) { try { peer.reconnect(); } catch { this.newPeer(); } return; }
      return; // still opening
    }
    this.newPeer();
  },

  newPeer() {
    if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } }
    const peer = new Peer(PEER_OPTS);
    this.peer = peer;
    peer.on('open', () => { if (this.peer === peer) this.connect(); });
    peer.on('disconnected', () => {
      if (peer.destroyed || this.peer !== peer) return;
      setTimeout(() => { if (!peer.destroyed && peer.disconnected) { try { peer.reconnect(); } catch { /* retry later */ } } }, 1500);
    });
    peer.on('error', (err) => {
      if (this.peer !== peer) return;
      if (err.type === 'peer-unavailable') this.hostMissing();
      else this.lost();
    });
  },

  connect() {
    if (this.stopped) return;
    if (this.conn) { this.conn._dead = true; try { this.conn.close(); } catch { /* ignore */ } }
    const conn = this.peer.connect(PEER_PREFIX + App.code, { reliable: true, serialization: 'json' });
    this.conn = conn;
    const openTimer = setTimeout(() => { if (!conn.open && this.conn === conn) this.lost(); }, 10000);
    conn.on('open', () => {
      clearTimeout(openTimer);
      if (conn._dead) return;
      this.lastMsg = Date.now();
      conn.send({ t: 'hello', id: myId, name: myName });
    });
    conn.on('data', (msg) => {
      if (conn._dead) return;
      this.lastMsg = Date.now();
      this.onMessage(msg);
    });
    const drop = () => { if (!conn._dead && this.conn === conn) this.lost(); };
    conn.on('close', drop);
    conn.on('error', drop);
  },

  onMessage(msg) {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'state':
        if (!this.joined) Sound.join();
        this.joined = true;
        this.missSince = null;
        setNetBar(null);
        onState(msg.s);
        break;
      case 'error':
        this.stop();
        if (msg.code === 'name') showJoin(App.code, false, 'Bu isimde biri zaten odada. Başka bir isim seç 🙂');
        else if (msg.code === 'full') showError('Oda dolu 😕', 'Bu odada en fazla ' + MAX_PLAYERS + ' kişi olabilir.');
        else showJoin(App.code, false, 'Bir şeyler ters gitti, tekrar dene.');
        break;
      case 'kicked':
        this.stop();
        showError('Odadan çıkarıldın 👋', 'Lider seni odadan çıkardı.');
        break;
    }
  },

  send(msg) {
    if (this.conn && this.conn.open) { try { this.conn.send(msg); } catch { /* will resend on reconnect */ } }
  },

  lost() {
    if (this.stopped) return;
    if (this.joined) setNetBar('Bağlantı koptu, yeniden bağlanılıyor…');
    this.scheduleRetry(2000);
  },

  hostMissing() {
    if (this.stopped) return;
    this.missSince = this.missSince || Date.now();
    const waited = Date.now() - this.missSince;
    if (!this.joined && waited > 6000) {
      this.stop();
      showError('Oda bulunamadı 🔍', 'Kod doğru mu? Ya da odanın lideri sayfayı kapatmış olabilir.', true);
      return;
    }
    if (this.joined && waited > 90000) {
      this.stop();
      setNetBar(null);
      showError('Lider oyundan çıktı 😕', 'Odanın lideri sayfayı kapattı ya da interneti gitti.', true);
      return;
    }
    if (this.joined) setNetBar('Lidere ulaşılamıyor, bekleniyor…');
    this.scheduleRetry(2500);
  },

  scheduleRetry(delay) {
    if (this.retryTimer || this.stopped) return;
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.ensurePeer(); }, delay);
  },

  retryNow() {
    if (this.stopped || (this.conn && this.conn.open)) return;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.ensurePeer();
  },

  tick() {
    if (this.stopped) return;
    const now = Date.now();
    if (this.conn && this.conn.open) {
      if (now - this.lastPing > HEARTBEAT_MS) { this.lastPing = now; this.send({ t: 'ping' }); }
      if (this.lastMsg && now - this.lastMsg > TIMEOUT_MS) {
        this.conn._dead = true;
        try { this.conn.close(); } catch { /* ignore */ }
        this.conn = null;
        this.lost();
      }
    }
  },

  stop() {
    this.stopped = true;
    store.del('hz-joined', true);
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    clearInterval(this.ticker);
    if (this.conn) { this.conn._dead = true; try { this.conn.close(); } catch { /* ignore */ } }
    if (this.peer) { try { this.peer.destroy(); } catch { /* ignore */ } }
    this.conn = null;
    this.peer = null;
    this.joined = false;
    setNetBar(null);
  },
};

/* =====================================================================
   VIEW
   ===================================================================== */

const appEl = $('#app');

function header(extra = '') {
  return '<div class="top"><div class="logo">Hangimiz<span>?</span></div><div class="row">' + extra +
    '<button class="pill" data-act="mute" title="Ses">' + (Sound.muted ? '🔇' : '🔊') + '</button></div></div>';
}

function mount(html, wide = false) {
  appEl.classList.toggle('wide', wide);
  appEl.innerHTML = html;
  window.scrollTo(0, 0);
}

/* ---------- pre-game screens ---------- */

function showHome(err = '') {
  App.screenKey = 'home';
  mount(
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div>' +
    '<p>Herkes soru yazar, herkes oylar.<br>Sonunda kim ne çıktı, hep beraber görürsünüz!</p>' +
    '<div class="bubbles"><span>En zekimiz kim? 🧠</span><span>En yakışıklımız? 😎</span><span>İlk kim evlenir? 💍</span></div></div>' +
    '<div class="card">' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Tekin" value="' + esc(myName) + '">' +
      '<div style="height:12px"></div>' +
      '<button class="btn yellow big block" data-act="create">🎉 Oda Kur</button>' +
      '<div class="or">ya da arkadaşının odasına gir</div>' +
      '<div class="row"><input id="cd" class="field code grow" maxlength="' + CODE_LEN + '" placeholder="KOD" autocomplete="off" autocapitalize="characters">' +
      '<button class="btn" data-act="joinCode">Katıl</button></div>' +
      '<p class="err" id="err">' + esc(err) + '</p>' +
    '</div>' +
    '<div class="card"><h2>Nasıl oynanır?</h2><ol class="steps">' +
      '<li><b class="n">1</b><div><b>Oda kur, linki at.</b> Arkadaşların linke tıklayıp adını yazınca odaya girer.</div></li>' +
      '<li><b class="n">2</b><div><b>Soruları yaz.</b> Süre bitmeden herkes birkaç tane "Hangimiz…?" sorusu yazar.</div></li>' +
      '<li><b class="n">3</b><div><b>Oyla.</b> Bütün sorular herkese gelir, her soru için birini seçersin.</div></li>' +
      '<li><b class="n">4</b><div><b>Sonuçlar!</b> Her soru tek tek açılır, en sonda kim hangi unvanı kaptı görürsünüz. 🏆</div></li>' +
    '</ol></div>' +
    '<p class="foot">Oyun, odayı kuran kişinin tarayıcısında döner — o sayfayı kapatma 😉</p>'
  );
  $('#nm').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('create'); });
  $('#cd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('joinCode'); });
  if (!myName) setTimeout(() => $('#nm') && $('#nm').focus(), 50);
}

function showJoin(code, canRestore, err = '') {
  App.screenKey = 'join';
  App.code = code;
  mount(
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div><p>Seni bir odaya çağırdılar! 🎈</p></div>' +
    '<div class="card">' +
      '<div class="center muted" style="font-weight:700">Oda kodu</div>' +
      '<div class="center" style="font-size:44px;font-weight:800;letter-spacing:8px;color:var(--purple);line-height:1.1">' + esc(code) + '</div>' +
      '<div style="height:12px"></div>' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Naz" value="' + esc(myName) + '">' +
      '<div style="height:12px"></div>' +
      '<button class="btn yellow big block" data-act="join">Odaya Gir 🚪</button>' +
      '<p class="err" id="err">' + esc(err) + '</p>' +
      (canRestore ? '<div class="or">bu odayı sen kurmuştun</div><button class="btn ghost block" data-act="restore">👑 Odayı geri aç (lider olarak)</button>' : '') +
    '</div>' +
    '<p class="foot"><a href="' + esc(location.pathname) + '" style="color:#fff">Kendi odanı kurmak için tıkla</a></p>'
  );
  $('#nm').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('join'); });
  setTimeout(() => $('#nm') && $('#nm').focus(), 50);
}

function showConnecting(msg) {
  App.screenKey = 'connecting';
  mount(header() + '<div class="card center"><div class="spinner"></div><h2>' + esc(msg) + '</h2><p class="muted">Birkaç saniye sürebilir.</p></div>');
}

function showError(title, text, canRetry = false) {
  App.screenKey = 'error';
  mount(
    header() +
    '<div class="card center"><div class="big-emoji">😵‍💫</div><h2>' + esc(title) + '</h2><p class="muted">' + esc(text) + '</p>' +
    '<div class="ctrl">' +
      (canRetry ? '<button class="btn" data-act="retryJoin">Tekrar dene</button>' : '') +
      '<a class="btn ghost" href="' + esc(location.pathname) + '">Ana sayfa</a>' +
    '</div></div>'
  );
}

/* ---------- state → screen ---------- */

function onState(s) {
  const prev = App.state;
  App.state = s;
  myId = s.you;
  store.set('hz-id', myId, true);

  const dKey = s.phase + ':' + (s.roundId || '') + ':' + (s.reveal ? s.reveal.index : '');
  if (s.left == null) {
    App.deadline = null;
  } else {
    const d = Date.now() + s.left;
    if (App.deadlineKey !== dKey || !App.deadline || Math.abs(App.deadline - d) > 600) App.deadline = d;
  }
  App.deadlineKey = dKey;
  App.deadlineTotal = s.total || 0;

  if (prev && prev.phase === 'lobby' && s.phase === 'lobby' && s.players.length > prev.players.length) Sound.join();

  render();
}

function me() {
  const s = App.state;
  return s && s.players.find((p) => p.id === s.you);
}

function isHost() {
  return App.state && App.state.you === App.state.hostId;
}

function nameOf(id) {
  const s = App.state;
  if (s.names && s.names[id]) return s.names[id];
  return s.players.find((p) => p.id === id) || null;
}

function render() {
  const s = App.state;
  if (!s) return;
  const inRound = !!(s.roster && s.roster.includes(s.you));
  let screen = s.phase;
  if ((s.phase === 'writing' || s.phase === 'answering') && !inRound) screen = 'spectate';
  let key = screen + ':' + (s.roundId || '');
  if (screen === 'results') key += ':' + s.reveal.index;

  const fresh = key !== App.screenKey;
  App.screenKey = key;
  const view = Views[screen];
  if (fresh) view.mount(s);
  if (view.update) view.update(s);
}

const Views = {};

/* ---------- lobby ---------- */

Views.lobby = {
  mount() {
    mount(header('<button class="pill" data-act="leave">Çık</button>') + '<div id="lobby"></div>', true);
  },
  update(s) {
    const host = isHost();
    const link = roomLink(s.code);
    const online = s.players.filter((p) => p.connected).length;
    const meP = me();
    let startArea;
    if (host) {
      const canStart = online >= MIN_PLAYERS;
      startArea =
        '<button class="btn yellow big block" data-act="start" ' + (canStart ? '' : 'disabled') + '>🚀 Oyunu Başlat</button>' +
        '<div class="hint">' + (canStart
          ? (s.settings.startMode === 'ready' ? 'Herkes "Hazırım" deyince kendiliğinden başlar — ya da sen başlat.' : online + ' kişi hazır, başlatabilirsin!')
          : 'Başlamak için en az ' + MIN_PLAYERS + ' kişi lazım. Linki arkadaşlarına at!') + '</div>';
    } else if (s.settings.startMode === 'ready') {
      const r = meP && meP.ready;
      startArea = '<button class="btn ' + (r ? 'green' : 'yellow') + ' big block" data-act="ready">' + (r ? '✅ Hazırsın! (geri al)' : '🙋 Hazırım') + '</button>' +
        '<div class="hint">Herkes hazır olunca oyun başlar.</div>';
    } else {
      startArea = '<div class="waiting-pill">⏳ Liderin oyunu başlatması bekleniyor…</div>';
    }

    const players = s.players.map((p) => {
      const tags = [];
      if (p.id === s.hostId) tags.push('<span class="tag host">👑 Lider</span>');
      if (p.id === s.you) tags.push('<span class="tag">Sen</span>');
      if (s.settings.startMode === 'ready' && p.ready) tags.push('<span class="tag ok">Hazır</span>');
      if (!p.connected) tags.push('<span class="tag">Bağlantı yok</span>');
      const kick = host && p.id !== s.hostId ? '<button class="kick" data-act="kick" data-id="' + esc(p.id) + '" title="Odadan çıkar">✕</button>' : '';
      return '<div class="player ' + (p.connected ? '' : 'off') + '">' + avatarHTML(p) + '<span class="nm">' + esc(p.name) + '</span>' + tags.join('') + kick + '</div>';
    }).join('');

    $('#lobby').innerHTML =
      (s.notice ? '<div class="notice">' + esc(s.notice) + '</div>' : '') +
      '<div class="lobby-grid">' +
        '<div class="card span2"><div class="codebox"><div><div class="muted" style="font-weight:700">Oda kodu</div><div class="code">' + esc(s.code) + '</div></div>' +
          '<div class="lnk">' + esc(link) + '</div></div>' +
          '<div class="share-row">' +
            '<button class="btn small" data-act="copy">📋 Linki kopyala</button>' +
            (navigator.share ? '<button class="btn small yellow" data-act="share">📤 Paylaş</button>' : '') +
            '<a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('Hangimiz? oyununa gel! 🤔 ' + link) + '">WhatsApp</a>' +
          '</div></div>' +
        '<div class="card"><h2>Oyuncular <small>(' + online + ' kişi)</small></h2><div class="players">' + players + '</div></div>' +
        '<div class="card"><h2>Ayarlar ' + (host ? '' : '<small>(lider ayarlar)</small>') + '</h2>' + settingsHTML(s.settings, host) + '</div>' +
        '<div class="startbar span2">' + startArea + '</div>' +
      '</div>';
  },
};

function settingsHTML(set, editable) {
  return '<div class="settings">' + SETTING_DEFS.map((d) => {
    const v = set[d.key];
    let ctrl;
    if (d.type === 'num') {
      const txt = v === 0 && d.zero ? d.zero : v + ' ' + d.unit;
      ctrl = editable
        ? '<div class="stepper"><button data-act="set" data-k="' + d.key + '" data-d="-1" aria-label="azalt">−</button><span>' + esc(txt) + '</span>' +
          '<button data-act="set" data-k="' + d.key + '" data-d="1" aria-label="artır">+</button></div>'
        : '<b>' + esc(txt) + '</b>';
    } else if (d.type === 'bool') {
      ctrl = editable
        ? '<button class="switch ' + (v ? 'on' : '') + '" data-act="set" data-k="' + d.key + '" aria-pressed="' + v + '" aria-label="' + esc(d.label) + '"></button>'
        : '<b>' + (v ? 'Evet' : 'Hayır') + '</b>';
    } else {
      ctrl = editable
        ? '<div class="seg">' + d.options.map((o) => '<button class="' + (o[0] === v ? 'on' : '') + '" data-act="set" data-k="' + d.key + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>').join('') + '</div>'
        : '<b>' + esc((d.options.find((o) => o[0] === v) || d.options[0])[1]) + '</b>';
    }
    return '<div class="set"><span class="k">' + esc(d.label) + '</span>' + ctrl + '</div>';
  }).join('') + '</div>';
}

/* ---------- writing ---------- */

Views.writing = {
  mount(s) {
    App.wDone = false;
    const n = s.settings.qPerPlayer;
    const saved = (s.me && s.me.drafts) || [];
    const local = (App.wDrafts && App.wDrafts.roundId === s.roundId) ? App.wDrafts.list : [];
    const rows = [];
    for (let i = 0; i < n; i++) {
      const val = local[i] ?? saved[i] ?? '';
      rows.push('<div class="qrow"><span class="num">' + (i + 1) + '</span>' +
        '<input class="field q-input grow" data-i="' + i + '" maxlength="' + MAX_Q_LEN + '" placeholder="' + esc(placeholderFor(i)) + '" value="' + esc(val) + '" autocomplete="off">' +
        '<button class="dice" data-act="dice" data-i="' + i + '" title="Rastgele soru">🎲</button></div>');
    }
    mount(
      header() +
      timerHTML('Soru yazma süresi') +
      '<div class="phase-title"><h1>Sorularını yaz! ✍️</h1><p>"Hangimiz…?" diye sorulacak ' + n + ' soru yaz. Aklına gelmezse 🎲 bas.</p></div>' +
      '<div class="card" id="wcard"><div class="qlist">' + rows.join('') + '</div>' +
        '<div style="height:14px"></div><button class="btn green big block" data-act="wdone" id="wdone">✅ Bitti</button></div>' +
      '<div class="card"><h2>Kim kaç soru yazdı?</h2><div class="chips" id="wprog"></div></div>' +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Süreyi bitir</button></div>' : '')
    );
    App.wDrafts = { roundId: s.roundId, list: collectDrafts() };
    const first = $$('.q-input').find((x) => !x.value);
    if (first && window.matchMedia('(pointer:fine)').matches) first.focus();
  },
  update(s) {
    const n = s.settings.qPerPlayer;
    $('#wprog').innerHTML = s.roster.map((id) => {
      const p = nameOf(id);
      const live = s.players.find((x) => x.id === id);
      const done = s.writing.done[id];
      return '<span class="chip ' + (done ? 'done' : '') + (live && live.connected ? '' : ' off') + '">' + avatarHTML(p, 'sm') + esc(p.name) +
        ' <span class="cnt">' + (s.writing.counts[id] || 0) + '/' + n + (done ? ' ✓' : '') + '</span></span>';
    }).join('');
  },
};

function placeholderFor(i) {
  const ex = ['Örn: Grubun en zekisi kim?', 'Örn: En yakışıklı kim?', 'Örn: İlk kim evlenir?', 'Örn: En çok kim geç kalır?'];
  return ex[i % ex.length];
}

function collectDrafts() {
  return $$('.q-input').map((x) => x.value);
}

function queueDrafts(immediate = false) {
  if (!App.state || App.state.phase !== 'writing') return;
  App.wDrafts = { roundId: App.state.roundId, list: collectDrafts() };
  clearTimeout(App.draftTimer);
  const go = () => send({ t: 'drafts', list: App.wDrafts.list, done: App.wDone });
  if (immediate) go(); else App.draftTimer = setTimeout(go, 350);
}

function setWritingDone(done) {
  App.wDone = done;
  const card = $('#wcard');
  if (card) card.classList.toggle('locked', done);
  $$('.q-input').forEach((x) => { x.readOnly = done; });
  $$('.dice').forEach((x) => { x.disabled = done; });
  const b = $('#wdone');
  if (b) {
    b.className = 'btn big block ' + (done ? 'ghost' : 'green');
    b.textContent = done ? '✏️ Düzenle (diğerleri bekleniyor…)' : '✅ Bitti';
  }
  queueDrafts(true);
}

/* ---------- answering ---------- */

Views.answering = {
  mount(s) {
    const answered = new Set((s.me && s.me.answered) || []);
    if (App.ans && App.ans.roundId === s.roundId) for (const q of App.ans.answered) answered.add(q);
    App.ans = { roundId: s.roundId, answered, current: null, qDeadline: null };
    mount(
      header() +
      '<div id="gtimer"></div>' +
      '<div id="astage"></div>' +
      '<div class="card"><h2>Kim nerede?</h2><div class="chips" id="aprog"></div></div>' +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Oylamayı bitir, sonuçlara geç</button></div>' : '')
    );
    showNextQuestion();
  },
  update(s) {
    const total = s.questions.length;
    $('#aprog').innerHTML = s.roster.map((id) => {
      const p = nameOf(id);
      const live = s.players.find((x) => x.id === id);
      const c = s.progress[id] || 0;
      return '<span class="chip ' + (c >= total ? 'done' : '') + (live && live.connected ? '' : ' off') + '">' + avatarHTML(p, 'sm') + esc(p.name) +
        ' <span class="cnt">' + c + '/' + total + (c >= total ? ' ✓' : '') + '</span></span>';
    }).join('');
    // Host may have recorded answers we lost locally (e.g. after reconnect).
    if (s.me) {
      let changed = false;
      for (const q of s.me.answered) if (!App.ans.answered.has(q)) { App.ans.answered.add(q); changed = true; }
      if (changed && App.ans.current && App.ans.answered.has(App.ans.current)) showNextQuestion();
    }
  },
};

function showNextQuestion() {
  const s = App.state;
  const A = App.ans;
  // A delayed call can land after the host already moved on to results.
  if (!s || s.phase !== 'answering' || !A || A.roundId !== s.roundId || !$('#astage')) return;
  const total = s.questions.length;
  const idx = s.questions.findIndex((q) => !A.answered.has(q.id));
  const stage = $('#astage');
  if (idx === -1) {
    A.current = null;
    A.qDeadline = null;
    $('#gtimer').innerHTML = s.settings.answerTime > 0 ? timerHTML('Herkesin bitirmesi için kalan süre') : '';
    stage.innerHTML = '<div class="card center"><div class="big-emoji">🎉</div><h2>Hepsini cevapladın!</h2><p class="muted">Diğerleri bitirince sonuçlar başlayacak.</p></div>';
    return;
  }
  const q = s.questions[idx];
  A.current = q.id;
  const per = s.settings.answerTime;
  A.qDeadline = per > 0 ? Date.now() + per * 1000 : null;
  A.qTotal = per * 1000;
  $('#gtimer').innerHTML = per > 0 ? timerHTML('Bu soru için kalan süre', 'q') : '';
  const by = q.by ? nameOf(q.by) : null;
  const options = s.roster.filter((id) => s.settings.selfVote || id !== s.you);
  stage.innerHTML =
    '<div class="card qcard"><div class="meta">Soru ' + (A.answered.size + 1) + ' / ' + total + '</div>' +
      '<div class="minibar"><i style="width:' + (A.answered.size / total * 100) + '%"></i></div>' +
      '<div class="qtext">' + esc(q.text) + '</div>' +
      (by ? '<div class="by">' + esc(by.av) + ' ' + esc(by.name) + ' sordu</div>' : '') +
    '</div>' +
    '<div class="choices">' + options.map((id) => {
      const p = nameOf(id);
      return '<button class="choice" data-act="vote" data-id="' + esc(id) + '">' + avatarHTML(p) + '<span class="nm">' + esc(p.name) + '</span></button>';
    }).join('') + '</div>' +
    '<div class="skip-row"><button class="btn small ghost" data-act="vote" data-id="">🤷 Pas geç</button></div>';
  App.lastSecond = null;
  updateTimers();
}

function castVote(target, btn) {
  const A = App.ans;
  if (!A || !A.current) return;
  const qid = A.current;
  A.current = null;
  A.answered.add(qid);
  send({ t: 'vote', qid, target: target || null });
  Sound.click();
  if (btn) btn.classList.add('picked');
  setTimeout(showNextQuestion, btn ? 220 : 0);
}

/* ---------- spectating (joined mid-round) ---------- */

Views.spectate = {
  mount() {
    mount(header() + timerHTML('Tur bitimine kalan') +
      '<div class="card center"><div class="big-emoji">🙈</div><h2>Tur başlamış!</h2><p class="muted">Bu turda izleyicisin. Sonuçları birlikte görürsünüz, bir sonraki turda sen de oynarsın.</p></div>' +
      '<div class="card"><h2>Bu turda oynayanlar</h2><div class="chips" id="sprog"></div></div>');
  },
  update(s) {
    $('#sprog').innerHTML = s.roster.map((id) => {
      const p = nameOf(id);
      return '<span class="chip">' + avatarHTML(p, 'sm') + esc(p.name) + '</span>';
    }).join('');
  },
};

/* ---------- results ---------- */

Views.results = {
  mount(s) {
    const R = s.reveal;
    const it = R.item;
    const by = it.by ? nameOf(it.by) : null;
    const dots = Array.from({ length: R.total }, (_, i) => '<i class="' + (i <= R.index ? 'on' : '') + '"></i>').join('');
    let body;
    if (!it.total) {
      body = '<div class="center" style="margin-top:16px"><div class="big-emoji">🤷</div><b>Bu soruya kimse oy vermedi!</b></div>';
    } else {
      const max = it.bars[0].count;
      body = '<div class="bars">' + it.bars.map((b) => {
        const p = nameOf(b.id);
        const win = it.winners.includes(b.id);
        const pct = Math.round(b.count / it.total * 100);
        const voters = b.voters && b.voters.length ? '<div class="voters">' + b.voters.map((v) => esc(nameOf(v).name)).join(', ') + '</div>' : '';
        return '<div class="barrow ' + (win ? 'win' : '') + '">' + avatarHTML(p) + '<div class="body">' +
          '<div class="top2"><span class="nm">' + (win ? '<span class="crown">👑</span> ' : '') + esc(p.name) + '</span><span>' + b.count + ' oy · %' + pct + '</span></div>' +
          '<div class="track"><i style="--c:' + esc(p.col) + '" data-w="' + (b.count / max * 100) + '"></i></div>' + voters +
        '</div></div>';
      }).join('') + '</div>';
      const names = it.winners.map((id) => nameOf(id).name);
      body += '<div class="winline">' + (names.length > 1 ? '🤝 Berabere: ' + esc(names.join(' & ')) : '🏆 ' + esc(names[0]) + '!') + '</div>';
    }
    const last = R.index >= R.total - 1;
    const auto = s.settings.revealMode === 'auto';
    let ctrl = '';
    if (isHost()) {
      ctrl = '<div class="ctrl">' +
        (R.index > 0 ? '<button class="btn ghost" data-act="prev">◀ Geri</button>' : '') +
        '<button class="btn yellow big" data-act="next">' + (last ? '🏆 İstatistikleri gör' : 'Sonraki ▶') + '</button></div>';
    } else if (!auto) {
      ctrl = '<div class="waiting-pill">Lider bir sonrakine geçecek…</div>';
    }
    mount(
      header() +
      '<div class="phase-title"><h1>Sonuçlar 📊</h1></div>' +
      '<div class="dots">' + dots + '</div>' +
      (auto ? timerHTML(last ? 'İstatistiklere geçiliyor' : 'Sonraki soruya') : '') +
      '<div class="card rescard" id="rescard"><div class="meta">Soru ' + (R.index + 1) + ' / ' + R.total + '</div>' +
        '<div class="qtext">' + esc(it.text) + '</div>' +
        (by ? '<div class="meta">' + esc(by.av) + ' ' + esc(by.name) + ' sordu</div>' : '') +
        body +
      '</div>' + ctrl
    );
    // setTimeout (not rAF) so it also runs while the tab is in the background.
    setTimeout(() => {
      $$('.track i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
      const card = $('#rescard');
      if (card) card.classList.add('revealed');
    }, 60);
    Sound.click();
    if (it.total) setTimeout(() => Sound.beep(988, 0.15, 'triangle', 0.08), 1150);
  },
};

/* ---------- final ---------- */

Views.final = {
  mount(s) {
    const F = s.final;
    const top = F.ranking.slice(0, 3);
    const podOrder = [top[1], top[0], top[2]];
    const podClass = ['p2', 'p1', 'p3'];
    const podium = podOrder.map((id, i) => {
      if (!id) return '<div class="pod"></div>';
      const p = nameOf(id);
      const place = podClass[i].slice(1);
      return '<div class="pod ' + podClass[i] + '">' + avatarHTML(p, 'lg') + '<div class="name">' + esc(p.name) + '</div>' +
        '<div class="sub">' + F.titles[id].length + ' unvan · ' + F.votes[id] + ' oy</div><div class="block">' + place + '</div></div>';
    }).join('');

    const titles = F.ranking.map((id) => {
      const p = nameOf(id);
      const list = F.titles[id];
      const chips = list.length
        ? list.map((t) => '<span class="tchip">' + esc(t.text) + ' <b>' + t.count + '/' + t.total + '</b></span>').join('')
        : '<span class="muted">Hiç unvan kazanamadı 🥲</span>';
      return '<div class="trow">' + avatarHTML(p) + '<div class="body"><div class="nm">' + esc(p.name) + ' <small>· toplam ' + F.votes[id] + ' oy</small></div><div class="tchips">' + chips + '</div></div></div>';
    }).join('');

    const lead = F.ranking[0];
    const champs = F.ranking.filter((id) => F.titles[id].length === F.titles[lead].length && F.votes[id] === F.votes[lead]);
    const champ = nameOf(lead);
    const headline = champs.length > 1
      ? '<h1>🤝 Berabere!</h1><p>' + esc(champs.map((id) => nameOf(id).name).join(' & ')) + ' eşit unvan ve oy topladı.</p>'
      : '<h1>' + esc(champ.av) + ' ' + esc(champ.name) + ' kazandı!</h1><p>En çok unvanı kapan o oldu.</p>';
    const stats = [
      ['❓', F.questionCount, 'soru soruldu'],
      ['🗳️', F.totalVotes, 'oy verildi'],
    ];
    if (F.topWriters && F.topWriters.length) stats.push(['✍️', F.topWriters.map((id) => nameOf(id).name).join(' & '), 'en çok soru yazan (' + F.topWriterCount + ')']);
    stats.push(['🤝', F.unanimous.length, 'soruda herkes aynı kişiyi seçti']);

    const recap = F.recap.map((r) => {
      const w = r.winners.length ? r.winners.map((id) => nameOf(id).name).join(' & ') : '—';
      return '<div><span class="q">' + esc(r.text) + '</span><span class="w">' + esc(w) + (r.total ? ' <span class="muted">(' + r.top + '/' + r.total + ')</span>' : '') + '</span></div>';
    }).join('');

    const unanimous = F.unanimous.length
      ? '<div class="card"><h2>Herkes hemfikir 🤝</h2><div class="tchips">' + F.unanimous.map((u) => '<span class="tchip">' + esc(u.text) + ' → <b>' + esc(nameOf(u.id).name) + '</b></span>').join('') + '</div></div>'
      : '';

    mount(
      header() +
      '<div class="phase-title">' + headline + '</div>' +
      '<div class="podium">' + podium + '</div>' +
      '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Unvanlar 🏅</h2><div class="titles">' + titles + '</div></div>' +
      '<div class="card"><h2>Sayılarla bu tur</h2><div class="stats">' + stats.map((x) => '<div class="stat"><div class="v">' + esc(x[0]) + ' ' + esc(x[1]) + '</div><div class="l">' + esc(x[2]) + '</div></div>').join('') + '</div></div>' +
      unanimous +
      '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
      (isHost()
        ? '<div class="startbar"><button class="btn yellow big block" data-act="lobby">🔁 Yeni tur (lobiye dön)</button></div>'
        : '<div class="waiting-pill">Lider yeni tur başlatabilir 🔁</div>'),
      true
    );
    confetti();
    Sound.fanfare();
  },
};

function confetti() {
  const box = document.createElement('div');
  box.className = 'confetti';
  const cols = ['#ffcc2e', '#ff4f9a', '#22c870', '#6c3cf0', '#4fc3ff', '#fff'];
  for (let i = 0; i < 90; i++) {
    const c = document.createElement('i');
    c.style.left = Math.random() * 100 + '%';
    c.style.background = cols[i % cols.length];
    c.style.animationDuration = 2.2 + Math.random() * 2.2 + 's';
    c.style.animationDelay = Math.random() * 0.8 + 's';
    c.style.transform = 'rotate(' + Math.random() * 360 + 'deg)';
    box.appendChild(c);
  }
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 5500);
}

/* ---------- timers ---------- */

function timerHTML(label, kind = 'phase') {
  return '<div class="timer" data-kind="' + kind + '"><div class="t">–</div><div class="grow" style="flex:1"><div class="bar"><i style="width:100%"></i></div><div class="lbl2">' + esc(label) + '</div></div></div>';
}

function updateTimers() {
  const now = Date.now();
  for (const el of $$('.timer')) {
    let end, total;
    if (el.dataset.kind === 'q') {
      end = App.ans && App.ans.qDeadline;
      total = App.ans && App.ans.qTotal;
    } else {
      end = App.deadline;
      total = App.deadlineTotal;
    }
    const t = el.querySelector('.t');
    const bar = el.querySelector('.bar i');
    if (!end) { t.textContent = '∞'; bar.style.width = '100%'; t.classList.remove('hurry'); continue; }
    const left = Math.max(0, end - now);
    const sec = Math.ceil(left / 1000);
    t.textContent = sec;
    t.classList.toggle('hurry', sec <= 5);
    bar.style.width = (total ? Math.min(100, left / total * 100) : 0) + '%';
  }

  // Ticking sound for the last seconds of the phase that matters to me.
  const s = App.state;
  if (s && (s.phase === 'writing' || s.phase === 'answering')) {
    const end = s.phase === 'answering' ? (App.ans && App.ans.qDeadline) : App.deadline;
    if (end) {
      const sec = Math.ceil(Math.max(0, end - now) / 1000);
      if (sec !== App.lastSecond && sec <= 5 && sec > 0) Sound.tick();
      App.lastSecond = sec;
    }
  }

  // Writing: flush drafts right when time runs out.
  if (s && s.phase === 'writing' && App.deadline && now >= App.deadline && App.flushedRound !== s.roundId) {
    App.flushedRound = s.roundId;
    queueDrafts(true);
  }

  // Answering: per-question time limit → auto pass.
  if (s && s.phase === 'answering' && App.ans && App.ans.current && App.ans.qDeadline && now >= App.ans.qDeadline) {
    castVote(null, null);
  }
}
setInterval(updateTimers, 200);

/* =====================================================================
   ACTIONS
   ===================================================================== */

function readName() {
  const el = $('#nm');
  const name = cleanName(el ? el.value : '');
  if (!name) {
    $('#err').textContent = 'Önce adını yaz 🙂';
    if (el) el.focus();
    return null;
  }
  myName = name;
  store.set('hz-name', name);
  return name;
}

const actions = {
  create() {
    const name = readName();
    if (!name) return;
    Host.create(name, newRoomCode());
  },
  joinCode() {
    const code = cleanCode($('#cd').value);
    if (code.length !== CODE_LEN) { $('#err').textContent = 'Oda kodu ' + CODE_LEN + ' harfli olmalı.'; return; }
    const name = readName();
    if (!name) return;
    Client.start(code, name);
  },
  join() {
    const name = readName();
    if (!name) return;
    Client.start(App.code, name);
  },
  restore() {
    const rec = store.get('hz-host');
    if (rec && rec.code === App.code) Host.resume(rec);
  },
  retryJoin() {
    if (myName && App.code) Client.start(App.code, myName);
    else location.reload();
  },
  leave() {
    if (App.role === 'host') {
      if (!confirm('Odayı kapatırsan herkes oyundan düşer. Emin misin?')) return;
      store.del('hz-host');
      store.del('hz-hosting', true);
      location.href = location.pathname;
      return;
    }
    send({ t: 'leave' });
    setTimeout(() => { Client.stop(); location.href = location.pathname; }, 150);
  },
  mute(el) {
    Sound.toggle();
    el.textContent = Sound.muted ? '🔇' : '🔊';
  },
  copy() {
    const link = roomLink(App.state.code);
    const done = () => toast('Link kopyalandı! Arkadaşlarına yapıştır 📋');
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(link).then(done, () => fallbackCopy(link, done));
    } else fallbackCopy(link, done);
  },
  share() {
    navigator.share({ title: 'Hangimiz?', text: 'Hangimiz? oyununa gel! 🤔', url: roomLink(App.state.code) }).catch(() => {});
  },
  set(el) {
    const s = App.state;
    const def = SETTING_DEFS.find((d) => d.key === el.dataset.k);
    if (!def) return;
    const next = { ...s.settings };
    if (def.type === 'num') next[def.key] = s.settings[def.key] + Number(el.dataset.d) * def.step;
    else if (def.type === 'bool') next[def.key] = !s.settings[def.key];
    else next[def.key] = el.dataset.v;
    send({ t: 'settings', settings: next });
  },
  start() { send({ t: 'start' }); },
  ready() { const m = me(); send({ t: 'ready', v: !(m && m.ready) }); },
  kick(el) {
    const p = App.state.players.find((x) => x.id === el.dataset.id);
    if (p && confirm(p.name + ' odadan çıkarılsın mı?')) send({ t: 'kick', id: p.id });
  },
  dice(el) {
    const i = Number(el.dataset.i);
    const input = $('.q-input[data-i="' + i + '"]');
    const taken = new Set(collectDrafts().map(lower));
    const pool = RANDOM_QUESTIONS.filter((q) => !taken.has(lower(q)));
    input.value = (pool.length ? pool : RANDOM_QUESTIONS)[Math.floor(Math.random() * (pool.length || RANDOM_QUESTIONS.length))];
    Sound.click();
    queueDrafts();
  },
  wdone() {
    setWritingDone(!App.wDone);
  },
  skip() { send({ t: 'skip' }); },
  vote(el) { castVote(el.dataset.id, el); },
  next() { send({ t: 'next' }); },
  prev() { send({ t: 'prev' }); },
  lobby() { send({ t: 'lobby' }); },
};

function fallbackCopy(text, done) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); done(); } catch { prompt('Linki kopyala:', text); }
  ta.remove();
}

function doAction(name, el) {
  const fn = actions[name];
  if (fn) fn(el);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  doAction(el.dataset.act, el);
});

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('q-input')) queueDrafts();
  if (e.target.id === 'cd') e.target.value = cleanCode(e.target.value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.classList.contains('q-input')) {
    e.preventDefault();
    const next = $('.q-input[data-i="' + (Number(e.target.dataset.i) + 1) + '"]');
    if (next) next.focus(); else e.target.blur();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (App.role === 'client') Client.retryNow();
  if (App.role === 'host' && Host.peer && Host.peer.disconnected && !Host.peer.destroyed) {
    try { Host.peer.reconnect(); } catch { /* retried by the disconnected handler */ }
  }
});

window.addEventListener('beforeunload', (e) => {
  if (App.role === 'host' && Host.S && Host.S.order.length > 1) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* =====================================================================
   BOOT
   ===================================================================== */

(function boot() {
  if (typeof Peer === 'undefined') {
    showError('Oyun yüklenemedi 😕', 'Sayfayı yenilemeyi dene.');
    return;
  }
  const params = new URLSearchParams(location.search);
  const code = cleanCode(params.get('oda'));
  const rec = store.get('hz-host');
  const recOk = !!(code && rec && rec.code === code && Date.now() - rec.t < HOST_RECORD_MAX_AGE);
  if (code.length === CODE_LEN) {
    if (recOk && store.get('hz-hosting', true) === code) { Host.resume(rec); return; }
    const joined = store.get('hz-joined', true);
    if (joined && joined.code === code && cleanName(joined.name)) { Client.start(code, cleanName(joined.name)); return; }
    showJoin(code, recOk);
  } else {
    showHome();
  }
})();
