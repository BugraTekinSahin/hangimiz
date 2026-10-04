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

// Settings shared by every game.
const COMMON_DEFS = [
  { key: 'startMode', label: 'Oyunu kim başlatır?', type: 'choice', def: 'host', options: [['host', 'Lider'], ['ready', 'Herkes hazır olunca']] },
  { key: 'revealMode', label: 'Sonuçları kim geçirir?', type: 'choice', def: 'host', options: [['host', 'Lider'], ['auto', 'Otomatik']] },
];

// Every game uses the same flow: write → answer → reveal results → final stats.
// writeTime / qPerPlayer / answerTime drive that flow, so each game defines them.
const GAMES = {
  hangimiz: {
    name: 'Hangimiz?',
    emoji: '🤔',
    desc: 'Herkes "Hangimiz…?" soruları yazar, herkes oylar. En zekimiz kim, en yakışıklımız kim?',
    minPlayers: 2,
    defs: [
      { key: 'writeTime', label: 'Soru yazma süresi', type: 'num', def: 20, min: 10, max: 180, step: 5, unit: 'sn' },
      { key: 'qPerPlayer', label: 'Kişi başı soru', type: 'num', def: 4, min: 1, max: 8, step: 1, unit: 'soru' },
      { key: 'answerTime', label: 'Soru başına cevap süresi', type: 'num', def: 10, min: 0, max: 60, step: 5, unit: 'sn', zero: 'Sınırsız' },
      { key: 'selfVote', label: 'Kendine oy verebilsin', type: 'bool', def: true },
      { key: 'showAuthor', label: 'Soruyu kimin yazdığı görünsün', type: 'bool', def: false },
      { key: 'showVoters', label: 'Kim kime oy verdi görünsün', type: 'bool', def: false },
    ],
  },
  kimyazdi: {
    name: 'Kim Yazdı?',
    emoji: '🕵️',
    desc: 'Herkes kendisi hakkında gizli bir şey yazar. Kimin yazdığını bilen puanı kapar!',
    minPlayers: 3,
    defs: [
      { key: 'writeTime', label: 'Yazma süresi', type: 'num', def: 45, min: 15, max: 180, step: 5, unit: 'sn' },
      { key: 'qPerPlayer', label: 'Kişi başı itiraf', type: 'num', def: 2, min: 1, max: 4, step: 1, unit: 'tane' },
      { key: 'answerTime', label: 'İtiraf başına tahmin süresi', type: 'num', def: 15, min: 0, max: 60, step: 5, unit: 'sn', zero: 'Sınırsız' },
    ],
  },
  asla: {
    name: 'Asla Yapmadım',
    emoji: '🙊',
    desc: 'Herkes "Hiç … yapmadım" cümleleri yazar. Kim yapmış, kim yapmamış hep beraber görürsünüz!',
    minPlayers: 2,
    defs: [
      { key: 'writeTime', label: 'Yazma süresi', type: 'num', def: 30, min: 10, max: 180, step: 5, unit: 'sn' },
      { key: 'qPerPlayer', label: 'Kişi başı cümle', type: 'num', def: 3, min: 1, max: 6, step: 1, unit: 'tane' },
      { key: 'answerTime', label: 'Cümle başına cevap süresi', type: 'num', def: 8, min: 0, max: 60, step: 2, unit: 'sn', zero: 'Sınırsız' },
      { key: 'showVoters', label: 'Kimin yaptığı görünsün', type: 'bool', def: true },
      { key: 'showAuthor', label: 'Cümleyi kimin yazdığı görünsün', type: 'bool', def: false },
    ],
  },
  komik: {
    name: 'Komik Cevap',
    emoji: '😂',
    desc: 'Herkese aynı boşluk doldurmalı sorular gelir. Cevaplar isimsiz oylanır, en komik olan puanı kapar!',
    minPlayers: 3,
    defs: [
      { key: 'source', label: 'Soruları kim yazsın?', type: 'choice', def: 'own', options: [['own', 'Biz yazalım'], ['bank', 'Hazır sorular']] },
      { key: 'promptTime', label: 'Soru yazma süresi', type: 'num', def: 30, min: 10, max: 120, step: 5, unit: 'sn', showIf: (c) => c.source === 'own' },
      { key: 'ownCount', label: 'Kişi başı soru', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'soru', showIf: (c) => c.source === 'own' },
      { key: 'qPerPlayer', label: 'Soru sayısı', type: 'num', def: 3, min: 1, max: 5, step: 1, unit: 'soru', showIf: (c) => c.source === 'bank' },
      { key: 'writeTime', label: 'Cevap yazma süresi', type: 'num', def: 60, min: 20, max: 240, step: 10, unit: 'sn' },
      { key: 'answerTime', label: 'Soru başına oylama süresi', type: 'num', def: 20, min: 0, max: 60, step: 5, unit: 'sn', zero: 'Sınırsız' },
      { key: 'showVoters', label: 'Kim kime oy verdi görünsün', type: 'bool', def: true },
    ],
  },
  yalanci: {
    name: 'Yalancıyı Bul',
    emoji: '🤥',
    desc: 'Birinin gizli kelimesi farklı ama kendisi bile bilmiyor! Sırayla ipucu verin, yalancıyı yakalayın.',
    minPlayers: 3,
    hideCommon: ['revealMode'],
    defs: [
      { key: 'category', label: 'Kategori', type: 'choice', def: 'mix', options: [['mix', 'Karışık'], ['yer', 'Yerler'], ['yemek', 'Yiyecekler'], ['hayvan', 'Hayvanlar'], ['meslek', 'Meslekler'], ['esya', 'Eşyalar'], ['hobi', 'Spor & Hobi']] },
      { key: 'clueRounds', label: 'İpucu turu', type: 'num', def: 2, min: 1, max: 3, step: 1, unit: 'tur' },
      { key: 'clueTime', label: 'İpucu süresi', type: 'num', def: 30, min: 10, max: 90, step: 5, unit: 'sn' },
      { key: 'voteTime', label: 'Oylama süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
      { key: 'liarKnows', label: 'Yalancı kendini bilsin', type: 'bool', def: false },
      { key: 'showCategory', label: 'Yalancı kategoriyi görsün', type: 'bool', def: true, showIf: (c) => c.liarKnows },
    ],
  },
};
const GAME_ORDER = ['hangimiz', 'kimyazdi', 'asla', 'komik', 'yalanci'];
const COMING_SOON = [];

const LIE_ROLE_MS = 20000;      // time to read the secret card
const LIE_CATCH_POINTS = 100;   // per player who voted for the liar
const LIE_ESCAPE_POINTS = 200;  // liar not caught
const LIE_GUESS_POINTS = 100;   // liar guessed the word
const LIE_MAX_CLUE = 40;

// Pairs of similar words. When the liar doesn't know their role, they get the partner word.
const LIE_WORDS = {
  yer: { name: 'Yerler', pairs: [['Plaj', 'Havuz'], ['Hastane', 'Eczane'], ['Okul', 'Kütüphane'], ['Sinema', 'Tiyatro'], ['Havalimanı', 'Tren garı'], ['Süpermarket', 'Pazar yeri'], ['Hayvanat bahçesi', 'Akvaryum'], ['Lunapark', 'Su parkı'], ['Restoran', 'Kafe'], ['Kamp alanı', 'Orman'], ['Müze', 'Sanat galerisi'], ['Spor salonu', 'Stadyum'], ['Gemi', 'Denizaltı'], ['Kale', 'Saray'], ['Çiftlik', 'Köy'], ['Otel', 'Pansiyon'], ['Banka', 'Postane'], ['Uzay istasyonu', 'Ay'], ['Düğün salonu', 'Doğum günü partisi']] },
  yemek: { name: 'Yiyecekler', pairs: [['Pizza', 'Lahmacun'], ['Mantı', 'Ravioli'], ['Sushi', 'Balık'], ['Hamburger', 'Tost'], ['Baklava', 'Künefe'], ['Dondurma', 'Puding'], ['Döner', 'İskender'], ['Kumpir', 'Patates kızartması'], ['Menemen', 'Omlet'], ['Simit', 'Poğaça'], ['Pilav', 'Makarna'], ['Patlamış mısır', 'Cips'], ['Çikolata', 'Gofret'], ['Karpuz', 'Kavun'], ['Köfte', 'Sucuk'], ['Waffle', 'Krep'], ['Çorba', 'Güveç']] },
  hayvan: { name: 'Hayvanlar', pairs: [['Kedi', 'Köpek'], ['Penguen', 'Fok'], ['Zürafa', 'Deve'], ['Fil', 'Gergedan'], ['Aslan', 'Kaplan'], ['Yunus', 'Balina'], ['Kartal', 'Şahin'], ['Tavşan', 'Sincap'], ['Kaplumbağa', 'Kurbağa'], ['Ahtapot', 'Denizanası'], ['Maymun', 'Goril'], ['Timsah', 'Kertenkele'], ['Baykuş', 'Yarasa'], ['Arı', 'Sinek'], ['At', 'Eşek'], ['Panda', 'Koala']] },
  meslek: { name: 'Meslekler', pairs: [['Doktor', 'Hemşire'], ['Öğretmen', 'Müdür'], ['Aşçı', 'Garson'], ['Pilot', 'Hostes'], ['Polis', 'Asker'], ['İtfaiyeci', 'Cankurtaran'], ['Astronot', 'Bilim insanı'], ['Berber', 'Kuaför'], ['Futbolcu', 'Basketbolcu'], ['YouTuber', 'TikTokçu'], ['Avukat', 'Hakim'], ['Ressam', 'Heykeltıraş'], ['Dişçi', 'Göz doktoru'], ['Taksici', 'Otobüs şoförü'], ['Çiftçi', 'Çoban'], ['Mühendis', 'Mimar'], ['Postacı', 'Kargocu'], ['Sihirbaz', 'Palyaço']] },
  esya: { name: 'Eşyalar', pairs: [['Telefon', 'Tablet'], ['Şemsiye', 'Yağmurluk'], ['Diş fırçası', 'Tarak'], ['Kulaklık', 'Hoparlör'], ['Gözlük', 'Lens'], ['Saat', 'Bileklik'], ['Sırt çantası', 'Valiz'], ['Anahtar', 'Kilit'], ['Yastık', 'Battaniye'], ['Ayna', 'Pencere'], ['Makas', 'Bıçak'], ['Kumanda', 'Joystick'], ['Mum', 'El feneri'], ['Termos', 'Matara'], ['Bisiklet', 'Scooter'], ['Kamera', 'Dürbün'], ['Şarj aleti', 'Powerbank'], ['Tava', 'Tencere'], ['Balon', 'Uçurtma']] },
  hobi: { name: 'Spor & Hobi', pairs: [['Futbol', 'Hentbol'], ['Basketbol', 'Voleybol'], ['Yüzme', 'Dalış'], ['Satranç', 'Dama'], ['Kayak', 'Snowboard'], ['Bowling', 'Bilardo'], ['Gitar çalmak', 'Piyano çalmak'], ['Resim yapmak', 'Fotoğraf çekmek'], ['Kamp yapmak', 'Piknik'], ['Dans', 'Jimnastik'], ['Boks', 'Güreş'], ['Tenis', 'Badminton'], ['Okçuluk', 'Dart'], ['Yoga', 'Pilates'], ['Balık tutmak', 'Kürek çekmek'], ['Kaykay', 'Paten'], ['Örgü örmek', 'Dikiş dikmek'], ['Dağcılık', 'Doğa yürüyüşü']] },
};

const KOMIK_VOTE_POINTS = 100;   // per vote your answer gets
const KOMIK_SWEEP_BONUS = 100;   // everyone who voted picked your answer

const KOMIK_PROMPTS = [
  'Okulda yasaklanması gereken şey: ___',
  'Bir süper kahramanın en işe yaramaz gücü: ___',
  'Annemin telefonda en çok söylediği cümle: ___',
  'Bir uzaylı Dünya\'ya gelse ilk şaşıracağı şey: ___',
  'İlk buluşmada asla söylenmemesi gereken cümle: ___',
  'Kedimin gizli mesleği: ___',
  'Bir restoran için en kötü isim: ___',
  'WhatsApp grubundaki en gereksiz mesaj: ___',
  'Ünlü olsam ilk yapacağım saçma şey: ___',
  'Bir korku filmi için en komik isim: ___',
  'Öğretmenin "Bugün ders yok" demesinin gerçek sebebi: ___',
  'Bir parfüme verilebilecek en kötü isim: ___',
  'Zombi kıyametinde yanıma alacağım tek eşya: ___',
  'Robotların isyan etmesinin gerçek sebebi: ___',
  'Asla dondurma olmaması gereken tat: ___',
  'Babamın her soruna bulduğu çözüm: ___',
  'Bir uygulamanın gönderebileceği en saçma bildirim: ___',
  'Tarih kitaplarında yazmayan bir icat: ___',
  'Olimpiyatlara eklenmesi gereken yeni spor: ___',
  'Dünyanın en sıkıcı YouTube videosunun başlığı: ___',
  'Bir köpeğin günlüğüne yazdığı ilk cümle: ___',
  'Hayatımın filmi olsa adı: ___',
  'Bir oyundaki en saçma son boss: ___',
  'Sınavda çıkabilecek en saçma soru: ___',
  'Bir ninjanın asla yapmaması gereken şey: ___',
  'Aşçı olsam imza yemeğim: ___',
  'Bir masalın en kötü sonu: ___',
  'Bir otobüs şoförünün gizli süper gücü: ___',
  'Çok zengin olsam alacağım en gereksiz şey: ___',
  'Pizzanın üstüne asla konmaması gereken şey: ___',
  'Bir otel için yazılmış en kötü yorum: ___',
  'Bir şarkıdaki en saçma söz: ___',
  'Uzaya giderken çantama koyacağım ilk şey: ___',
  'Bir ayakkabı markasının en kötü sloganı: ___',
  'Dünyanın en gereksiz meslek unvanı: ___',
  'Okul servisinde yaşanabilecek en garip olay: ___',
  'Bir penguenin en büyük derdi: ___',
  'Bu grubun gizli marşının adı: ___',
  'Yapay zekânın bana söylediği en tuhaf şey: ___',
  'Bir dedektifin en kötü ipucu: ___',
  'Annemin "Ben senin yaşındayken…" diye başlayıp anlattığı şey: ___',
  'Telefonumun şarjı biterse olacak en kötü şey: ___',
];

const ASLA_STATEMENTS = [
  'Hiç uçağa binmedim',
  'Hiç okuldan kaçmadım',
  'Hiç öğretmene yanlışlıkla "anne" demedim',
  'Hiç sabaha kadar oyun oynamadım',
  'Hiç telefonumu tuvalete düşürmedim',
  'Hiç bir mesajı görüp bilerek cevapsız bırakmadım',
  'Hiç sınavda kopya çekmedim',
  'Hiç yanlış kişiye mesaj atmadım',
  'Hiç ünlü birine DM atmadım',
  'Hiç kendi kendime konuşurken yakalanmadım',
  'Hiç saçımı kendim kesmedim',
  'Hiç yere düşen bir şeyi "5 saniye kuralı" deyip yemedim',
  'Hiç ailemden gizli bir şey satın almadım',
  'Hiç sinirden klavyeye ya da kumandaya vurmadım',
  'Hiç derste uyuyakalmadım',
  'Hiç otobüste durağımı kaçırmadım',
  'Hiç hasta numarası yapıp evde kalmadım',
  'Hiç birinin adını unutup "kanka" diye idare etmedim',
  'Hiç eski sevgilimin profiline gizlice bakmadım',
  'Hiç bir şarkıyı üst üste 20 kere dinlemedim',
  'Hiç bir arkadaşımın sırrını başkasına söylemedim',
  'Hiç tek başıma sinemaya gitmedim',
  'Hiç gece yarısı buzdolabı baskını yapmadım',
  'Hiç sesli mesajı 2x hızda dinlemedim',
  'Hiç ödevimi başkasından kopyalamadım',
  'Hiç bana sallanmayan bir ele el sallamadım',
  'Hiç bir selfie için 20 fotoğraf çekmedim',
  'Hiç ciddi bir anda gülmemi tutamayıp rezil olmadım',
  'Hiç bir diziyi tek gecede bitirmedim',
  'Hiç aynada kendi kendime konuşma provası yapmadım',
  'Hiç yalan söyleyip yakalanmadım',
  'Hiç bir böcekten korkup çığlık atmadım',
];

const KY_CORRECT_POINTS = 100;   // guessing the author right
const KY_FOOL_POINTS = 50;       // author, per player who guessed someone else

const KY_STARTERS = [
  'Kimse bilmez ama ben ',
  'Çocukken ',
  'Hiç kimseye söylemedim ama ',
  'En garip alışkanlığım: ',
  'Gizli yeteneğim: ',
  'En utandığım an: ',
  'Bir keresinde ',
  'Hâlâ korkuyorum: ',
  'Küçükken olmak istediğim meslek: ',
  'Hiç sevmediğim bir yemek: ',
  'Ünlü biriyle ilgili anım: ',
  'Hâlâ inanıyorum ki ',
  'Okulda ',
  'İlk aşkım ',
  'En son ağladığım şey: ',
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
      game: GAMES[store.get('hz-game')] ? store.get('hz-game') : 'hangimiz',
      settings: sanitizeSettingsTree(store.get('hz-settings')),
      players: {},
      order: [],
      round: null,
      notice: null,
    };
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
    // Rooms saved by an older version of the page had a single flat settings object.
    S.settings = sanitizeSettingsTree(S.settings);
    if (!GAMES[S.game]) S.game = 'hangimiz';
    if (S.round && !S.round.game) {
      S.round.game = 'hangimiz';
      S.round.cfg = mergedSettings(S.settings, 'hangimiz');
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
        if (r.game === 'komik' && r.stage === 'prompts') {
          r.drafts[pid] = sanitizeDrafts(msg.list, r.cfg.ownCount);
        } else if (r.game === 'komik') {
          // Answer i belongs to prompt i; nobody answers their own prompt.
          r.drafts[pid] = sanitizeDrafts(msg.list, r.prompts.length, true).map((x, i) => (r.prompts[i].author === pid ? '' : x));
        } else {
          r.drafts[pid] = sanitizeDrafts(msg.list, r.cfg.qPerPlayer);
        }
        if (r.game === 'kimyazdi') {
          // A dice starter nobody finished ("Çocukken") is not a confession.
          const bare = new Set(KY_STARTERS.map((x) => lower(x.trim()).replace(/:$/, '')));
          r.drafts[pid] = r.drafts[pid].filter((x) => !bare.has(lower(x).replace(/:$/, '')));
        }
        r.done[pid] = !!msg.done;
        this.changed();
        if (this.allWritersDone()) this.endWriting();
        return;

      case 'lready':
        if (S.phase !== 'lie' || r.step !== 'roles' || !r.roster.includes(pid)) return;
        r.ready[pid] = true;
        if (r.roster.filter((id) => this.lieLive(id)).every((id) => r.ready[id])) this.lieStartClues();
        else this.changed();
        return;

      case 'clue': {
        if (S.phase !== 'lie' || r.step !== 'clues' || pid !== this.lieCurrent()) return;
        const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, LIE_MAX_CLUE);
        if (!text) return;
        r.clues.push({ by: pid, text });
        r.turn++;
        this.lieBeginTurn();
        return;
      }

      case 'lvote': {
        if (S.phase !== 'lie' || r.step !== 'vote' || !r.roster.includes(pid) || r.lvotes[pid]) return;
        if (pid === r.liar && r.cfg.liarKnows) return;
        const target = String(msg.target || '');
        if (!r.roster.includes(target) || target === pid) return;
        r.lvotes[pid] = target;
        if (this.lieAllVoted()) this.lieFinish(); else this.changed();
        return;
      }

      case 'lguess':
        if (S.phase !== 'lie' || r.step !== 'vote' || pid !== r.liar || !r.cfg.liarKnows || r.guess !== null) return;
        if (!r.options.includes(msg.word)) return;
        r.guess = msg.word;
        if (this.lieAllVoted()) this.lieFinish(); else this.changed();
        return;

      case 'vote': {
        if (S.phase !== 'answering' || !r || !r.roster.includes(pid)) return;
        const q = r.questions.find((x) => x.id === msg.qid);
        if (!q) return;
        r.answered[pid] = r.answered[pid] || {};
        if (r.answered[pid][q.id]) return;
        const target = msg.target == null ? null : String(msg.target);
        if (r.game === 'asla') {
          if (target && target !== 'yes' && target !== 'no') return;
        } else if (r.game === 'komik') {
          const a = target && q.answers.find((x) => x.aid === target);
          if (target && (!a || a.author === pid)) return;
        } else if (target && !r.roster.includes(target)) {
          return;
        }
        if (r.game === 'hangimiz' && target === pid && !r.cfg.selfVote) return;
        if (r.game === 'kimyazdi' && (target === pid || q.author === pid)) return;
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
      case 'set': {
        if (S.phase !== 'lobby') return;
        const key = String(msg.key || '');
        const section = COMMON_DEFS.some((d) => d.key === key) ? 'common' : S.game;
        const def = (section === 'common' ? COMMON_DEFS : GAMES[S.game].defs).find((d) => d.key === key);
        if (!def) return;
        S.settings[section][key] = sanitizeValue(def, msg.value);
        store.set('hz-settings', S.settings);
        this.changed();
        this.maybeAutoStart();
        return;
      }
      case 'game':
        if (S.phase !== 'lobby' || !GAMES[msg.id]) return;
        S.game = msg.id;
        S.notice = null;
        store.set('hz-game', S.game);
        this.changed();
        return;
      case 'start':
        if (S.phase === 'lobby') this.startRound();
        return;
      case 'skip':
        if (S.phase === 'writing') this.endWriting();
        else if (S.phase === 'answering') this.endAnswering();
        else if (S.phase === 'lie') this.lieTimeout();
        return;
      case 'lieReset':
        S.lieTotals = {};
        if (r && r.final && r.final.totals) for (const id of Object.keys(r.final.totals)) r.final.totals[id] = 0;
        this.changed();
        return;
      case 'next':
        if (S.phase === 'results') this.nextReveal();
        return;
      case 'prev':
        if (S.phase === 'results' && r.revealIndex > 0) {
          r.revealIndex--;
          r.deadline = r.cfg.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
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

  cfg() {
    return mergedSettings(this.S.settings, this.S.game);
  },

  maybeAutoStart() {
    const S = this.S;
    if (S.phase !== 'lobby' || S.settings.common.startMode !== 'ready') return;
    const ids = this.connectedIds();
    if (ids.length < GAMES[S.game].minPlayers) return;
    if (ids.every((id) => S.players[id].ready || id === S.hostId)) this.startRound();
  },

  startRound() {
    const S = this.S;
    const roster = this.connectedIds();
    const min = GAMES[S.game].minPlayers;
    if (roster.length < min) { toast(GAMES[S.game].name + ' için en az ' + min + ' kişi lazım!'); return; }
    const cfg = this.cfg();
    const names = {};
    for (const id of roster) {
      const p = S.players[id];
      names[id] = { name: p.name, av: p.av, col: p.col };
    }
    const now = Date.now();
    S.notice = null;
    S.round = {
      id: randomId(6),
      game: S.game,
      cfg,
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
      deadline: now + cfg.writeTime * 1000,
      deadlineTotal: cfg.writeTime * 1000,
    };
    if (S.game === 'komik' && cfg.source === 'own') {
      S.round.stage = 'prompts';
      S.round.deadline = now + cfg.promptTime * 1000;
      S.round.deadlineTotal = cfg.promptTime * 1000;
    } else if (S.game === 'komik') {
      S.round.stage = 'answers';
      S.round.prompts = shuffle(KOMIK_PROMPTS).slice(0, cfg.qPerPlayer).map((text) => ({ text, author: null }));
    }
    if (S.game === 'yalanci') this.setupLie(S.round, now);
    for (const id of S.order) S.players[id].ready = false;
    S.phase = S.game === 'yalanci' ? 'lie' : 'writing';
    this.changed();
  },

  /* ---------- Yalancıyı Bul ---------- */

  setupLie(r, now) {
    const keys = Object.keys(LIE_WORDS);
    const cat = r.cfg.category === 'mix' ? keys[Math.floor(Math.random() * keys.length)] : r.cfg.category;
    const pairs = LIE_WORDS[cat].pairs;
    const [word, partner] = shuffle(pairs[Math.floor(Math.random() * pairs.length)]);
    const words = pairs.flat();
    const knows = r.cfg.liarKnows;
    Object.assign(r, {
      liar: r.roster[Math.floor(Math.random() * r.roster.length)],
      category: LIE_WORDS[cat].name,
      word,
      liarWord: knows ? null : partner,
      options: knows ? shuffle([word, ...shuffle(words.filter((w) => w !== word)).slice(0, 7)]) : null,
      order: shuffle(r.roster),
      turn: 0,
      totalTurns: r.cfg.clueRounds * r.roster.length,
      clues: [],
      ready: {},
      lvotes: {},
      guess: null,
      step: 'roles',
      deadline: now + LIE_ROLE_MS,
      deadlineTotal: LIE_ROLE_MS,
    });
  },

  lieCurrent() {
    const r = this.S.round;
    return r.order[r.turn % r.order.length];
  },

  lieLive(id) {
    return !!(this.S.players[id] && this.S.players[id].connected);
  },

  lieStartClues() {
    const r = this.S.round;
    r.step = 'clues';
    r.turn = 0;
    this.lieBeginTurn();
  },

  lieBeginTurn() {
    const r = this.S.round;
    // Players who dropped out lose their turn instead of stalling everyone.
    while (r.turn < r.totalTurns && !this.lieLive(this.lieCurrent())) {
      r.clues.push({ by: this.lieCurrent(), text: null, why: 'off' });
      r.turn++;
    }
    if (r.turn >= r.totalTurns) { this.lieStartVote(); return; }
    r.deadline = Date.now() + r.cfg.clueTime * 1000;
    r.deadlineTotal = r.cfg.clueTime * 1000;
    this.changed();
  },

  lieStartVote() {
    const r = this.S.round;
    r.step = 'vote';
    r.deadline = Date.now() + r.cfg.voteTime * 1000;
    r.deadlineTotal = r.cfg.voteTime * 1000;
    this.changed();
  },

  lieAllVoted() {
    const r = this.S.round;
    const live = r.roster.filter((id) => this.lieLive(id));
    // A liar who knows guesses the word; an unaware liar votes like everyone else.
    return live.length > 0 && live.every((id) => (id === r.liar && r.cfg.liarKnows ? r.guess !== null : !!r.lvotes[id]));
  },

  lieTimeout() {
    const r = this.S.round;
    if (r.step === 'roles') this.lieStartClues();
    else if (r.step === 'clues') {
      r.clues.push({ by: this.lieCurrent(), text: null, why: 'time' });
      r.turn++;
      this.lieBeginTurn();
    } else if (r.step === 'vote') this.lieFinish();
  },

  lieFinish() {
    const S = this.S;
    const r = S.round;
    if (S.phase !== 'lie') return;
    const counts = {};
    for (const id of r.roster) counts[id] = 0;
    for (const target of Object.values(r.lvotes)) if (counts[target] !== undefined) counts[target]++;
    const max = Math.max(0, ...Object.values(counts));
    const leaders = max > 0 ? r.roster.filter((id) => counts[id] === max) : [];
    const caught = leaders.length === 1 && leaders[0] === r.liar;
    const guessedRight = r.guess === r.word;
    const delta = {};
    const add = (id, n) => { delta[id] = (delta[id] || 0) + n; };
    for (const [voter, target] of Object.entries(r.lvotes)) if (target === r.liar) add(voter, LIE_CATCH_POINTS);
    if (!caught) add(r.liar, LIE_ESCAPE_POINTS);
    if (guessedRight) add(r.liar, LIE_GUESS_POINTS);
    S.lieTotals = S.lieTotals || {};
    for (const id of Object.keys(delta)) S.lieTotals[id] = (S.lieTotals[id] || 0) + delta[id];
    const totals = {};
    for (const id of r.roster) totals[id] = S.lieTotals[id] || 0;
    r.final = {
      liar: r.liar, word: r.word, liarWord: r.liarWord, knows: r.cfg.liarKnows, category: r.category, guess: r.guess, guessedRight, caught,
      votes: r.lvotes, counts, leaders, delta, clues: r.clues, order: r.order, totals,
    };
    S.phase = 'final';
    r.deadline = null;
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
    if (r.game === 'komik' && r.stage === 'prompts') { this.startKomikAnswers(); return; }
    if (r.game === 'komik') { this.endKomikWriting(); return; }
    const seen = new Set();
    const qs = [];
    for (const id of r.roster) {
      for (const text of (r.drafts[id] || []).slice(0, r.cfg.qPerPlayer)) {
        const key = lower(text).replace(/[^\p{L}\p{N}]+/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        qs.push({ text, author: id });
      }
    }
    if (!qs.length) {
      S.phase = 'lobby';
      S.round = null;
      S.notice = r.game === 'kimyazdi' ? 'Kimse bir şey yazmadı 😅 Bir daha deneyin!' : 'Kimse soru yazmadı 😅 Bir daha deneyin!';
      this.changed();
      return;
    }
    r.questions = shuffle(qs).map((q, i) => ({ id: 'q' + i, text: q.text, author: q.author }));
    r.drafts = {};
    if (r.game === 'kimyazdi') {
      // Nobody guesses their own confession: count it as already answered.
      for (const q of r.questions) {
        r.answered[q.author] = r.answered[q.author] || {};
        r.answered[q.author][q.id] = true;
      }
    }
    const per = r.cfg.answerTime;
    r.deadline = per > 0 ? Date.now() + r.questions.length * per * 1000 + 4000 : null;
    r.deadlineTotal = per > 0 ? r.questions.length * per * 1000 + 4000 : 0;
    S.phase = 'answering';
    this.changed();
  },

  startKomikAnswers() {
    const S = this.S;
    const r = S.round;
    const seen = new Set();
    const prompts = [];
    for (const id of r.roster) {
      for (const raw of (r.drafts[id] || []).slice(0, r.cfg.ownCount)) {
        const key = lower(raw).replace(/[^\p{L}\p{N}]+/gu, '');
        if (!key || seen.has(key)) continue;
        seen.add(key);
        prompts.push({ text: normalizePrompt(raw), author: id });
      }
    }
    if (!prompts.length) {
      S.phase = 'lobby';
      S.round = null;
      S.notice = 'Kimse soru yazmadı 😅 Bir daha deneyin!';
      this.changed();
      return;
    }
    r.prompts = shuffle(prompts);
    r.stage = 'answers';
    r.drafts = {};
    r.done = {};
    r.deadline = Date.now() + r.cfg.writeTime * 1000;
    r.deadlineTotal = r.cfg.writeTime * 1000;
    this.changed();
  },

  endKomikWriting() {
    const S = this.S;
    const r = S.round;
    r.questions = r.prompts.map((pr, i) => ({
      id: 'q' + i,
      text: pr.text,
      asker: pr.author,
      answers: shuffle(r.roster
        .filter((id) => (r.drafts[id] || [])[i])
        .map((id) => ({ aid: randomId(6), author: id, text: r.drafts[id][i] }))),
    })).filter((q) => q.answers.length > 0);
    if (!r.questions.length) {
      S.phase = 'lobby';
      S.round = null;
      S.notice = 'Kimse cevap yazmadı 😅 Bir daha deneyin!';
      this.changed();
      return;
    }
    r.drafts = {};
    // Someone who has nothing but their own answer to pick from just skips that prompt.
    for (const q of r.questions) {
      for (const id of r.roster) {
        if (!q.answers.some((a) => a.author !== id)) {
          r.answered[id] = r.answered[id] || {};
          r.answered[id][q.id] = true;
        }
      }
    }
    const per = r.cfg.answerTime;
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
    if (r.game === 'kimyazdi') {
      r.results = computeKyResults(r);
      r.final = computeKyFinal(r);
    } else if (r.game === 'asla') {
      r.results = computeAslaResults(r);
      r.final = computeAslaFinal(r);
    } else if (r.game === 'komik') {
      r.results = computeKomikResults(r);
      r.final = computeKomikFinal(r);
    } else {
      r.results = computeResults(r, r.cfg);
      r.final = computeFinal(r);
    }
    r.revealIndex = 0;
    r.deadline = r.cfg.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
    r.deadlineTotal = AUTO_REVEAL_MS;
    S.phase = 'results';
    this.changed();
  },

  nextReveal() {
    const S = this.S;
    const r = S.round;
    if (r.revealIndex < r.results.length - 1) {
      r.revealIndex++;
      r.deadline = r.cfg.revealMode === 'auto' ? Date.now() + AUTO_REVEAL_MS : null;
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
      else if (S.phase === 'lie' && now >= r.deadline) this.lieTimeout();
    }
    if (S.phase === 'lie' && r) {
      if (r.step === 'clues' && !this.lieLive(this.lieCurrent())) this.lieBeginTurn();
      else if (r.step === 'vote' && this.lieAllVoted()) this.lieFinish();
      else if (r.step === 'roles' && r.roster.filter((id) => this.lieLive(id)).every((id) => r.ready[id])) this.lieStartClues();
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
      game: r ? r.game : S.game,
      settings: r ? r.cfg : this.cfg(),
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
      for (const id of r.roster) counts[id] = r.game === 'kimyazdi' ? 0 : (r.drafts[id] || []).filter(Boolean).length;
      pub.writing = { counts, done: r.done, prompts: null, stage: r.stage || null };
      if (r.game === 'komik' && r.stage === 'answers') {
        // Prompt authors stay hidden; each player only learns which prompts are theirs (they skip those).
        pub.writing.prompts = r.prompts.map((x) => x.text);
        pub.writing.need = {};
        for (const id of r.roster) pub.writing.need[id] = r.prompts.filter((x) => x.author !== id).length;
        for (const id of r.roster) counts[id] = (r.drafts[id] || []).filter(Boolean).length;
      }
      pub.me = { drafts: r.drafts[pid] || [] };
      if (r.game === 'komik' && r.stage === 'answers') pub.me.skip = r.prompts.map((x, i) => (x.author === pid ? i : -1)).filter((i) => i >= 0);
    } else if (S.phase === 'answering') {
      // Kim Yazdı? is all about the author being secret — never send it here.
      const showBy = r.game !== 'kimyazdi' && !!r.cfg.showAuthor;
      pub.questions = r.questions.map((q) => ({ id: q.id, text: q.text, by: showBy ? q.author : null }));
      const progress = {};
      for (const id of r.roster) {
        const n = Object.keys(r.answered[id] || {}).length;
        // In Kim Yazdı? the count would reveal how many confessions someone wrote.
        progress[id] = r.game === 'kimyazdi' ? (n >= r.questions.length ? r.questions.length : 0) : n;
      }
      pub.progress = progress;
      pub.me = { answered: Object.keys(r.answered[pid] || {}) };
      if (r.game === 'komik') {
        // Answers go out without their authors; each player only learns which one is theirs.
        pub.questions = r.questions.map((q) => ({ id: q.id, text: q.text, answers: q.answers.map((a) => ({ aid: a.aid, text: a.text })) }));
        pub.me.own = {};
        for (const q of r.questions) {
          const mine = q.answers.find((a) => a.author === pid);
          if (mine) pub.me.own[q.id] = mine.aid;
        }
      }
    } else if (S.phase === 'results') {
      const item = { ...r.results[r.revealIndex] };
      if (r.game !== 'kimyazdi' && !r.cfg.showAuthor) delete item.author;
      pub.reveal = { index: r.revealIndex, total: r.results.length, item };
    } else if (S.phase === 'lie') {
      // An aware liar learns their role; an unaware one just gets a slightly different word.
      const knows = r.cfg.liarKnows;
      const liar = pid === r.liar;
      const voted = {};
      for (const id of r.roster) voted[id] = id === r.liar && knows ? r.guess !== null : !!r.lvotes[id];
      pub.lie = {
        step: r.step,
        hidden: !knows,
        amLiar: liar && knows,
        word: liar ? (knows ? null : r.liarWord) : r.word,
        category: !liar || !knows || r.cfg.showCategory ? r.category : null,
        order: r.order,
        turn: r.turn,
        totalTurns: r.totalTurns,
        current: r.step === 'clues' ? this.lieCurrent() : null,
        clues: r.clues,
        ready: r.ready,
        voted,
        myVote: r.lvotes[pid] || null,
        myGuess: liar && knows ? r.guess : null,
        options: liar && knows && r.step === 'vote' ? r.options : null,
      };
    } else if (S.phase === 'final') {
      pub.final = r.final;
    }
    return pub;
  },
};

function sanitizeValue(def, v) {
  if (def.type === 'num') {
    v = Math.round(Number(v));
    if (!Number.isFinite(v)) return def.def;
    return Math.min(def.max, Math.max(def.min, v));
  }
  if (def.type === 'bool') return typeof v === 'boolean' ? v : def.def;
  return def.options.some((o) => o[0] === v) ? v : def.def;
}

// Settings are stored as { common: {...}, hangimiz: {...}, kimyazdi: {...} }.
function sanitizeSettingsTree(raw) {
  if (!raw || typeof raw !== 'object') raw = {};
  if (!raw.common) {
    // Older saves were one flat object holding the Hangimiz? settings.
    raw = { common: { startMode: raw.startMode, revealMode: raw.revealMode }, hangimiz: raw };
  }
  const out = { common: {} };
  for (const d of COMMON_DEFS) out.common[d.key] = sanitizeValue(d, (raw.common || {})[d.key]);
  for (const g of Object.keys(GAMES)) {
    out[g] = {};
    for (const d of GAMES[g].defs) out[g][d.key] = sanitizeValue(d, (raw[g] || {})[d.key]);
  }
  return out;
}

function mergedSettings(tree, game) {
  return { ...tree.common, ...tree[game] };
}

function settingDefs(game) {
  const hidden = GAMES[game].hideCommon || [];
  return GAMES[game].defs.concat(COMMON_DEFS.filter((d) => !hidden.includes(d.key)));
}

function sanitizeDrafts(list, max, keepSlots = false) {
  if (!Array.isArray(list)) return [];
  const out = list.slice(0, max).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN));
  return keepSlots ? out : out.filter(Boolean);
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

/* ---------- Komik Cevap ---------- */

function computeKomikResults(r) {
  const score = {};
  for (const id of r.roster) score[id] = 0;
  return r.questions.map((q) => {
    const voters = {};
    for (const a of q.answers) voters[a.aid] = [];
    for (const [voter, aid] of Object.entries(r.votes[q.id] || {})) {
      if (voters[aid]) voters[aid].push(voter);
    }
    const bars = q.answers
      .map((a) => ({ aid: a.aid, author: a.author, text: a.text, count: voters[a.aid].length, voters: r.cfg.showVoters ? voters[a.aid] : null }))
      .sort((a, b) => b.count - a.count);
    const total = bars.reduce((x, b) => x + b.count, 0);
    const max = bars.length ? bars[0].count : 0;
    const winners = max > 0 ? bars.filter((b) => b.count === max).map((b) => b.aid) : [];
    const sweep = total >= 2 && bars[0].count === total ? bars[0].aid : null;
    const delta = {};
    for (const b of bars) if (b.count) delta[b.author] = (delta[b.author] || 0) + b.count * KOMIK_VOTE_POINTS;
    if (sweep) delta[bars[0].author] += KOMIK_SWEEP_BONUS;
    for (const id of Object.keys(delta)) score[id] += delta[id];
    return { qid: q.id, text: q.text, asker: q.asker || null, total, bars, winners, sweep, delta, scores: { ...score } };
  });
}

function computeKomikFinal(r) {
  const scores = {};
  const votes = {};
  const wins = {};
  for (const id of r.roster) { scores[id] = 0; votes[id] = 0; wins[id] = 0; }
  const last = r.results[r.results.length - 1];
  if (last) Object.assign(scores, last.scores);
  let best = null;
  let sweeps = 0;
  for (const res of r.results) {
    for (const b of res.bars) {
      votes[b.author] += b.count;
      if (res.winners.includes(b.aid)) wins[b.author]++;
      if (b.count > 0 && (!best || b.count > best.count)) best = { prompt: res.text, text: b.text, author: b.author, count: b.count };
    }
    if (res.sweep) sweeps++;
  }
  return {
    ranking: r.roster.slice().sort((a, b) => scores[b] - scores[a] || votes[b] - votes[a]),
    scores,
    votes,
    wins,
    best,
    sweeps,
    count: r.results.length,
    recap: r.results.map((res) => {
      const top = res.bars.filter((b) => res.winners.includes(b.aid));
      return { prompt: res.text, asker: res.asker, answers: top.map((b) => ({ text: b.text, author: b.author })), count: top.length ? top[0].count : 0, total: res.total };
    }),
  };
}

/* ---------- Asla Yapmadım ---------- */

function computeAslaResults(r) {
  const anon = !r.cfg.showVoters;
  return r.questions.map((q) => {
    const yes = [];
    const no = [];
    for (const [voter, answer] of Object.entries(r.votes[q.id] || {})) {
      if (answer === 'yes') yes.push(voter); else if (answer === 'no') no.push(voter);
    }
    const order = (ids) => r.roster.filter((id) => ids.includes(id));
    return {
      qid: q.id, text: q.text, author: q.author,
      yesCount: yes.length, noCount: no.length, total: yes.length + no.length,
      // Anonymous mode only ever sends the counts.
      yes: anon ? null : order(yes), no: anon ? null : order(no),
    };
  });
}

function computeAslaFinal(r) {
  const anon = !r.cfg.showVoters;
  const done = {};
  for (const id of r.roster) done[id] = 0;
  for (const q of r.questions) {
    for (const [voter, answer] of Object.entries(r.votes[q.id] || {})) {
      if (answer === 'yes' && done[voter] !== undefined) done[voter]++;
    }
  }
  const list = r.results.map((res) => ({ text: res.text, yes: res.yesCount, total: res.total }));
  const answered = list.filter((x) => x.total > 0);
  const out = {
    anon,
    count: r.results.length,
    totalYes: list.reduce((a, x) => a + x.yes, 0),
    everyone: answered.filter((x) => x.total >= 2 && x.yes === x.total).length,
    nobody: answered.filter((x) => x.total >= 2 && x.yes === 0).length,
    recap: list.slice().sort((a, b) => (b.total ? b.yes / b.total : -1) - (a.total ? a.yes / a.total : -1)),
  };
  if (!anon) {
    out.ranking = r.roster.slice().sort((a, b) => done[b] - done[a]);
    out.done = done;
    const min = Math.min(...r.roster.map((id) => done[id]));
    out.innocent = r.roster.filter((id) => done[id] === min);
    out.innocentCount = min;
  }
  return out;
}

/* ---------- Kim Yazdı? scoring ---------- */

function computeKyResults(r) {
  const score = {};
  for (const id of r.roster) score[id] = 0;
  return r.questions.map((q) => {
    const voters = {};
    for (const id of r.roster) voters[id] = [];
    for (const [voter, target] of Object.entries(r.votes[q.id] || {})) {
      if (voters[target]) voters[target].push(voter);
    }
    const bars = r.roster
      .filter((id) => voters[id].length > 0)
      .map((id) => ({ id, count: voters[id].length, voters: voters[id] }))
      .sort((a, b) => b.count - a.count); // stable: ties keep roster order, so the order never hints at the author
    const total = bars.reduce((a, b) => a + b.count, 0);
    const correct = voters[q.author] || [];
    const fooled = total - correct.length;
    const delta = {};
    for (const v of correct) delta[v] = (delta[v] || 0) + KY_CORRECT_POINTS;
    if (fooled > 0) delta[q.author] = (delta[q.author] || 0) + fooled * KY_FOOL_POINTS;
    for (const id of Object.keys(delta)) score[id] += delta[id];
    return { qid: q.id, text: q.text, author: q.author, total, bars, correct, fooled, delta, scores: { ...score } };
  });
}

function computeKyFinal(r) {
  const scores = {};
  const correct = {};
  const fooled = {};
  for (const id of r.roster) { scores[id] = 0; correct[id] = 0; fooled[id] = 0; }
  const last = r.results[r.results.length - 1];
  if (last) Object.assign(scores, last.scores);
  let everyoneKnew = 0;
  for (const res of r.results) {
    for (const v of res.correct) correct[v]++;
    fooled[res.author] += res.fooled;
    if (res.total >= 2 && res.fooled === 0) everyoneKnew++;
  }
  const best = (obj) => {
    const max = Math.max(0, ...Object.values(obj));
    return { ids: max > 0 ? r.roster.filter((id) => obj[id] === max) : [], value: max };
  };
  return {
    ranking: r.roster.slice().sort((a, b) => scores[b] - scores[a] || correct[b] - correct[a]),
    scores,
    correct,
    fooled,
    detective: best(correct),
    hider: best(fooled),
    everyoneKnew,
    count: r.results.length,
    recap: r.results.map((res) => ({ text: res.text, author: res.author, right: res.correct.length, total: res.total })),
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
    '<p>Arkadaşlarınla telefondan oynanan parti oyunları.<br>Oda kur, linki at, gerisi kendiliğinden!</p>' +
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
      '<li><b class="n">2</b><div><b>Oyunu seç.</b> Lider lobide hangi oyunu oynayacağınızı seçer.</div></li>' +
      '<li><b class="n">3</b><div><b>Yaz, oyla, tahmin et.</b> Herkes kendi telefonundan oynar.</div></li>' +
      '<li><b class="n">4</b><div><b>Sonuçlar!</b> Her şey tek tek açılır, en sonda kim kazandı görürsünüz. 🏆</div></li>' +
    '</ol></div>' +
    '<div class="card"><h2>Oyunlar</h2>' + gamePickerHTML(null, false) + '</div>' +
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

  const dKey = s.phase + ':' + (s.roundId || '') + ':' + (s.reveal ? s.reveal.index : '') + ':' + (s.lie ? s.lie.step + s.lie.turn : '');
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
  if ((s.phase === 'writing' || s.phase === 'answering' || s.phase === 'lie') && !inRound) screen = 'spectate';
  if (screen === 'lie') screen = 'lie:' + s.lie.step;
  let key = screen + ':' + (s.roundId || '');
  if (screen === 'results') key += ':' + s.reveal.index;
  if (screen === 'lie:clues') key += ':' + s.lie.turn;
  if (screen === 'writing' && s.writing.stage) key += ':' + s.writing.stage;

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
    const game = GAMES[s.game];
    if (host) {
      const canStart = online >= game.minPlayers;
      startArea =
        '<button class="btn yellow big block" data-act="start" ' + (canStart ? '' : 'disabled') + '>🚀 Oyunu Başlat</button>' +
        '<div class="hint">' + (canStart
          ? (s.settings.startMode === 'ready' ? 'Herkes "Hazırım" deyince kendiliğinden başlar — ya da sen başlat.' : online + ' kişi hazır, başlatabilirsin!')
          : game.name + ' için en az ' + game.minPlayers + ' kişi lazım. Linki arkadaşlarına at!') + '</div>';
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
            '<a class="btn small wa" target="_blank" rel="noopener" href="https://wa.me/?text=' + encodeURIComponent('Oyun odama gel! 🎉 ' + link) + '">WhatsApp</a>' +
          '</div></div>' +
        '<div class="card span2"><h2>Oyun ' + (host ? '<small>(seçmek için dokun)</small>' : '<small>(lider seçer)</small>') + '</h2>' + gamePickerHTML(s.game, host) + '</div>' +
        '<div class="card"><h2>Oyuncular <small>(' + online + ' kişi)</small></h2><div class="players">' + players + '</div></div>' +
        '<div class="card"><h2>' + esc(game.emoji + ' ' + game.name) + ' ayarları ' + (host ? '' : '<small>(lider ayarlar)</small>') + '</h2>' + settingsHTML(s.settings, host, s.game) + '</div>' +
        '<div class="startbar span2">' + startArea + '</div>' +
      '</div>';
  },
};

function gamePickerHTML(current, editable) {
  const cards = GAME_ORDER.map((id) => {
    const g = GAMES[id];
    const on = id === current;
    const attrs = editable ? ' data-act="game" data-id="' + id + '"' : ' disabled';
    return '<button class="gcard ' + (on ? 'on' : '') + '"' + attrs + '><span class="ge">' + g.emoji + '</span><span class="gb"><b>' + esc(g.name) + '</b>' +
      '<small>' + esc(g.desc) + '</small><small class="gmin">En az ' + g.minPlayers + ' kişi</small></span>' + (on ? '<span class="gcheck">✓</span>' : '') + '</button>';
  });
  const soon = COMING_SOON.map((x) => '<div class="gcard soon"><span class="ge">' + x[0] + '</span><span class="gb"><b>' + esc(x[1]) + '</b><small>Yakında…</small></span></div>');
  // In the lobby (a game is selected) phones get a compact two-column list.
  return '<div class="games' + (current ? ' compact' : '') + '">' + cards.concat(soon).join('') + '</div>';
}

function settingsHTML(set, editable, game) {
  return '<div class="settings">' + settingDefs(game).filter((d) => !d.showIf || d.showIf(set)).map((d) => {
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
        ? (d.options.length > 3
          ? '<select class="sel" data-setk="' + d.key + '">' + d.options.map((o) => '<option value="' + o[0] + '"' + (o[0] === v ? ' selected' : '') + '>' + esc(o[1]) + '</option>').join('') + '</select>'
          : '<div class="seg">' + d.options.map((o) => '<button class="' + (o[0] === v ? 'on' : '') + '" data-act="set" data-k="' + d.key + '" data-v="' + o[0] + '">' + esc(o[1]) + '</button>').join('') + '</div>')
        : '<b>' + esc((d.options.find((o) => o[0] === v) || d.options[0])[1]) + '</b>';
    }
    return '<div class="set"><span class="k">' + esc(d.label) + '</span>' + ctrl + '</div>';
  }).join('') + '</div>';
}

/* ---------- writing ---------- */

const GAME_UI = {
  hangimiz: {
    writeTitle: 'Sorularını yaz! ✍️',
    writeHint: (n) => '"Hangimiz…?" diye sorulacak ' + n + ' soru yaz. Aklına gelmezse 🎲 bas.',
    writeTimer: 'Soru yazma süresi',
    progressTitle: 'Kim kaç soru yazdı?',
    placeholders: ['Örn: Grubun en zekisi kim?', 'Örn: En yakışıklı kim?', 'Örn: İlk kim evlenir?', 'Örn: En çok kim geç kalır?'],
    diceTitle: 'Rastgele soru',
    itemWord: 'Soru',
    ask: null,
    pass: '🤷 Pas geç',
    skip: '⏭ Oylamayı bitir, sonuçlara geç',
    doneAll: 'Hepsini cevapladın!',
  },
  kimyazdi: {
    writeTitle: 'Gizli itiraf zamanı 🤫',
    writeHint: (n) => 'Kendin hakkında kimsenin bilmediği ' + n + ' şey yaz. Adını yazma! Takılırsan 🎲 cümleye başlangıç verir.',
    writeTimer: 'Yazma süresi',
    progressTitle: 'Kim bitirdi?',
    placeholders: ['Örn: Hiç denize girmedim', 'Örn: Gizlice çizgi film izliyorum', 'Örn: Çocukken kediyle konuşurdum', 'Örn: Bir kere otobüste uyuyup son durağa gittim'],
    diceTitle: 'Cümle başlangıcı',
    itemWord: 'İtiraf',
    ask: 'Bunu kim yazdı? 🕵️',
    pass: '🤷 Hiç bilmiyorum',
    skip: '⏭ Tahminleri bitir, sonuçlara geç',
    doneAll: 'Hepsini tahmin ettin!',
  },
  komikPrompts: {
    writeTitle: 'Soruları siz yazın! ✍️',
    writeHint: (n) => 'Bir cümlenin başını yaz, sonunu arkadaşların komik şekilde tamamlasın. ' + (n > 1 ? n + ' tane yaz. ' : '') + 'Örn: "Naz\'ın gizli yeteneği" → Naz\'ın gizli yeteneği ____',
    writeTimer: 'Soru yazma süresi',
    progressTitle: 'Kim kaç soru yazdı?',
    placeholders: ['Örn: Tekin\'in en büyük korkusu', 'Örn: Okulda yasaklanması gereken şey', 'Örn: Naz\'ın telefonundaki en garip uygulama'],
    diceTitle: 'Hazır soru',
  },
  komik: {
    writeTitle: 'Komik cevaplarını yaz! 😂',
    writeHint: (n) => n + ' soruya da en komik cevabını yaz. Cevaplar isimsiz oylanacak!',
    writeTimer: 'Cevap yazma süresi',
    progressTitle: 'Kim kaç cevap yazdı?',
    placeholders: ['En komik cevabın…'],
    itemWord: 'Soru',
    ask: 'En komik cevap hangisi? 😂',
    pass: '🤷 Hiçbiri',
    skip: '⏭ Oylamayı bitir, sonuçlara geç',
    doneAll: 'Hepsini oyladın!',
  },
  asla: {
    writeTitle: 'Asla yapmadım! 🙊',
    writeHint: (n) => 'Hiç yapmadığın ama başkalarının yapmış olabileceği ' + n + ' şey yaz. Örn: "Hiç uçağa binmedim". Takılırsan 🎲 bas.',
    writeTimer: 'Yazma süresi',
    progressTitle: 'Kim kaç tane yazdı?',
    placeholders: ['Örn: Hiç uçağa binmedim', 'Örn: Hiç okuldan kaçmadım', 'Örn: Hiç derste uyuyakalmadım', 'Örn: Hiç yanlış kişiye mesaj atmadım'],
    diceTitle: 'Rastgele cümle',
    itemWord: 'Cümle',
    byWord: 'yazdı',
    ask: 'Sen bunu yaptın mı?',
    pass: '🤐 Söylemem',
    skip: '⏭ Cevapları bitir, sonuçlara geç',
    doneAll: 'Hepsini cevapladın!',
  },
};

function ui() {
  const s = App.state;
  if (s.game === 'komik' && s.phase === 'writing' && s.writing && s.writing.stage === 'prompts') return GAME_UI.komikPrompts;
  return GAME_UI[s.game] || GAME_UI.hangimiz;
}

Views.writing = {
  mount(s) {
    App.wDone = false;
    const U = ui();
    const prompts = s.writing.prompts;
    const skip = new Set((s.me && s.me.skip) || []);
    const slots = prompts ? prompts.length : (s.game === 'komik' ? s.settings.ownCount : s.settings.qPerPlayer);
    const n = slots - skip.size;
    const saved = (s.me && s.me.drafts) || [];
    const local = (App.wDrafts && App.wDrafts.key === writeKey(s)) ? App.wDrafts.list : [];
    const rows = [];
    let shown = 0;
    for (let i = 0; i < slots; i++) {
      if (skip.has(i)) continue;
      shown++;
      const val = local[i] ?? saved[i] ?? '';
      const input = '<input class="field q-input grow" data-i="' + i + '" maxlength="' + MAX_Q_LEN + '" placeholder="' + esc(U.placeholders[i % U.placeholders.length]) + '" value="' + esc(val) + '" autocomplete="off">';
      if (prompts) {
        rows.push('<div class="prow"><div class="ptext"><span class="num">' + shown + '</span><span>' + promptHTML(prompts[i]) + '</span></div>' + input + '</div>');
      } else {
        rows.push('<div class="qrow"><span class="num">' + shown + '</span>' + input +
          '<button class="dice" data-act="dice" data-i="' + i + '" title="' + esc(U.diceTitle) + '">🎲</button></div>');
      }
    }
    mount(
      header() +
      timerHTML(U.writeTimer) +
      '<div class="phase-title"><h1>' + esc(U.writeTitle) + '</h1><p>' + esc(U.writeHint(n)) + '</p></div>' +
      '<div class="card" id="wcard"><div class="qlist">' + rows.join('') + '</div>' +
        '<div style="height:14px"></div><button class="btn green big block" data-act="wdone" id="wdone">✅ Bitti</button></div>' +
      '<div class="card"><h2>' + esc(U.progressTitle) + '</h2><div class="chips" id="wprog"></div></div>' +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Süreyi bitir</button></div>' : '')
    );
    App.wDrafts = { key: writeKey(s), list: collectDrafts() };
    if (!rows.length) {
      // Only your own prompts exist: nothing to answer, so you're done right away.
      $('#wcard').innerHTML = '<p class="center muted" style="margin:0"><b>Cevaplayacağın soru yok, diğerleri bekleniyor…</b></p>';
      setWritingDone(true);
    }
    const first = $$('.q-input').find((x) => !x.value);
    if (first && window.matchMedia('(pointer:fine)').matches) first.focus();
  },
  update(s) {
    const n = s.writing.prompts ? null : (s.game === 'komik' ? s.settings.ownCount : s.settings.qPerPlayer);
    $('#wprog').innerHTML = s.roster.map((id) => {
      const p = nameOf(id);
      const live = s.players.find((x) => x.id === id);
      const done = s.writing.done[id];
      return '<span class="chip ' + (done ? 'done' : '') + (live && live.connected ? '' : ' off') + '">' + avatarHTML(p, 'sm') + esc(p.name) +
        ' <span class="cnt">' + (s.game === 'kimyazdi' ? (done ? '✓' : '✍️') : (s.writing.counts[id] || 0) + '/' + (n ?? s.writing.need[id]) + (done ? ' ✓' : '')) + '</span></span>';
    }).join('');
  },
};

// Turn a player's sentence start into a prompt with a blank: "Naz'ın korkusu?" -> "Naz'ın korkusu ___?".
function normalizePrompt(text) {
  if (/_{2,}|\.{3,}|…/.test(text)) return text.replace(/_{2,}|\.{3,}|…/, '___');
  const question = /\?\s*$/.test(text);
  return text.replace(/[\s?:.!,]+$/, '') + ' ___' + (question ? '?' : '');
}

// The writing screen can come twice in one round (Komik Cevap: prompts, then answers).
function writeKey(s) {
  return s.roundId + ':' + ((s.writing && s.writing.stage) || '');
}

// Prompts carry a "___" blank; draw it as a highlighted gap.
function promptHTML(text) {
  return esc(text).replace('___', '<span class="blank"></span>');
}

function collectDrafts() {
  // Keep each value at its data-i slot (Komik Cevap hides the prompts you wrote yourself).
  const out = [];
  for (const x of $$('.q-input')) out[Number(x.dataset.i)] = x.value;
  return Array.from(out, (v) => v ?? '');
}

function queueDrafts(immediate = false) {
  if (!App.state || App.state.phase !== 'writing') return;
  App.wDrafts = { key: writeKey(App.state), list: collectDrafts() };
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
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">' + esc(ui().skip) + '</button></div>' : '')
    );
    showNextQuestion();
  },
  update(s) {
    const total = s.questions.length;
    $('#aprog').innerHTML = s.roster.map((id) => {
      const p = nameOf(id);
      const live = s.players.find((x) => x.id === id);
      const c = s.progress[id] || 0;
      const label = s.game === 'kimyazdi' ? (c >= total ? '✓' : '⏳') : c + '/' + total + (c >= total ? ' ✓' : '');
      return '<span class="chip ' + (c >= total ? 'done' : '') + (live && live.connected ? '' : ' off') + '">' + avatarHTML(p, 'sm') + esc(p.name) +
        ' <span class="cnt">' + label + '</span></span>';
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
  const U = ui();
  if (idx === -1) {
    A.current = null;
    A.qDeadline = null;
    $('#gtimer').innerHTML = s.settings.answerTime > 0 ? timerHTML('Herkesin bitirmesi için kalan süre') : '';
    stage.innerHTML = '<div class="card center"><div class="big-emoji">🎉</div><h2>' + esc(U.doneAll) + '</h2><p class="muted">Diğerleri bitirince sonuçlar başlayacak.</p></div>';
    return;
  }
  const q = s.questions[idx];
  A.current = q.id;
  const per = s.settings.answerTime;
  A.qDeadline = per > 0 ? Date.now() + per * 1000 : null;
  A.qTotal = per * 1000;
  $('#gtimer').innerHTML = per > 0 ? timerHTML('Bu ' + lower(U.itemWord) + ' için kalan süre', 'q') : '';
  const by = q.by ? nameOf(q.by) : null;
  const ky = s.game === 'kimyazdi';
  const asla = s.game === 'asla';
  const options = s.roster.filter((id) => id !== s.you || (!ky && s.settings.selfVote));
  const komik = s.game === 'komik';
  const own = komik && s.me && s.me.own ? s.me.own[q.id] : null;
  const choices = komik
    ? '<div class="answers">' + q.answers.map((a) => a.aid === own
        ? '<div class="ansb mine">' + esc(a.text) + '<small>senin cevabın</small></div>'
        : '<button class="ansb" data-act="vote" data-id="' + esc(a.aid) + '">' + esc(a.text) + '</button>').join('') + '</div>'
    : asla
    ? '<div class="yn">' +
        '<button class="ynb yes" data-act="vote" data-id="yes"><span>✋</span>Ben yaptım</button>' +
        '<button class="ynb no" data-act="vote" data-id="no"><span>😇</span>Hiç yapmadım</button>' +
      '</div>'
    : '<div class="choices">' + options.map((id) => {
        const p = nameOf(id);
        return '<button class="choice" data-act="vote" data-id="' + esc(id) + '">' + avatarHTML(p) + '<span class="nm">' + esc(p.name) + '</span></button>';
      }).join('') + '</div>';
  stage.innerHTML =
    '<div class="card qcard"><div class="meta">' + esc(U.itemWord) + ' ' + (idx + 1) + ' / ' + total + '</div>' +
      '<div class="minibar"><i style="width:' + (A.answered.size / total * 100) + '%"></i></div>' +
      (U.ask ? '<div class="ask">' + esc(U.ask) + '</div>' : '') +
      '<div class="qtext">' + (ky ? '“' + esc(q.text) + '”' : komik ? promptHTML(q.text) : esc(q.text)) + '</div>' +
      (by ? '<div class="by">' + esc(by.av) + ' ' + esc(by.name) + ' ' + (U.byWord || 'sordu') + '</div>' : '') +
    '</div>' +
    choices +
    '<div class="skip-row"><button class="btn small ghost" data-act="vote" data-id="">' + esc(U.pass) + '</button></div>';
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

/* ---------- Yalancıyı Bul ---------- */

// The secret card. It starts covered so nobody reads it over your shoulder.
function roleCardHTML(L, open) {
  const body = L.amLiar
    ? '<div class="rc-emoji">🤥</div><div class="rc-title">Sen YALANCISIN!</div>' +
      '<div class="rc-sub">Gizli kelimeyi bilmiyorsun.' + (L.category ? ' Kategori: <b>' + esc(L.category) + '</b>' : '') + '</div>' +
      '<div class="rc-tip">İpuçlarından kelimeyi çözmeye çalış ve belli etme!</div>'
    : '<div class="rc-label">Gizli kelime</div><div class="rc-word">' + esc(L.word) + '</div>' +
      '<div class="rc-sub">Kategori: <b>' + esc(L.category) + '</b></div>' +
      '<div class="rc-tip">' + (L.hidden
        ? 'Birinizin kelimesi biraz farklı ve kendisi bunu bilmiyor. O sen bile olabilirsin! 😏'
        : 'Aranızda bir yalancı var. Kelimeyi belli etmeden ipucu ver!') + '</div>';
  return '<div id="rolecard" class="rolecard ' + (L.amLiar ? 'liar' : 'word') + (open ? '' : ' hidden') + '" data-act="peek">' +
    '<div class="rc-cover">🔒 Kartını görmek için dokun</div><div class="rc-body">' + body + '<div class="rc-hide">gizlemek için dokun</div></div></div>';
}

function clueBoardHTML(s) {
  const L = s.lie;
  const rows = L.order.map((id) => {
    const p = nameOf(id);
    const mine = L.clues.filter((c) => c.by === id);
    const chips = mine.map((c) => c.text
      ? '<span class="tchip">' + esc(c.text) + '</span>'
      : '<span class="tchip muted">' + (c.why === 'off' ? '🔌 yok' : '⏰ süre doldu') + '</span>').join('');
    const now = L.current === id;
    return '<div class="clrow ' + (now ? 'now' : '') + '">' + avatarHTML(p, 'sm') + '<div class="body"><b>' + esc(p.name) + '</b>' +
      (now ? ' <span class="muted">düşünüyor… ✍️</span>' : '') + '<div class="tchips">' + chips + '</div></div></div>';
  }).join('');
  return '<div class="card"><h2>İpuçları</h2><div class="clues">' + rows + '</div></div>';
}

Views['lie:roles'] = {
  mount(s) {
    App.peek = false;
    mount(header() + timerHTML('Kartını oku') +
      '<div class="phase-title"><h1>Kartına bak! 🤫</h1><p>Kimseye gösterme. ' +
        (s.lie.hidden ? 'Birinizin kelimesi farklı ama kendisi bilmiyor!' : 'Birinizin kartında kelime yok: o yalancı.') + '</p></div>' +
      roleCardHTML(s.lie, false) +
      '<div id="lready"></div>' +
      '<div class="card"><h2>Hazır olanlar</h2><div class="chips" id="lreadyChips"></div></div>' +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Hemen başlat</button></div>' : ''));
  },
  update(s) {
    const L = s.lie;
    $('#lready').innerHTML = L.ready[s.you]
      ? '<div class="waiting-pill">✅ Hazırsın, diğerleri bekleniyor…</div>'
      : '<button class="btn yellow big block" data-act="lready">Anladım, hazırım ✅</button>';
    $('#lreadyChips').innerHTML = s.roster.map((id) => '<span class="chip ' + (L.ready[id] ? 'done' : '') + '">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) +
      ' <span class="cnt">' + (L.ready[id] ? '✓' : '⏳') + '</span></span>').join('');
  },
};

Views['lie:clues'] = {
  mount(s) {
    const L = s.lie;
    const me = L.current === s.you;
    const round = Math.floor(L.turn / L.order.length) + 1;
    const rounds = Math.ceil(L.totalTurns / L.order.length);
    const cur = nameOf(L.current);
    const turnBox = me
      ? '<div class="card myturn"><h2>Sıra sende! 🎤</h2><p class="muted" style="margin:0 0 10px">Kelimeyle ilgili kısa bir ipucu yaz. Çok belli etme, ama yalancı sanılma!</p>' +
        '<div class="row"><input id="clueInput" class="field grow" maxlength="' + LIE_MAX_CLUE + '" placeholder="İpucun…" autocomplete="off">' +
        '<button class="btn green" data-act="clue">Gönder</button></div></div>'
      : '<div class="card center turnwait">' + avatarHTML(cur, 'lg') + '<h2 style="margin:8px 0 0">Sıra: ' + esc(cur.name) + '</h2><p class="muted" style="margin:4px 0 0">İpucunu yazıyor…</p></div>';
    mount(header() + timerHTML('İpucu süresi') +
      '<div class="phase-title"><h1>İpucu turu ' + round + ' / ' + rounds + '</h1></div>' +
      turnBox +
      roleCardHTML(L, App.peek) +
      clueBoardHTML(s) +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Sırayı geç</button></div>' : ''));
    if (me) {
      Sound.join();
      const el = $('#clueInput');
      if (el) setTimeout(() => el.focus(), 50);
    }
  },
};

Views['lie:vote'] = {
  mount(s) {
    const L = s.lie;
    mount(header() + timerHTML('Oylama süresi') +
      '<div class="phase-title"><h1>' + (L.amLiar ? 'Kelimeyi tahmin et! 🎯' : 'Yalancı kim? 🕵️') + '</h1><p>' +
      (L.amLiar ? 'Doğru bilirsen +' + LIE_GUESS_POINTS + ' puan. Yakalanmazsan +' + LIE_ESCAPE_POINTS + '!'
        : L.hidden ? 'Kimin kelimesi farklıydı? (Sen de olabilirsin!) Doğru oy: +' + LIE_CATCH_POINTS
        : 'Kelimeyi bilmiyormuş gibi davranan kimdi? Doğru oy: +' + LIE_CATCH_POINTS) + '</p></div>' +
      '<div id="lvoteArea"></div>' +
      '<div class="card"><h2>Kim oy verdi?</h2><div class="chips" id="lvoted"></div></div>' +
      roleCardHTML(L, App.peek) +
      clueBoardHTML(s) +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Oylamayı bitir</button></div>' : ''));
  },
  update(s) {
    const L = s.lie;
    let area;
    if (L.amLiar) {
      area = L.myGuess
        ? '<div class="waiting-pill">Tahminin: <b>' + esc(L.myGuess) + '</b> 🤞 Diğerleri oy veriyor…</div>'
        : '<div class="opts">' + L.options.map((w) => '<button class="ansb" data-act="lguess" data-w="' + esc(w) + '">' + esc(w) + '</button>').join('') + '</div>';
    } else {
      area = L.myVote
        ? '<div class="waiting-pill">Oyun: <b>' + esc(nameOf(L.myVote).name) + '</b> ✓ Diğerleri bekleniyor…</div>'
        : '<div class="choices">' + s.roster.filter((id) => id !== s.you).map((id) => '<button class="choice" data-act="lvote" data-id="' + esc(id) + '">' +
            avatarHTML(nameOf(id)) + '<span class="nm">' + esc(nameOf(id).name) + '</span></button>').join('') + '</div>';
    }
    $('#lvoteArea').innerHTML = area;
    $('#lvoted').innerHTML = s.roster.map((id) => '<span class="chip ' + (L.voted[id] ? 'done' : '') + '">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) +
      ' <span class="cnt">' + (L.voted[id] ? '✓' : '⏳') + '</span></span>').join('');
  },
};

function lieFinalMount(s) {
  const F = s.final;
  const liar = nameOf(F.liar);
  const headline = F.caught
    ? '<h1>🎉 Yalancı yakalandı!</h1><p>' + (!F.knows ? 'Kendisi bile bilmiyordu 😅' : F.guessedRight ? 'Ama kelimeyi bildi, puanı kaptı 😏' : 'Kelimeyi de bilemedi 😅') + '</p>'
    : '<h1>😈 Yalancı kaçtı!</h1><p>' + (F.leaders.length > 1 ? 'Oylar bölündü, kimse yakalanamadı.' : 'Yanlış kişiyi seçtiniz!') + '</p>';

  const max = Math.max(1, ...Object.values(F.counts));
  const bars = Object.keys(F.counts).filter((id) => F.counts[id] > 0).sort((a, b) => F.counts[b] - F.counts[a]).map((id) => {
    const p = nameOf(id);
    const voters = Object.keys(F.votes).filter((v) => F.votes[v] === id).map((v) => esc(nameOf(v).name)).join(', ');
    return '<div class="barrow ' + (id === F.liar ? 'win' : '') + '">' + avatarHTML(p) + '<div class="body"><div class="top2"><span class="nm">' +
      (id === F.liar ? '🤥 ' : '') + esc(p.name) + '</span><span>' + F.counts[id] + ' oy</span></div>' +
      '<div class="track"><i style="--c:' + esc(p.col) + '" data-w="' + (F.counts[id] / max * 100) + '"></i></div><div class="voters">' + voters + '</div></div></div>';
  }).join('');

  const guess = !F.knows
    ? '🔀 Yalancının kelimesi: <b>' + esc(F.liarWord) + '</b>'
    : F.guess
    ? (F.guessedRight ? '✅ ' + esc(liar.name) + ' kelimeyi bildi: <b>' + esc(F.guess) + '</b>' : '❌ Yalancının tahmini: <b>' + esc(F.guess) + '</b> (yanlış)')
    : '🤐 ' + esc(liar.name) + ' tahmin yapmadı';

  const points = Object.entries(F.delta).sort((a, b) => b[1] - a[1])
    .map(([id, d]) => '<span class="pt">' + esc(nameOf(id).name) + ' <b>+' + d + '</b></span>').join('');
  const board = Object.keys(F.totals).sort((a, b) => F.totals[b] - F.totals[a]).map((id, i) => {
    const d = F.delta[id];
    return '<div class="srow"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + '</span>' +
      (d ? '<span class="dl">+' + d + '</span>' : '') + '<b>' + F.totals[id] + '</b></div>';
  }).join('');

  const clues = F.order.map((id) => {
    const list = F.clues.filter((c) => c.by === id && c.text).map((c) => '<span class="tchip">' + esc(c.text) + '</span>').join('') || '<span class="muted">—</span>';
    return '<div class="clrow ' + (id === F.liar ? 'now' : '') + '">' + avatarHTML(nameOf(id), 'sm') + '<div class="body"><b>' + esc(nameOf(id).name) + (id === F.liar ? ' 🤥' : '') + '</b><div class="tchips">' + list + '</div></div></div>';
  }).join('');

  mount(
    header() +
    '<div class="phase-title">' + headline + '</div>' +
    '<div class="card rescard" id="rescard"><div class="meta">Yalancı</div>' +
      '<div class="kyreveal late" style="border-top:0;margin-top:0;padding-top:4px">' + avatarHTML(liar, 'lg') + '<div class="kyname">' + esc(liar.name) + '</div></div>' +
      '<div class="lieword">' + (F.knows ? 'Gizli kelime' : 'Herkesin kelimesi') + ': <b>' + esc(F.word) + '</b> <span class="muted">(' + esc(F.category) + ')</span></div>' +
      '<div class="center" style="margin-top:6px">' + guess + '</div>' +
      (bars ? '<div class="bars">' + bars + '</div>' : '<p class="center muted">Kimse oy vermedi.</p>') +
      (points ? '<div class="pts late">' + points + '</div>' : '') +
    '</div>' +
    '<div class="card"><h2>Odanın toplam puanı 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Yalancıyı bulana +' + LIE_CATCH_POINTS + ' · Yalancı kaçarsa +' + LIE_ESCAPE_POINTS +
        (F.knows ? ' · Kelimeyi bilirse +' + LIE_GUESS_POINTS : '') + '</p>' +
      (isHost() ? '<div class="ctrl" style="margin-top:10px"><button class="btn small ghost" data-act="lieReset">🧹 Toplamı sıfırla</button></div>' : '') + '</div>' +
    '<div class="card"><h2>Verilen ipuçları</h2><div class="clues">' + clues + '</div></div>' +
    finalFooter(),
    true
  );
  setTimeout(() => {
    $$('.track i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
    const card = $('#rescard');
    if (card) card.classList.add('revealed');
  }, 60);
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
    if (s.game === 'kimyazdi') kyResultsMount(s);
    else if (s.game === 'asla') aslaResultsMount(s);
    else if (s.game === 'komik') komikResultsMount(s);
    else hangimizResultsMount(s);
    // setTimeout (not rAF) so it also runs while the tab is in the background.
    setTimeout(() => {
      $$('.track i, .ynbar i').forEach((el) => { el.style.width = el.dataset.w + '%'; });
      $$('#rescard, .card.late').forEach((el) => el.classList.add('revealed'));
    }, 60);
    Sound.click();
    setTimeout(() => Sound.beep(988, 0.15, 'triangle', 0.08), s.game === 'kimyazdi' ? 1600 : 1150);
  },
};

// Dots, auto-advance timer and host buttons shared by every results screen.
function revealChrome(s) {
  const R = s.reveal;
  const last = R.index >= R.total - 1;
  const auto = s.settings.revealMode === 'auto';
  const dots = '<div class="dots">' + Array.from({ length: R.total }, (_, i) => '<i class="' + (i <= R.index ? 'on' : '') + '"></i>').join('') + '</div>';
  let ctrl = '';
  if (isHost()) {
    ctrl = '<div class="ctrl">' +
      (R.index > 0 ? '<button class="btn ghost" data-act="prev">◀ Geri</button>' : '') +
      '<button class="btn yellow big" data-act="next">' + (last ? '🏆 İstatistikleri gör' : 'Sonraki ▶') + '</button></div>';
  } else if (!auto) {
    ctrl = '<div class="waiting-pill">Lider bir sonrakine geçecek…</div>';
  }
  const timer = auto ? timerHTML(last ? 'İstatistiklere geçiliyor' : 'Sonrakine geçiliyor') : '';
  return { top: header() + '<div class="phase-title"><h1>Sonuçlar 📊</h1></div>' + dots + timer, ctrl };
}

function hangimizResultsMount(s) {
    const R = s.reveal;
    const it = R.item;
    const by = it.by ? nameOf(it.by) : null;
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
    const C = revealChrome(s);
    mount(
      C.top +
      '<div class="card rescard" id="rescard"><div class="meta">Soru ' + (R.index + 1) + ' / ' + R.total + '</div>' +
        '<div class="qtext">' + esc(it.text) + '</div>' +
        (by ? '<div class="meta">' + esc(by.av) + ' ' + esc(by.name) + ' sordu</div>' : '') +
        body +
      '</div>' + C.ctrl
    );
}

function komikResultsMount(s) {
  const R = s.reveal;
  const it = R.item;
  const max = it.bars.length ? Math.max(1, it.bars[0].count) : 1;
  const answers = it.bars.map((b) => {
    const p = nameOf(b.author);
    const win = it.winners.includes(b.aid);
    const voters = b.voters && b.voters.length ? '<div class="voters">' + b.voters.map((v) => esc(nameOf(v).name)).join(', ') + '</div>' : '';
    return '<div class="kans ' + (win ? 'win' : '') + '">' +
      '<div class="ktext">' + (win ? '<span class="crown">👑</span> ' : '') + esc(b.text) + '</div>' +
      '<div class="late kwho">' + avatarHTML(p, 'sm') + '<b>' + esc(p.name) + '</b><span class="kv">' + b.count + ' oy</span></div>' +
      '<div class="track"><i style="--c:' + esc(p.col) + '" data-w="' + (b.count / max * 100) + '"></i></div>' + voters +
    '</div>';
  }).join('');

  let verdict;
  if (!it.total) verdict = 'Kimse oy vermedi 🤷';
  else if (it.sweep) verdict = '💯 Herkes aynı cevabı seçti! +' + KOMIK_SWEEP_BONUS + ' bonus';
  else if (it.winners.length > 1) verdict = '🤝 Berabere!';
  else verdict = '😂 ' + nameOf(it.bars[0].author).name + ' kazandı!';

  const points = Object.entries(it.delta).sort((a, b) => b[1] - a[1])
    .map(([id, d]) => '<span class="pt">' + esc(nameOf(id).name) + ' <b>+' + d + '</b></span>').join('');
  const board = s.roster.slice().sort((a, b) => it.scores[b] - it.scores[a]).map((id, i) => {
    const d = it.delta[id];
    return '<div class="srow"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + '</span>' +
      (d ? '<span class="dl">+' + d + '</span>' : '') + '<b>' + it.scores[id] + '</b></div>';
  }).join('');

  const C = revealChrome(s);
  mount(
    C.top +
    '<div class="card rescard" id="rescard"><div class="meta">Soru ' + (R.index + 1) + ' / ' + R.total + '</div>' +
      '<div class="qtext">' + promptHTML(it.text) + '</div>' +
      (it.asker ? '<div class="meta">' + esc(nameOf(it.asker).av) + ' ' + esc(nameOf(it.asker).name) + ' sordu</div>' : '') +
      '<div class="kanswers">' + answers + '</div>' +
      '<div class="winline">' + esc(verdict) + '</div>' +
      (points ? '<div class="pts late">' + points + '</div>' : '') +
    '</div>' +
    '<div class="card late"><h2>Puan durumu</h2><div class="board">' + board + '</div></div>' +
    C.ctrl
  );
}

function aslaResultsMount(s) {
  const R = s.reveal;
  const it = R.item;
  const by = it.author ? nameOf(it.author) : null;
  const pct = it.total ? Math.round(it.yesCount / it.total * 100) : 0;
  const people = (ids) => ids.length
    ? ids.map((id) => '<span class="chip">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</span>').join('')
    : '<span class="muted">Kimse</span>';

  let verdict;
  if (!it.total) verdict = 'Kimse cevap vermedi 🤐';
  else if (it.yesCount === 0) verdict = 'Kimse yapmamış, ne masum grup 😇';
  else if (it.yesCount === it.total) verdict = it.total > 1 ? 'Herkes yapmış! 😂' : 'Yapmış! 😂';
  else if (it.yesCount === 1) verdict = it.yes ? 'Bir tek ' + nameOf(it.yes[0]).name + ' yapmış 👀' : 'Sadece 1 kişi yapmış 👀';
  else verdict = it.total + ' kişiden ' + it.yesCount + ' kişi yapmış';

  const lists = it.yes && it.total
    ? '<div class="ynlists late">' +
        '<div><h3>✋ Yapanlar</h3><div class="chips">' + people(it.yes) + '</div></div>' +
        '<div><h3>😇 Yapmayanlar</h3><div class="chips">' + people(it.no) + '</div></div>' +
      '</div>'
    : '';

  const C = revealChrome(s);
  mount(
    C.top +
    '<div class="card rescard" id="rescard"><div class="meta">Cümle ' + (R.index + 1) + ' / ' + R.total + '</div>' +
      '<div class="qtext">“' + esc(it.text) + '”</div>' +
      (by ? '<div class="meta">' + esc(by.av) + ' ' + esc(by.name) + ' yazdı</div>' : '') +
      (it.total
        ? '<div class="ynstat"><div class="ynpct">%' + pct + '</div><div class="muted">yapmış</div></div>' +
          '<div class="ynbar"><i class="y" data-w="' + pct + '"></i></div>' +
          '<div class="ynlegend"><span>✋ ' + it.yesCount + ' yaptı</span><span>😇 ' + it.noCount + ' yapmadı</span></div>'
        : '') +
      '<div class="winline">' + esc(verdict) + '</div>' +
      lists +
    '</div>' + C.ctrl
  );
}

function kyResultsMount(s) {
  const R = s.reveal;
  const it = R.item;
  const author = nameOf(it.author);
  let bars;
  if (!it.total) {
    bars = '';
  } else {
    const max = it.bars[0].count;
    bars = '<div class="bars kybars">' + it.bars.map((b) => {
      const p = nameOf(b.id);
      const isAuthor = b.id === it.author;
      return '<div class="barrow ' + (isAuthor ? 'win author' : '') + '">' + avatarHTML(p) + '<div class="body">' +
        '<div class="top2"><span class="nm">' + (isAuthor ? '<span class="crown">✍️</span> ' : '') + esc(p.name) + '</span><span>' + b.count + ' tahmin</span></div>' +
        '<div class="track"><i style="--c:' + esc(p.col) + '" data-w="' + (b.count / max * 100) + '"></i></div>' +
        '<div class="voters">' + b.voters.map((v) => esc(nameOf(v).name)).join(', ') + '</div>' +
      '</div></div>';
    }).join('') + '</div>';
  }

  const right = it.correct.map((id) => nameOf(id).name);
  let verdict;
  if (!it.total) verdict = 'Kimse tahmin etmedi 🤷';
  else if (!right.length) verdict = 'Kimse bilemedi! ' + author.name + ' herkesi kandırdı 😎';
  else if (!it.fooled) verdict = 'Herkes bildi! Çok belli etmişsin 😅';
  else verdict = right.join(', ') + ' doğru bildi 🎯';

  const points = Object.entries(it.delta).sort((a, b) => b[1] - a[1])
    .map(([id, d]) => '<span class="pt">' + esc(nameOf(id).name) + ' <b>+' + d + '</b></span>').join('');

  const board = s.roster.slice().sort((a, b) => it.scores[b] - it.scores[a]).map((id, i) => {
    const p = nameOf(id);
    const d = it.delta[id];
    return '<div class="srow"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(p, 'sm') + '<span class="nm">' + esc(p.name) + '</span>' +
      (d ? '<span class="dl">+' + d + '</span>' : '') + '<b>' + it.scores[id] + '</b></div>';
  }).join('');

  const C = revealChrome(s);
  mount(
    C.top +
    '<div class="card rescard" id="rescard"><div class="meta">İtiraf ' + (R.index + 1) + ' / ' + R.total + '</div>' +
      '<div class="qtext">“' + esc(it.text) + '”</div>' +
      bars +
      '<div class="kyreveal late"><div class="kylabel">Yazan</div>' + avatarHTML(author, 'lg') +
        '<div class="kyname">' + esc(author.name) + '</div><div class="kyverdict">' + esc(verdict) + '</div>' +
        (points ? '<div class="pts">' + points + '</div>' : '') +
      '</div>' +
    '</div>' +
    '<div class="card late"><h2>Puan durumu</h2><div class="board">' + board + '</div></div>' +
    C.ctrl
  );
}

/* ---------- final ---------- */

Views.final = {
  mount(s) {
    if (s.game === 'kimyazdi') kyFinalMount(s);
    else if (s.game === 'asla') aslaFinalMount(s);
    else if (s.game === 'komik') komikFinalMount(s);
    else if (s.game === 'yalanci') lieFinalMount(s);
    else hangimizFinalMount(s);
    confetti();
    Sound.fanfare();
  },
};

function podiumHTML(ranking, subFn) {
  const top = ranking.slice(0, 3);
  const podOrder = [top[1], top[0], top[2]];
  const podClass = ['p2', 'p1', 'p3'];
  return '<div class="podium">' + podOrder.map((id, i) => {
    if (!id) return '<div class="pod"></div>';
    const p = nameOf(id);
    return '<div class="pod ' + podClass[i] + '">' + avatarHTML(p, 'lg') + '<div class="name">' + esc(p.name) + '</div>' +
      '<div class="sub">' + esc(subFn(id)) + '</div><div class="block">' + podClass[i].slice(1) + '</div></div>';
  }).join('') + '</div>';
}

function finalFooter() {
  return isHost()
    ? '<div class="startbar"><button class="btn yellow big block" data-act="lobby">🔁 Yeni tur (lobiye dön)</button></div>'
    : '<div class="waiting-pill">Lider yeni tur başlatabilir 🔁</div>';
}

function statsHTML(stats) {
  return '<div class="stats">' + stats.map((x) => '<div class="stat"><div class="v">' + esc(x[0]) + ' ' + esc(x[1]) + '</div><div class="l">' + esc(x[2]) + '</div></div>').join('') + '</div>';
}

function kyFinalMount(s) {
  const F = s.final;
  const lead = F.ranking[0];
  const champs = F.ranking.filter((id) => F.scores[id] === F.scores[lead]);
  let headline;
  if (!F.scores[lead]) headline = '<h1>Kimse puan alamadı 😅</h1><p>Hiç tahmin yapılmamış gibi görünüyor.</p>';
  else if (champs.length > 1) headline = '<h1>🤝 Berabere!</h1><p>' + esc(champs.map((id) => nameOf(id).name).join(' & ')) + ' eşit puan topladı.</p>';
  else headline = '<h1>' + esc(nameOf(lead).av) + ' ' + esc(nameOf(lead).name) + ' kazandı!</h1><p>' + F.scores[lead] + ' puanla turun şampiyonu.</p>';

  const board = F.ranking.map((id, i) => {
    const p = nameOf(id);
    return '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(p) + '<span class="nm">' + esc(p.name) +
      '<small>' + F.correct[id] + ' doğru tahmin · ' + F.fooled[id] + ' kişiyi kandırdı</small></span><b>' + F.scores[id] + '</b></div>';
  }).join('');

  const names = (ids) => ids.map((id) => nameOf(id).name).join(' & ');
  const stats = [['🤫', F.count, 'itiraf yazıldı']];
  if (F.detective.ids.length) stats.push(['🕵️', names(F.detective.ids), 'en iyi dedektif (' + F.detective.value + ' doğru)']);
  if (F.hider.ids.length) stats.push(['😎', names(F.hider.ids), 'en iyi saklanan (' + F.hider.value + ' kişiyi kandırdı)']);
  stats.push(['😅', F.everyoneKnew, 'itirafı herkes bildi']);

  const recap = F.recap.map((r) => '<div><span class="q">“' + esc(r.text) + '”</span><span class="w">' + esc(nameOf(r.author).name) +
    (r.total ? ' <span class="muted">(' + r.right + '/' + r.total + ' bildi)</span>' : '') + '</span></div>').join('');

  mount(
    header() +
    '<div class="phase-title">' + headline + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Doğru tahmin: +' + KY_CORRECT_POINTS + ' puan · Seni bilemeyen her kişi için: +' + KY_FOOL_POINTS + ' puan</p></div>' +
    '<div class="card"><h2>Sayılarla bu tur</h2>' + statsHTML(stats) + '</div>' +
    '<div class="card"><h2>Bütün itiraflar</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

function komikFinalMount(s) {
  const F = s.final;
  const lead = F.ranking[0];
  const champs = F.ranking.filter((id) => F.scores[id] === F.scores[lead]);
  let headline;
  if (!F.scores[lead]) headline = '<h1>Kimse oy almadı 😅</h1><p>Bir dahaki sefere daha komik olun!</p>';
  else if (champs.length > 1) headline = '<h1>🤝 Berabere!</h1><p>' + esc(champs.map((id) => nameOf(id).name).join(' & ')) + ' eşit puan topladı.</p>';
  else headline = '<h1>' + esc(nameOf(lead).av) + ' ' + esc(nameOf(lead).name) + ' en komik!</h1><p>' + F.scores[lead] + ' puanla turun şampiyonu 😂</p>';

  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.votes[id] + ' oy · ' + F.wins[id] + ' kez en komik</small></span><b>' + F.scores[id] + '</b></div>').join('');

  const best = F.best
    ? '<div class="card"><h2>Turun en komik cevabı 🏆</h2><div class="bestq">' + promptHTML(F.best.prompt) + '</div>' +
      '<div class="besta">“' + esc(F.best.text) + '”</div><div class="center muted"><b>' + esc(nameOf(F.best.author).name) + '</b> · ' + F.best.count + ' oy</div></div>'
    : '';

  const stats = [['📝', F.count, 'soru soruldu'], ['💯', F.sweeps, 'soruda herkes aynı cevabı seçti']];

  const recap = F.recap.map((r) => '<div><span class="q">' + promptHTML(r.prompt) + '</span><span class="w">' +
    (r.answers.length ? r.answers.map((a) => '“' + esc(a.text) + '” (' + esc(nameOf(a.author).name) + ')').join(' & ') : '—') + '</span></div>').join('');

  mount(
    header() +
    '<div class="phase-title">' + headline + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Aldığın her oy: +' + KOMIK_VOTE_POINTS + ' puan · Herkes seni seçerse: +' + KOMIK_SWEEP_BONUS + ' bonus</p></div>' +
    best +
    '<div class="card"><h2>Sayılarla bu tur</h2>' + statsHTML(stats) + '</div>' +
    '<div class="card"><h2>Kazanan cevaplar</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

function aslaFinalMount(s) {
  const F = s.final;
  const names = (ids) => ids.map((id) => nameOf(id).name).join(' & ');
  let headline;
  let podium = '';
  let board = '';
  if (!F.anon) {
    const lead = F.ranking[0];
    const tops = F.ranking.filter((id) => F.done[id] === F.done[lead]);
    if (!F.done[lead]) headline = '<h1>😇 Melek gibi bir grup!</h1><p>Kimse hiçbir şeyi yapmamış (öyle diyorlar).</p>';
    else if (tops.length > 1) headline = '<h1>✋ ' + esc(names(tops)) + '</h1><p>Grubun en maceracıları: ' + F.done[lead] + ' şeyi yapmışlar!</p>';
    else headline = '<h1>' + esc(nameOf(lead).av) + ' ' + esc(nameOf(lead).name) + ' en maceracı!</h1><p>' + F.count + ' şeyden ' + F.done[lead] + ' tanesini yapmış 😂</p>';
    podium = podiumHTML(F.ranking, (id) => F.done[id] + ' / ' + F.count + ' yaptı');
    board = '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Kim kaç şey yapmış? ✋</h2><div class="board">' +
      F.ranking.map((id, i) => '<div class="srow"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id), 'sm') +
        '<span class="nm">' + esc(nameOf(id).name) + '</span><b>' + F.done[id] + '</b></div>').join('') + '</div></div>';
  } else {
    headline = '<h1>Tur bitti! 🙊</h1><p>Cevaplar gizliydi, sadece sayılar var.</p>';
  }

  const stats = [['🙊', F.count, 'cümle yazıldı'], ['✋', F.totalYes, 'kere "yaptım" dendi']];
  if (!F.anon && F.innocent.length) stats.push(['😇', names(F.innocent), 'en masum (' + F.innocentCount + ' tane yapmış)']);
  stats.push(['😂', F.everyone, 'şeyi herkes yapmış']);
  stats.push(['🤷', F.nobody, 'şeyi kimse yapmamış']);

  const recap = F.recap.map((r) => '<div><span class="q">“' + esc(r.text) + '”</span><span class="w">' +
    (r.total ? r.yes + '/' + r.total + ' yaptı' : '—') + '</span></div>').join('');

  mount(
    header() +
    '<div class="phase-title">' + headline + '</div>' +
    podium + board +
    '<div class="card"><h2>Sayılarla bu tur</h2>' + statsHTML(stats) + '</div>' +
    '<div class="card"><h2>Bütün cümleler <small>(en çok yapılandan aza)</small></h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

function hangimizFinalMount(s) {
    const F = s.final;
    const podium = podiumHTML(F.ranking, (id) => F.titles[id].length + ' unvan · ' + F.votes[id] + ' oy');

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
      podium +
      '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Unvanlar 🏅</h2><div class="titles">' + titles + '</div></div>' +
      '<div class="card"><h2>Sayılarla bu tur</h2>' + statsHTML(stats) + '</div>' +
      unanimous +
      '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
      finalFooter(),
      true
    );
}

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
  if (s && s.phase === 'writing' && App.deadline && now >= App.deadline && App.flushedRound !== writeKey(s)) {
    App.flushedRound = writeKey(s);
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
    const def = settingDefs(s.game).find((d) => d.key === el.dataset.k);
    if (!def) return;
    let value;
    if (def.type === 'num') value = s.settings[def.key] + Number(el.dataset.d) * def.step;
    else if (def.type === 'bool') value = !s.settings[def.key];
    else value = el.dataset.v;
    send({ t: 'set', key: def.key, value });
  },
  game(el) {
    if (el.dataset.id !== App.state.game) { Sound.click(); send({ t: 'game', id: el.dataset.id }); }
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
    if (App.state.game === 'kimyazdi') {
      // Confessions must be personal, so the dice only offers a sentence starter.
      const starters = KY_STARTERS.filter((x) => x !== input.value);
      input.value = starters[Math.floor(Math.random() * starters.length)];
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      Sound.click();
      queueDrafts();
      return;
    }
    const all = App.state.game === 'asla' ? ASLA_STATEMENTS
      : App.state.game === 'komik' ? KOMIK_PROMPTS.map((x) => x.replace(/[\s:]*___$/, ''))
      : RANDOM_QUESTIONS;
    const taken = new Set(collectDrafts().map(lower));
    const pool = all.filter((q) => !taken.has(lower(q)));
    input.value = (pool.length ? pool : all)[Math.floor(Math.random() * (pool.length || all.length))];
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
  lready() { send({ t: 'lready' }); },
  clue() {
    const el = $('#clueInput');
    const text = el ? el.value.trim() : '';
    if (!text) { if (el) el.focus(); return; }
    Sound.click();
    send({ t: 'clue', text });
  },
  lvote(el) { Sound.click(); send({ t: 'lvote', target: el.dataset.id }); },
  lguess(el) { Sound.click(); send({ t: 'lguess', word: el.dataset.w }); },
  peek() {
    App.peek = !App.peek;
    const c = $('#rolecard');
    if (c) c.classList.toggle('hidden', !App.peek);
  },
  lieReset() { if (confirm('Odanın Yalancıyı Bul toplam puanları sıfırlansın mı?')) send({ t: 'lieReset' }); },
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

document.addEventListener('change', (e) => {
  if (e.target.matches('select[data-setk]')) send({ t: 'set', key: e.target.dataset.setk, value: e.target.value });
});

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('q-input')) queueDrafts();
  if (e.target.id === 'cd') e.target.value = cleanCode(e.target.value);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'clueInput') { e.preventDefault(); doAction('clue'); return; }
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
