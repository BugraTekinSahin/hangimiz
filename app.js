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
  // "Süresiz": no countdowns; each step moves on once everyone has answered.
  { key: 'timeMode', label: 'Süre', type: 'choice', def: 'timed', top: true, options: [['timed', 'Süreli ⏱️'], ['untimed', 'Süresiz ♾️']] },
  { key: 'startMode', label: 'Oyunu kim başlatır?', type: 'choice', def: 'host', options: [['host', 'Lider'], ['ready', 'Herkes hazır olunca']] },
  { key: 'revealMode', label: 'Sonuçları kim geçirir?', type: 'choice', def: 'host', options: [['host', 'Lider'], ['auto', 'Otomatik']] },
];

// Every game uses the same flow: write → answer → reveal results → final stats.
// writeTime / qPerPlayer / answerTime drive that flow, so each game defines them.
const GAMES = {
  hangimiz: {
    name: 'Kim En?',
    emoji: '🤔',
    desc: 'Herkes "En … kim?" soruları yazar, herkes oylar. En zekimiz kim, en yakışıklımız kim?',
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
GAMES.kackac = {
  name: 'Kaç Kaç?',
  emoji: '🔢',
  desc: 'Sırayla herkes kendisiyle ilgili bir sayı sorar: "Bugün kaç saat uyumuşumdur?" Diğerleri tahmin eder, tam bilen kazanır!',
  minPlayers: 2,
  defs: [
    { key: 'perPlayer', label: 'Kişi başı soru', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'soru' },
    { key: 'askTime', label: 'Soru yazma süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
    { key: 'guessTime', label: 'Tahmin süresi', type: 'num', def: 25, min: 10, max: 90, step: 5, unit: 'sn' },
  ],
};
GAMES.ikiz = {
  name: 'Ruh İkizi',
  emoji: '💞',
  desc: 'Herkesin gizli bir ruh ikizi var ama kim olduğunu bilmiyor! Aynı cevabı verince puan kazanırsınız. Sonda ikizini tahmin et.',
  minPlayers: 4,
  defs: [
    { key: 'rounds', label: 'Tur sayısı', type: 'num', def: 5, min: 3, max: 10, step: 1, unit: 'tur' },
    { key: 'answerTime', label: 'Cevap süresi', type: 'num', def: 20, min: 10, max: 60, step: 5, unit: 'sn' },
    { key: 'guessTime', label: 'İkiz tahmini süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
  ],
};
GAMES.tele = {
  name: 'Telepati',
  emoji: '🧠',
  desc: 'Her tur iki kişi seçilir, konuşmadan aynı cevabı vermeye çalışır. Diğerleri tutturup tutturamayacaklarına bahse girer!',
  minPlayers: 3,
  defs: [
    { key: 'rounds', label: 'Tur sayısı', type: 'num', def: 6, min: 2, max: 12, step: 1, unit: 'tur' },
    { key: 'answerTime', label: 'Cevap süresi', type: 'num', def: 20, min: 10, max: 60, step: 5, unit: 'sn' },
  ],
};
GAMES.ayna = {
  name: 'Ayna',
  emoji: '🪞',
  desc: 'Sırayla biri ayna olur ve kendi cevabını yazar. Diğerleri onun ne yazdığını tahmin eder. Kim kimi iyi tanıyor?',
  minPlayers: 3,
  defs: [
    { key: 'perPlayer', label: 'Kişi başı ayna olma', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'kez' },
    { key: 'answerTime', label: 'Cevap süresi', type: 'num', def: 30, min: 10, max: 90, step: 5, unit: 'sn' },
    { key: 'judgeTime', label: 'Kontrol süresi', type: 'num', def: 30, min: 10, max: 90, step: 5, unit: 'sn' },
  ],
};
GAMES.emoji = {
  name: 'Emojiyle Anlat',
  emoji: '🎬',
  desc: 'Sırayla biri gizli bir film, dizi ya da çizgi filmi sadece emojiyle anlatır. İlk bilen en çok puanı kapar!',
  minPlayers: 2,
  defs: [
    { key: 'category', label: 'Kategori', type: 'choice', def: 'mix', options: [['mix', 'Karışık'], ['film', 'Filmler'], ['dizi', 'Diziler'], ['cizgi', 'Çizgi filmler'], ['anime', 'Animeler']] },
    { key: 'perPlayer', label: 'Kişi başı anlatma', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'kez' },
    { key: 'writeTime', label: 'Emoji yazma süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
    { key: 'guessTime', label: 'Tahmin süresi', type: 'num', def: 60, min: 15, max: 180, step: 5, unit: 'sn' },
  ],
};
GAMES.cogunluk = {
  name: 'Çoğunluğu Bil',
  emoji: '📊',
  desc: 'Evet/hayır sorularına herkes cevap verir ve kaç kişinin "Evet" diyeceğini tahmin eder. Tam bilen kazanır!',
  minPlayers: 3,
  defs: [
    { key: 'qCount', label: 'Soru sayısı', type: 'num', def: 5, min: 1, max: 10, step: 1, unit: 'soru' },
    { key: 'answerTime', label: 'Cevap süresi', type: 'num', def: 25, min: 10, max: 90, step: 5, unit: 'sn' },
    { key: 'showNames', label: 'Kimin ne dediği görünsün', type: 'bool', def: true },
  ],
};
GAMES.ikidogru = {
  name: 'İki Doğru Bir Yalan',
  emoji: '🎭',
  desc: 'Sırayla biri kendisi hakkında 3 cümle yazar, biri yalan! Diğerleri hemen yalanı bulmaya çalışır.',
  minPlayers: 2,
  defs: [
    { key: 'writeTime', label: 'Yazma süresi', type: 'num', def: 75, min: 30, max: 240, step: 15, unit: 'sn' },
    { key: 'guessTime', label: 'Tahmin süresi', type: 'num', def: 30, min: 10, max: 90, step: 5, unit: 'sn' },
  ],
};
GAMES.sirala = {
  name: 'Sıralama',
  emoji: '📏',
  desc: 'Sırayla biri sorar: "Burada en çok kim uyur?" Herkes grubu sıralar, grubun ortak sıralamasına en yakın olan kazanır!',
  minPlayers: 3,
  defs: [
    { key: 'perPlayer', label: 'Kişi başı soru', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'soru' },
    { key: 'askTime', label: 'Soru yazma süresi', type: 'num', def: 40, min: 15, max: 120, step: 5, unit: 'sn' },
    { key: 'rankTime', label: 'Sıralama süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
  ],
};
GAMES.adam = {
  name: 'Adam Asmaca',
  emoji: '🪢',
  desc: 'Sırayla biri gizli bir kelime yazar, diğerleri sırayla harf seçer. Adam asılmadan kelimeyi bulun!',
  minPlayers: 2,
  defs: [
    { key: 'source', label: 'Kelimeler', type: 'choice', def: 'own', options: [['own', 'Oyuncular yazsın'], ['bank', 'Hazır kelimeler']] },
    { key: 'category', label: 'Kategori', type: 'choice', def: 'mix', options: [['mix', 'Karışık'], ['hayvan', 'Hayvanlar'], ['yiyecek', 'Yiyecekler'], ['yer', 'Şehir & Ülke'], ['meslek', 'Meslekler'], ['esya', 'Eşyalar'], ['film', 'Film & Dizi']], showIf: (c) => c.source === 'bank' },
    { key: 'perPlayer', label: 'Kişi başı kelime', type: 'num', def: 1, min: 1, max: 3, step: 1, unit: 'kelime' },
    { key: 'lives', label: 'Hak', type: 'choice', def: '8', options: [['6', '6 hak (zor)'], ['8', '8 hak'], ['10', '10 hak (kolay)']] },
    { key: 'writeTime', label: 'Kelime yazma süresi', type: 'num', def: 40, min: 15, max: 120, step: 5, unit: 'sn', showIf: (c) => c.source === 'own' },
    { key: 'moveTime', label: 'Hamle süresi', type: 'num', def: 20, min: 10, max: 60, step: 5, unit: 'sn' },
  ],
};
GAMES.vampir = {
  name: 'Vampir Köyü',
  emoji: '🧛',
  desc: 'Gizli roller, gece hamleleri, gündüz oylaması! Herkes her gece bir şey yapar, ısırıklar can götürür, ölülerin rolü gizli kalır. Kan Ayı doğmadan vampiri bulun!',
  minPlayers: 4,
  defs: [
    { key: 'vamps', label: 'Vampir sayısı', type: 'choice', def: 'auto', options: [['auto', 'Otomatik'], ['1', '1'], ['2', '2'], ['3', '3']] },
    { key: 'nights', label: 'Kan Ayı (kaç gece sürsün)', type: 'num', def: 4, min: 2, max: 8, step: 1, unit: 'gece' },
    { key: 'hearts', label: 'Can', type: 'choice', def: '2', options: [['2', '2 can (önerilen)'], ['1', 'Tek ısırık öldürür']] },
    { key: 'reveal', label: 'Ölenin rolü', type: 'choice', def: 'none', options: [['none', 'Gizli (Mezarcı öğrenir)'], ['team', 'Sadece tarafı'], ['role', 'Açıklansın']] },
    { key: 'neutral', label: 'Tarafsız roller (Soytarı, Gezgin)', type: 'bool', def: true },
    { key: 'nightTime', label: 'Gece süresi', type: 'num', def: 45, min: 15, max: 120, step: 5, unit: 'sn' },
    { key: 'dayTime', label: 'Gündüz (konuşma + oylama)', type: 'num', def: 150, min: 30, max: 400, step: 15, unit: 'sn' },
  ],
};
GAMES.zar = {
  name: 'Yalan Zar',
  emoji: '🎲',
  desc: 'Herkesin gizli zarları var. "Masada en az 4 tane 5 var!" diye iddiayı artırın ya da "Yalan!" deyin. Yanılan zar kaybeder, son kalan kazanır.',
  minPlayers: 2,
  defs: [
    { key: 'dice', label: 'Kişi başı zar', type: 'choice', def: '5', options: [['3', '3 zar (kısa)'], ['4', '4 zar'], ['5', '5 zar']] },
    { key: 'jokers', label: "1'ler joker olsun (her sayı yerine geçer)", type: 'bool', def: true },
    { key: 'moveTime', label: 'Hamle süresi', type: 'num', def: 30, min: 10, max: 90, step: 5, unit: 'sn' },
  ],
};
GAMES.patates = {
  name: 'Sıcak Patates',
  emoji: '💣',
  desc: 'Bir kategori gelir: "M ile başlayan bir şehir"! Cevabını yaz, bombayı sonrakine at. Bomba ne zaman patlayacağı belli olmadan tıkır tıkır işliyor…',
  minPlayers: 2,
  defs: [
    { key: 'lives', label: 'Can', type: 'choice', def: '2', options: [['1', '1 can'], ['2', '2 can'], ['3', '3 can']] },
    { key: 'fuse', label: 'Bomba süresi', type: 'choice', def: 'normal', options: [['short', 'Kısa (10-25 sn)'], ['normal', 'Normal (20-45 sn)'], ['long', 'Uzun (35-70 sn)']] },
  ],
};
GAMES.taklit = {
  name: 'Taklitçi',
  emoji: '🥸',
  desc: 'Herkes gizlice bir arkadaşını oynuyor! Her soruya hem kendin hem de onun ağzından cevap yaz. Hangisi gerçek, hangisi taklit? Sonda maskeler düşer.',
  minPlayers: 4,
  defs: [
    { key: 'rounds', label: 'Soru sayısı', type: 'num', def: 3, min: 2, max: 6, step: 1, unit: 'soru' },
    { key: 'writeTime', label: 'Yazma süresi', type: 'num', def: 120, min: 45, max: 300, step: 15, unit: 'sn' },
    { key: 'voteTime', label: 'Oylama süresi', type: 'num', def: 60, min: 20, max: 180, step: 10, unit: 'sn' },
  ],
};
const GAME_ORDER = ['hangimiz', 'kimyazdi', 'asla', 'komik', 'yalanci', 'kackac', 'ikiz', 'tele', 'ayna', 'emoji', 'cogunluk', 'ikidogru', 'sirala', 'adam', 'vampir', 'zar', 'patates', 'taklit', 'quiz', 'cinayet', 'kafe'];
GAMES.kafe = {
  name: 'Kafe Savaşları',
  emoji: '☕',
  desc: 'Herkes bir kafe işletiyor! Her gün fiyatını belirle, yatırım yap, istersen rakibine fare ihbarı yap. Müşteriler en cazip kafeye gider, en zengin olan kazanır.',
  minPlayers: 2,
  defs: [
    { key: 'days', label: 'Kaç gün sürsün', type: 'num', def: 6, min: 3, max: 10, step: 1, unit: 'gün' },
    { key: 'planTime', label: 'Günlük karar süresi', type: 'num', def: 60, min: 20, max: 180, step: 10, unit: 'sn' },
  ],
};
GAMES.cinayet = {
  name: 'Cinayet Gecesi',
  emoji: '🔪',
  desc: 'Köşkte bir cinayet işlendi ve katil aranızda! Herkesin bir karakteri, mazereti ve gizli ipuçları var. 3 turda ipuçlarını birleştirin, katili yakalayın.',
  minPlayers: 4,
  defs: [
    { key: 'discussTime', label: 'Tur başına konuşma süresi', type: 'num', def: 150, min: 45, max: 600, step: 15, unit: 'sn' },
  ],
};
GAMES.quiz = {
  name: 'Bilgi Yarışması',
  emoji: '🧠',
  desc: 'Fotoğraftan ülkeyi bul, haritada yerini işaretle, Türk ve yabancı diziler, genel kültür… Herkes aynı anda cevaplar, hızlı bilen daha çok puan alır!',
  minPlayers: 2,
  defs: [
    { key: 'category', label: 'Konu', type: 'choice', def: 'mix', options: [['mix', 'Karışık (hepsi)'], ['yer', '📸 Fotoğraflı yerler'], ['harita', '🗺️ Haritada Bul'], ['trdizi', '🇹🇷 Türk dizileri'], ['dizi', '📺 Yabancı diziler'], ['genel', '💡 Genel kültür']] },
    { key: 'qCount', label: 'Soru sayısı', type: 'num', def: 10, min: 5, max: 25, step: 1, unit: 'soru' },
    { key: 'time', label: 'Soru süresi', type: 'num', def: 20, min: 10, max: 60, step: 5, unit: 'sn' },
  ],
};
// Each game's theme colour (cards in the game picker).
const GAME_COLORS = {
  hangimiz: '#8b5cf6', kimyazdi: '#6366f1', asla: '#f59e0b', komik: '#eab308', yalanci: '#ef4444', kackac: '#06b6d4',
  ikiz: '#ec4899', tele: '#d946ef', ayna: '#60a5fa', emoji: '#fb923c', cogunluk: '#22c55e', ikidogru: '#f43f5e',
  sirala: '#84cc16', adam: '#b45309', vampir: '#b91c1c', zar: '#0f9488', patates: '#ea580c', taklit: '#2dd4bf', quiz: '#3b82f6', cinayet: '#64748b', kafe: '#a16207',
};
// Games with their own flow instead of write → answer → results.
const GAME_PHASE = { yalanci: 'lie', kackac: 'kac', ikiz: 'ikiz', tele: 'tele', ayna: 'ayna', emoji: 'emo', cogunluk: 'cog', ikidogru: 'iky', sirala: 'sir', adam: 'adam', vampir: 'vamp', zar: 'zar', patates: 'pat', taklit: 'tak', quiz: 'quiz', cinayet: 'cin', kafe: 'kafe' };

const EMO_POINTS = [300, 200];      // 1st and 2nd correct guess; everyone after gets EMO_POINTS_REST
const EMO_POINTS_REST = 100;
const EMO_NARRATOR_POINTS = 50;      // narrator, per player who got it
const EMO_MAX_CLUE = 3;         // emoji per clue (counted as people see them, so 👨‍🍳 is one)
const EMO_HINT_FIRST = 20;      // seconds of guessing before the first letter hint
const EMO_HINT_EVERY = 15;      // then one more letter this often
const EMO_HINT_SHARE = 0.5;     // never give away more than half of the letters
const EMO_REROLLS = 2;
const COG_EXACT_POINTS = 200;
const COG_CLOSE_POINTS = 100;        // off by one
const IKY_FOUND_POINTS = 100;
const IKY_FOOL_POINTS = 50;          // author, per player who picked a true statement
const SIR_POS_POINTS = 50;           // per correctly placed person
const SIR_PERFECT_BONUS = 100;

// t = answer shown, a = other accepted spellings.
// EMO_ITEMS (Emojiyle Anlat titles) lives in emo-items.js, loaded before this file.

/* ---------- Kafe Savaşları data ---------- */

const KAFE_START = 1000;      // money at the start
const KAFE_RENT = 80;         // every day
const KAFE_UNIT = 12;         // cost of one cup
const KAFE_SABOTAGES = 2;     // per game
const KAFE_EMOJIS = ['☕', '🧁', '🥐', '🍩', '🧋', '🍰', '🥯', '🍪', '🫖', '🥞'];
const KAFE_INV = {
  none: { e: '💤', n: 'Bir şey yapma', d: 'Para cebinde kalsın', cost: 0 },
  bean: { e: '☕', n: 'Kaliteli çekirdek', d: 'Bugün kahven çok daha lezzetli', cost: 150 },
  ad: { e: '📣', n: 'Reklam', d: 'Bugün çok daha fazla kişi seni görür', cost: 200 },
  decor: { e: '🪴', n: 'Dekorasyon', d: 'Mekan kalıcı olarak güzelleşir', cost: 300 },
  barista: { e: '🧑‍🍳', n: 'Barista eğitimi', d: 'Kahven kalıcı olarak iyileşir', cost: 250 },
};
const KAFE_SAB = {
  rat: { e: '🐀', n: 'Fare ihbarı', d: 'Rakibin bugün müşterilerinin yarısını kaybeder' },
  review: { e: '👎', n: 'Kötü yorum', d: 'Rakibinin itibarı kalıcı olarak düşer' },
};
// c = customers ×, el = how much people care about price, ad = advert ×, unit = cup cost, tax, q = quality matters ×
const KAFE_EVENTS = [
  { e: '☀️', t: 'Güneşli bir gün! Semtte herkes dışarıda.', c: 1.3 },
  { e: '☔', t: 'Yağmur yağıyor. Müşteri az ama fiyata pek bakmıyorlar.', c: 0.75, el: 1 },
  { e: '🎓', t: 'Okullar açıldı, öğrenciler akın etti! Ama bütçeleri kısıtlı.', c: 1.25, el: 2.2 },
  { e: '📱', t: 'Bir fenomen semtte geziyor: bugün reklam iki kat etkili!', ad: 2 },
  { e: '📈', t: 'Kahve çekirdeği zamlandı! Bugün her fincanın maliyeti 20₺.', unit: 20 },
  { e: '🧾', t: 'Vergi günü! Herkes 150₺ vergi ödüyor.', tax: 150 },
  { e: '🎉', t: 'Semtte festival var! Müşteri iki katı.', c: 2 },
  { e: '😴', t: 'Sakin bir pazartesi. Herkes evde.', c: 0.7 },
  { e: '🌟', t: 'Ünlü bir gurme eleştirmen geliyor: bugün kalite her zamankinden önemli!', q: 2 },
  { e: '❄️', t: 'Kar yağıyor! Sıcak bir kahve için fiyat umursanmıyor.', c: 0.9, el: 0.9 },
];
const KAFE_OPENING = { e: '🎀', t: 'Kafeler bugün açılıyor! Bol şans.' };

/* ---------- Cinayet Gecesi data ---------- */

// n = name, de = "in the …", ye = "into the …" (Turkish suffixes depend on the word, so they are written out).
const CIN_ROOMS = [
  { n: 'Kütüphane', de: 'Kütüphanede', ye: 'Kütüphaneye' }, { n: 'Mutfak', de: 'Mutfakta', ye: 'Mutfağa' },
  { n: 'Bahçe', de: 'Bahçede', ye: 'Bahçeye' }, { n: 'Şarap Mahzeni', de: 'Şarap Mahzeninde', ye: 'Şarap Mahzenine' },
  { n: 'Balo Salonu', de: 'Balo Salonunda', ye: 'Balo Salonuna' }, { n: 'Çalışma Odası', de: 'Çalışma Odasında', ye: 'Çalışma Odasına' },
  { n: 'Kış Bahçesi', de: 'Kış Bahçesinde', ye: 'Kış Bahçesine' }, { n: 'Bilardo Odası', de: 'Bilardo Odasında', ye: 'Bilardo Odasına' },
];
const CIN_WEAPONS = [
  { n: 'Gümüş Şamdan', e: '🕯️', k: 'darbe' }, { n: 'Golf Sopası', e: '🏌️', k: 'darbe' }, { n: 'Kristal Vazo', e: '🏺', k: 'darbe' },
  { n: 'Mutfak Bıçağı', e: '🔪', k: 'kesici' }, { n: 'Bahçe Makası', e: '✂️', k: 'kesici' },
  { n: 'İpek Kravat', e: '👔', k: 'bogma' }, { n: 'Perde İpi', e: '🪢', k: 'bogma' },
  { n: 'Zehirli Çay', e: '🍵', k: 'zehir' }, { n: 'Zehirli Şarap', e: '🍷', k: 'zehir' },
];
const CIN_AUTOPSY = {
  darbe: 'Başına sert bir cisimle vurulmuş.', kesici: 'Keskin bir aletle yaralanmış.', bogma: 'Boğularak öldürülmüş.', zehir: 'Zehirlenmiş, bardağında tuhaf bir koku var.',
};
const CIN_CHARS = [
  { e: '👨‍🍳', n: 'Aşçı', m: 'Ev sahibi seni hırsızlıkla suçlayıp kovmak üzereydi.' },
  { e: '🧑‍🌾', n: 'Bahçıvan', m: 'Bahçeye gömülü bir sırrını öğrenmişti.' },
  { e: '🤵', n: 'Uşak', m: 'Yıllardır maaşını eksik ödüyordu.' },
  { e: '🧑‍⚕️', n: 'Aile Doktoru', m: 'Yanlış verdiğin bir ilacı biliyordu.' },
  { e: '🧑‍💼', n: 'Avukat', m: 'Vasiyeti senin aleyhine değiştirmek üzereydi.' },
  { e: '💃', n: 'Eski Eş', m: 'Boşanmada her şeyini almıştı.' },
  { e: '🧑‍🎨', n: 'Ressam', m: 'Tablolarının sahte olduğunu herkese söyleyecekti.' },
  { e: '🎻', n: 'Kemancı', m: 'Konserini son anda iptal ettirip seni rezil etmişti.' },
  { e: '📰', n: 'Gazeteci', m: 'Yazacağın haberi durdurmak için seni tehdit etmişti.' },
  { e: '🚗', n: 'Şoför', m: 'Kaza yaptığını polise söyleyecekti.' },
  { e: '👒', n: 'Yeğen', m: 'Mirastan seni çıkardığını yeni öğrenmiştin.' },
  { e: '🧳', n: 'Uzak Akraba', m: 'Borç para istediğinde herkesin önünde seni kovmuştu.' },
];
// t = public evidence text, s = what a witness saw in the corridor.
const CIN_TRAITS = [
  { e: '🚬', n: 'Sigara içiyor', t: 'sigara külü bulundu', s: 'elinde sigara olan' },
  { e: '✋', n: 'Solak', t: 'darbenin soldan geldiği anlaşıldı, katil solak olabilir', s: 'sol eliyle kapıyı açan' },
  { e: '👓', n: 'Gözlüklü', t: 'kırık bir gözlük camı bulundu', s: 'gözlüklü' },
  { e: '🌹', n: 'Gül parfümü sürüyor', t: 'gül parfümü kokusu vardı', s: 'gül parfümü kokan' },
  { e: '🧤', n: 'Deri eldivenli', t: 'deri eldiven izleri vardı', s: 'deri eldiven giymiş' },
  { e: '👞', n: 'Ayakkabısı çamurlu', t: 'çamurlu ayak izleri vardı', s: 'ayakkabısı çamurlu' },
  { e: '🎩', n: 'Şapkalı', t: 'yerde bir şapka tüyü vardı', s: 'şapkalı' },
  { e: '💍', n: 'Yüzük takıyor', t: 'kurbanın yanağında bir yüzük çiziği vardı', s: 'parmağında büyük bir yüzük olan' },
];
const CIN_VICTIMS = ['Ragıp Bey', 'Madam Nermin', 'Profesör Cemil', 'Kontes Leyla', 'Hacı Fehmi Bey', 'Sabiha Hanım'];
const CIN_PLACES = ['Boğaz kıyısındaki eski yalıda', 'Uludağ eteklerindeki dağ köşkünde', 'Bodrum\'daki taş konakta', 'Kapadokya\'daki mağara otelde'];
const CIN_ROUNDS = 3;
const CIN_WIN_POINTS = 300;      // every innocent, when the killer is caught
const CIN_VOTE_POINTS = 200;     // you personally pointed at the killer
const CIN_WEAPON_POINTS = 100;   // you also got the weapon right
const CIN_ESCAPE_POINTS = 600;   // killer got away
const CIN_DODGE_POINTS = 100;    // killer: per vote that went to someone else

/* ---------- Bilgi Yarışması ---------- */

const QUIZ_BASE = 500;          // right answer
const QUIZ_SPEED = 500;         // up to this much more for answering fast
const QUIZ_MAP_EXTRA = 10;      // map questions get extra seconds
const QUIZ_WORLD_KM = 3000;     // map guesses this far away score 0
const QUIZ_TR_KM = 500;

function quizImg(file) {
  return 'https://commons.wikimedia.org/wiki/Special:FilePath/' + encodeURIComponent(file) + '?width=960';
}

function distKm(a, b, c, d) {
  const rad = Math.PI / 180;
  const x = Math.sin((c - a) * rad / 2) ** 2 + Math.cos(a * rad) * Math.cos(c * rad) * Math.sin((d - b) * rad / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(x));
}

// Picks the questions for one game: photo (4 options), map (click on a map) and text questions.
function buildQuiz(cat, n) {
  const places = shuffle(QUIZ_PLACES);
  const texts = shuffle(QUIZ_TEXT);
  const takePlace = (mapOk) => {
    const i = places.findIndex((p) => mapOk || !p.mapOnly);
    return i < 0 ? null : places.splice(i, 1)[0];
  };
  const takeText = (c) => {
    const i = texts.findIndex((x) => !c || x.c === c);
    return i < 0 ? null : texts.splice(i, 1)[0];
  };
  const photo = (p) => {
    const right = p.c;
    const pool = p.tr ? QUIZ_ILLER : QUIZ_COUNTRIES;
    const opts = shuffle([right, ...shuffle(pool.filter((x) => x !== right)).slice(0, 3)]);
    return { type: 'photo', cat: p.tr ? '📸 Türkiye' : '📸 Dünya', text: p.tr ? 'Bu fotoğraf hangi ilimizde?' : 'Bu fotoğraf hangi ülkede?',
      img: quizImg(p.f), opts, ans: opts.indexOf(right), place: p.n + ' · ' + right };
  };
  const map = (p) => ({ type: 'map', cat: '🗺️ Haritada Bul', text: 'Bu fotoğraf nerede? Haritada işaretle!', img: quizImg(p.f), tr: p.tr,
    lat: p.lat, lng: p.lng, place: p.n + ' · ' + p.c });
  const text = (x) => {
    const opts = shuffle([x.a, ...x.w]);
    return { type: 'text', cat: QUIZ_CAT_NAMES[x.c], text: x.q, opts, ans: opts.indexOf(x.a), place: x.a };
  };
  // What kinds of question to ask, in order.
  let plan;
  if (cat === 'harita') plan = Array(n).fill('map');
  else if (cat === 'yer') plan = Array.from({ length: n }, (_, i) => (i % 5 === 2 || i % 5 === 4 ? 'map' : 'photo'));
  else if (cat === 'mix') {
    const nPhoto = Math.round(n * 0.3);
    const nMap = Math.round(n * 0.2);
    const kinds = ['trdizi', 'dizi', 'genel'];
    plan = [...Array(nPhoto).fill('photo'), ...Array(nMap).fill('map'), ...Array.from({ length: n - nPhoto - nMap }, (_, i) => 'text:' + kinds[i % 3])];
    plan = shuffle(plan);
  } else plan = Array(n).fill('text:' + cat);
  const out = [];
  for (const k of plan) {
    let q = null;
    if (k === 'photo') { const p = takePlace(false); if (p) q = photo(p); }
    else if (k === 'map') { const p = takePlace(true); if (p) q = map(p); }
    else { const x = takeText(k.split(':')[1]); if (x) q = text(x); }
    if (!q) { const x = takeText(null); if (x) q = text(x); }
    if (q) out.push(q);
  }
  return out;
}

/* ---------- Taklitçi data ---------- */

const TAK_MAX = 120;              // characters per answer
const TAK_REAL_POINTS = 100;      // you picked the real answer
const TAK_FOOL_POINTS = 100;      // per person who took your imitation for the real thing
const TAK_GUESS_POINTS = 200;     // you found who was playing you
const TAK_HIDDEN_POINTS = 100;    // the person you played never found you
const TAK_GUESS_SECONDS = 60;

const TAK_QUESTIONS = [
  'Alarm çalınca ilk ne yaparsın?', 'Bir milyon lira kazansan ilk ne alırsın?', 'En sevdiğin yemek ne?', 'Cuma akşamı ideal planın ne?',
  'Seni en çok ne sinirlendirir?', 'Çocukken ne olmak istiyordun?', 'Telefonunda en çok hangi uygulamada vakit geçirirsin?',
  'Bir süper gücün olsa ne olurdu?', 'Issız adaya yanına alacağın tek şey?', 'En büyük korkun ne?', 'Kahvaltıda ne yersin?',
  'Bir günlüğüne kim olmak isterdin?', 'Tatilde dağ mı deniz mi, neden?', 'Bu grubu bir kelimeyle anlat', 'Kendini bir hayvana benzetsen hangisi?',
  'En sevdiğin dizi ya da film?', 'Bir şarkıyı sonsuza dek dinlemek zorunda kalsan hangisi?', 'Paranı en çok neye harcarsın?',
  'Sınav ya da önemli bir gün öncesi gece ne yaparsın?', 'Mesaja geç dönünce bahanen ne olur?', 'Yalnız kalınca ne yaparsın?',
  'En sevdiğin mevsim ve nedeni?', 'En kötü huyun ne?', 'Bir gün görünmez olsan ne yaparsın?', 'Kızınca ne yaparsın?',
  'En son aldığın gereksiz şey ne?', 'Doğum gününde ne hediye istersin?', 'Pazar günü saat kaçta kalkarsın?', 'Zombi kıyametinde ilk ne yaparsın?',
  'Restoranda hep ne sipariş edersin?', 'Kendini 3 emojiyle anlat', 'Asla yemem dediğin yemek ne?', 'En çok kullandığın laf ya da kelime ne?',
  'Telefonun düşüp kırılsa ilk tepkin ne olur?', 'Hayalindeki ev nasıl?', 'Bir saat boş vaktin olsa ne yaparsın?', 'Grup sohbetine en çok ne atarsın?',
  'Seni en çok ne güldürür?', 'Bir yeteneğin olsun isterdin, ne?', 'En iyi yaptığın yemek ne?', 'Bir günlük kral olsan ilk kanunun ne olurdu?',
  'Uyumadan önce son yaptığın şey ne?', 'Ünlü olsan neyle ünlü olurdun?', 'En sevdiğin atıştırmalık ne?', 'Tanımadığın biriyle asansörde kalsan ne yaparsın?',
  'Hayatının filmi çekilse adı ne olurdu?', 'Hangi devirde yaşamak isterdin?', 'Bir arkadaşın sana sır verse ne yaparsın?', 'Sabahları nasıl bir insansın?',
];

/* ---------- Yalan Zar / Sıcak Patates data ---------- */

const DIE_FACES = ['', '⚀', '⚁', '⚂', '⚃', '⚄', '⚅'];

const PAT_LETTERS = 'ABCÇDEFGHIKLMNOPRSŞTUYZ';
const PAT_LETTER_CATS = ['bir şehir ya da ülke', 'bir hayvan', 'bir yiyecek ya da içecek', 'bir isim (insan adı)', 'bir meslek', 'bir eşya', 'bir ünlü', 'bir film, dizi ya da çizgi film', 'bir marka', 'bir meyve ya da sebze'];
const PAT_FREE = [
  'Mutfakta bulunan bir şey', 'Denizde yaşayan bir canlı', 'Kırmızı renkli bir şey', 'Bir futbol takımı', 'Bir süper kahraman', 'Bir şarkıcı',
  'Bir bilgisayar oyunu', 'Okulda olan bir şey', 'Bir spor dalı', 'Bir müzik aleti', 'Bir uygulama ya da site', 'Yazın yapılan bir şey',
  'Kışın giyilen bir şey', 'Bir tatlı', 'Bir çizgi film karakteri', 'Uçabilen bir şey', 'Banyoda bulunan bir şey', 'Bir araba markası',
  'Bir vücut parçası', 'Bir Türk yemeği', 'Bir renk', 'Bir sokak lezzeti', 'Bir hayvan sesi', 'Bir ülkenin başkenti', 'Yeşil renkli bir şey',
  'Bir kahvaltılık', 'Bir doğum günü hediyesi', 'Bir tatil yeri', 'Bir masal karakteri', 'Bir kuş', 'Bir böcek', 'Bir çiçek', 'Bir oyuncak',
];

// A random prompt: either "X ile başlayan <category>" or a free one.
function patPrompt(avoid) {
  for (let k = 0; k < 30; k++) {
    const p = Math.random() < 0.6
      ? { letter: PAT_LETTERS[Math.floor(Math.random() * PAT_LETTERS.length)], cat: PAT_LETTER_CATS[Math.floor(Math.random() * PAT_LETTER_CATS.length)] }
      : { letter: null, cat: PAT_FREE[Math.floor(Math.random() * PAT_FREE.length)] };
    p.text = p.letter ? p.letter + ' ile başlayan ' + p.cat : p.cat;
    if (!avoid.includes(p.text)) return p;
  }
}

const PAT_FUSE = { short: [10, 25], normal: [20, 45], long: [35, 70] };

/* ---------- Vampir Köyü rules (shared by host and screens) ---------- */

const VAMP_TEAMS = {
  koy: { e: '🏡', n: 'Köy' },
  vamp: { e: '🧛', n: 'Vampirler' },
  neutral: { e: '🎭', n: 'Tarafsız' },
};

// kinds = what the role may do at night (the first one is its main move).
const VAMP_ROLES = {
  koylu: { e: '👨‍🌾', n: 'Köylü', team: 'koy', kinds: ['watch'], d: 'Sıradan ama gözü açık. Her gece bir evi pencereden izler ve o eve kaç kişinin geldiğini öğrenir.' },
  kahin: { e: '🔮', n: 'Kâhin', team: 'koy', kinds: ['seer'], d: 'Her gece birinin hangi tarafta olduğunu görür. Ama Drakula ile Uşak ona köylü gibi görünür!' },
  doktor: { e: '🩺', n: 'Doktor', team: 'koy', kinds: ['heal'], d: 'Her gece birinin yarasını sarar, 1 can geri verir (ölmek üzere olanı kurtarabilir). Aynı kişiyi üst üste iki gece iyileştiremez, kendini bir kez iyileştirebilir.' },
  sarimsak: { e: '🧄', n: 'Sarımsakçı', team: 'koy', kinds: ['garlic'], d: 'Her gece bir kapıya sarımsak asar. O eve gelen vampir geri döner, sen de bir vampirin geldiğini öğrenirsin.' },
  avci: { e: '🏹', n: 'Avcı', team: 'koy', kinds: ['stake', 'watch'], d: 'Oyunda bir kez gümüş ok atar. Vampire denk gelirse vampir ölür, masuma denk gelirse onu yaralar (1 can). Diğer geceler ev izler.' },
  dedektif: { e: '🕵️', n: 'Dedektif', team: 'koy', kinds: ['track'], d: 'Her gece birini takip eder ve o gece kimin evine gittiğini öğrenir.' },
  zangoc: { e: '🔦', n: 'Bekçi', team: 'koy', kinds: ['bell', 'watch'], d: 'Oyunda bir kez düdüğünü çalar: bütün köy uyanır, o gece bütün ısırıklar boşa gider ama herkes düdüğü duyar. Diğer geceler ev izler.' },
  mezarci: { e: '⚰️', n: 'Mezarcı', team: 'koy', kinds: ['grave', 'watch'], d: 'Ölenlerin rolü gizlidir. Mezarcı her gece bir mezarı açıp oradakinin rolünü öğrenir. Mezar yoksa ev izler.' },
  polis: { e: '👮', n: 'Polis', team: 'koy', kinds: ['jail', 'shoot'], d: 'Her gece birini sorguya alabilir: o kişi geceyi karakolda geçirir (hiçbir şey yapamaz, kimse ona ulaşamaz) ve Polis onun o gece ne yapmaya hazırlandığını öğrenir. Ya da silahını kullanır (2 mermi): vurduğu kişi vampir tarafındaysa ölür, masumsa vurulana bir şey olmaz ama Polis vicdan azabından kendisi ölür!' },
  muhtar: { e: '📯', n: 'Muhtar', team: 'koy', kinds: ['watch'], d: 'Gündüz oylamasında oyu 2 sayılır. Geceleri köylü gibi bir evi izler.' },
  vampir: { e: '🧛', n: 'Vampir', team: 'vamp', kinds: ['bite'], d: 'Her gece birini ısırır, 1 can götürür. Kan Ayı doğana kadar yakalanmazsan ya da köy azalıp size yetişemezse kazanırsınız.' },
  kont: { e: '🦇', n: 'Drakula', team: 'vamp', kinds: ['bite'], d: 'Vampirlerin efendisi. Vampir gibi ısırır ama Kâhin ona bakınca köylü görür.' },
  usak: { e: '🧟', n: 'Uşak', team: 'vamp', kinds: ['block'], d: 'Vampirlere hizmet eden bir insan. Her gece birini oyalar: o kişi o gece hiçbir şey yapamaz. Kâhin ona köylü der.' },
  soytari: { e: '🃏', n: 'Soytarı', team: 'neutral', kinds: ['roam'], d: 'Tek derdi gündüz köyden sürülmek! Köy onu sürgün ederse tek başına kazanır. Geceleri kapı çalıp kaçar, izleyenleri şaşırtır.' },
  gezgin: { e: '🎒', n: 'Gezgin', team: 'neutral', kinds: ['hide', 'watch'], d: 'Tek derdi hayatta kalmak. 1 fazla canı var ve oyunda iki kez saklanabilir (o gece kimse ona ulaşamaz). Oyun sonunda hayattaysa o da kazanır.' },
};

const VAMP_KINDS = {
  watch: { b: '👀 Ev izle', q: 'Hangi evi izleyeceksin? Sabah oraya kaç kişi geldiğini öğrenirsin.', t: 'others' },
  seer: { b: '🔮 Tarafına bak', q: 'Kimin tarafına bakacaksın?', t: 'others' },
  heal: { b: '🩺 İyileştir', q: 'Kimin yarasını saracaksın?', t: 'heal', visit: true },
  garlic: { b: '🧄 Sarımsak as', q: 'Hangi kapıya sarımsak asacaksın?', t: 'all', visit: true },
  stake: { b: '🏹 Ok at', q: 'Gümüş oku kime atacaksın? Tek hakkın var!', t: 'others', visit: true },
  track: { b: '🕵️ Takip et', q: 'Kimi takip edeceksin?', t: 'others' },
  bell: { b: '📣 Düdük çal', q: 'Düdüğü bu gece çalarsan bütün köy uyanır, ısırıklar boşa gider. Tek hakkın var!', t: 'use' },
  grave: { b: '⚰️ Mezar aç', q: 'Hangi mezarı açacaksın?', t: 'dead' },
  bite: { b: '🧛 Isır', q: 'Kimi ısıracaksınız?', t: 'prey', visit: true },
  block: { b: '🧟 Oyala', q: 'Kimi oyalayacaksın? O gece hiçbir şey yapamaz.', t: 'notmates', visit: true },
  roam: { b: '🃏 Kapı çal', q: 'Kimin kapısını çalıp kaçacaksın?', t: 'others', visit: true },
  jail: { b: '🔍 Sorgula', q: 'Kimi sorguya alacaksın? Geceyi karakolda geçirir, ne yapmaya hazırlandığını öğrenirsin.', t: 'others', visit: true },
  shoot: { b: '🔫 Vur', q: 'Kimi vuracaksın? Vampir tarafındaysa ölür. Masumsa sen ölürsün!', t: 'others', visit: true },
  hide: { b: '🎒 Saklan', q: 'Bu gece saklanırsan kimse sana ulaşamaz. 2 hakkın var.', t: 'use' },
};

const VAMP_ROLE_SECONDS = 40;
const VAMP_EXTRA_POOL = ['doktor', 'sarimsak', 'avci', 'dedektif', 'zangoc', 'mezarci', 'muhtar', 'polis'];
const VAMP_BULLETS = 2;

// What the Polis hears in the interrogation room: the plan the suspect had for tonight.
const VAMP_PLANS = {
  watch: 'bir evi izlemeye', seer: 'birinin tarafına bakmaya', heal: 'birinin yarasını sarmaya', garlic: 'bir kapıya sarımsak asmaya',
  stake: 'gümüş ok atmaya', track: 'birini takip etmeye', bell: 'düdük çalmaya', grave: 'mezar açmaya', bite: 'birini ısırmaya 🧛',
  block: 'birini oyalamaya', roam: 'kapı çalıp kaçmaya', hide: 'saklanmaya', jail: 'birini sorgulamaya', shoot: 'birini vurmaya', pass: 'hiçbir şey yapmamaya',
};

// Which moves this player may make tonight. ctx: { self, role, alive, roster, mates, used, lastHeal }
function vampKindsFor(ctx) {
  const R = VAMP_ROLES[ctx.role];
  const u = ctx.used || {};
  const anyDead = ctx.roster.some((id) => !ctx.alive[id]);
  return R.kinds.filter((k) => !(k === 'shoot' && (u.bullets || 0) >= VAMP_BULLETS) && !(k === 'stake' && u.stake) && !(k === 'bell' && u.bell) && !(k === 'hide' && (u.hide || 0) >= 2) && !(k === 'grave' && !anyDead));
}

function vampTargets(kind, ctx) {
  const t = VAMP_KINDS[kind].t;
  const { self, alive, roster, mates } = ctx;
  const living = roster.filter((id) => alive[id]);
  if (t === 'use') return [];
  if (t === 'dead') return roster.filter((id) => !alive[id]);
  if (t === 'all') return living;
  if (t === 'prey') return living.filter((id) => !mates.includes(id));
  if (t === 'notmates') return living.filter((id) => id !== self && !mates.includes(id));
  if (t === 'heal') return living.filter((id) => id !== ctx.lastHeal && !(id === self && (ctx.used || {}).selfHeal));
  return living.filter((id) => id !== self);
}

// The team a role shows to the Kâhin.
function vampSeenTeam(role) {
  return role === 'kont' || role === 'usak' ? 'koy' : VAMP_ROLES[role].team;
}

const ADAM_ALPHABET = 'ABCÇDEFGĞHIİJKLMNOÖPRSŞTUÜVYZQWX';
const ADAM_MAX_LEN = 24;
const ADAM_PARTS = 10;            // gallows (4) + stick man (6); fewer lives = gallows already standing
const ADAM_LETTER_POINTS = 10;    // per letter revealed by your guess
const ADAM_SOLVE_POINTS = 100;    // guessing the whole word…
const ADAM_HIDDEN_POINTS = 10;    // …plus this per letter that was still hidden
const ADAM_LAST_POINTS = 50;      // revealing the final letter
const ADAM_MISS_POINTS = 15;      // word owner, per wrong guess
const ADAM_HANG_POINTS = 100;     // word owner, nobody found it

const ADAM_BANK = {
  hayvan: { name: 'Hayvan', words: [
    'Zürafa', 'Penguen', 'Timsah', 'Kanguru', 'Su aygırı', 'Gergedan', 'Kirpi', 'Ahtapot', 'Denizatı', 'Yarasa', 'Baykuş',
    'Flamingo', 'Bukalemun', 'Kaplumbağa', 'Sincap', 'Tavuskuşu', 'Papağan', 'Karınca', 'Kelebek', 'Yunus', 'Balina',
    'Köpekbalığı', 'Deve', 'Leopar', 'Çita', 'Panda', 'Koala', 'Tilki', 'Kurbağa', 'Salyangoz', 'Örümcek', 'Akrep',
    'Kartal', 'Martı', 'Leylek', 'Hamster', 'Tavşan', 'Eşek', 'Goril', 'Fil', 'Ayı', 'Kunduz', 'Ateşböceği', 'Denizanası',
  ] },
  yiyecek: { name: 'Yiyecek', words: [
    'Lahmacun', 'Mantı', 'İskender', 'Baklava', 'Künefe', 'Menemen', 'Pide', 'Kokoreç', 'Midye dolma', 'Çiğ köfte',
    'Sucuklu yumurta', 'Mercimek çorbası', 'Karnıyarık', 'İmam bayıldı', 'Sütlaç', 'Aşure', 'Simit', 'Poğaça', 'Gözleme',
    'Pizza', 'Hamburger', 'Spagetti', 'Patates kızartması', 'Dondurma', 'Çikolata', 'Ananas', 'Karpuz', 'Avokado',
    'Brokoli', 'Patlıcan', 'Pastırma', 'Börek', 'Lokum', 'Tantuni', 'Kumpir', 'Waffle', 'Sushi', 'Pankek', 'Cheesecake',
    'Mısır', 'Nar', 'Kestane', 'Turşu', 'Ayran',
  ] },
  yer: { name: 'Şehir & Ülke', words: [
    'İstanbul', 'Ankara', 'İzmir', 'Antalya', 'Trabzon', 'Kapadokya', 'Eskişehir', 'Gaziantep', 'Mardin', 'Bodrum',
    'Erzurum', 'Rize', 'Pamukkale', 'Safranbolu', 'Paris', 'Londra', 'New York', 'Tokyo', 'Roma', 'Venedik', 'Barselona',
    'Amsterdam', 'Dubai', 'Kahire', 'Moskova', 'Berlin', 'Rio de Janeiro', 'Japonya', 'Brezilya', 'Kanada', 'Avustralya',
    'Meksika', 'Mısır', 'Hindistan', 'İtalya', 'İspanya', 'Norveç', 'İzlanda', 'Arjantin', 'Güney Kore', 'Maldivler',
  ] },
  meslek: { name: 'Meslek', words: [
    'Astronot', 'İtfaiyeci', 'Dişçi', 'Veteriner', 'Pilot', 'Aşçı', 'Berber', 'Kuaför', 'Dedektif', 'Arkeolog',
    'Fotoğrafçı', 'Avukat', 'Hakem', 'Garson', 'Postacı', 'Kaptan', 'Çiftçi', 'Bahçıvan', 'Mimar', 'Mühendis', 'Eczacı',
    'Hemşire', 'Öğretmen', 'Kütüphaneci', 'Sihirbaz', 'Palyaço', 'Youtuber', 'Futbolcu', 'Ressam', 'Heykeltıraş',
    'Marangoz', 'Elektrikçi', 'Tesisatçı', 'Kasap', 'Fırıncı', 'Balıkçı', 'Dalgıç', 'Muhabir', 'Programcı', 'Psikolog',
  ] },
  esya: { name: 'Eşya', words: [
    'Şemsiye', 'Buzdolabı', 'Çamaşır makinesi', 'Süpürge', 'Saksı', 'Kumanda', 'Şarj aleti', 'Kulaklık', 'Klavye',
    'Dürbün', 'Pusula', 'Mıknatıs', 'Termos', 'Çaydanlık', 'Tava', 'Kevgir', 'Oklava', 'Makas', 'Zımba', 'Cetvel',
    'Silgi', 'Hesap makinesi', 'Valiz', 'Sırt çantası', 'Yastık', 'Battaniye', 'Ayna', 'Saat', 'Gözlük', 'Eldiven',
    'Atkı', 'Bisiklet', 'Kaykay', 'Paten', 'Fener', 'Mum', 'Kibrit', 'Çekiç', 'Tornavida', 'Merdiven', 'Oyun konsolu',
  ] },
  film: { name: 'Film & Dizi', words: null }, // filled from EMO_ITEMS
};

function adamClean(t) {
  const up = String(t ?? '').toLocaleUpperCase('tr');
  let out = '';
  for (const ch of up) out += ADAM_ALPHABET.includes(ch) ? ch : ch === ' ' ? ' ' : '';
  return out.replace(/ +/g, ' ').trim().slice(0, ADAM_MAX_LEN).trim();
}

function adamLetterCount(word) {
  return [...word].filter((c) => c !== ' ').length;
}

function adamBankWords(cat) {
  const B = ADAM_BANK[cat];
  if (B.words) return B.words;
  // Film & series titles that are plain words (no numbers or signs) and not too long.
  B.words = ['film', 'dizi', 'cizgi'].flatMap((c) => EMO_ITEMS[c].items.map((it) => it.t))
    .filter((t) => /^[\p{L} ]+$/u.test(t) && t.length <= ADAM_MAX_LEN && adamLetterCount(adamClean(t)) >= 4);
  return B.words;
}

// A random { word, hint } from the bank; cat 'mix' picks any category.
function adamPick(cat, avoid = []) {
  const cats = cat === 'mix' || !ADAM_BANK[cat] ? Object.keys(ADAM_BANK) : [cat];
  for (let k = 0; k < 20; k++) {
    const c = cats[Math.floor(Math.random() * cats.length)];
    const list = adamBankWords(c);
    const w = list[Math.floor(Math.random() * list.length)];
    if (!avoid.includes(adamClean(w)) || k === 19) return { word: w, hint: ADAM_BANK[c].name };
  }
}

const COG_QUESTIONS = [
  'Ananaslı pizza sever misin?', 'Hiç uçağa bindin mi?', 'Sabah insanı mısın?', 'Korku filmlerini sever misin?',
  'Kedileri köpeklerden çok mu seversin?', 'Duş alırken şarkı söyler misin?', 'Hiç bir sınavdan kaldın mı?',
  "Telefonunun şarjı şu an %50'nin üstünde mi?", 'Bugün kahvaltı yaptın mı?', 'Uzaya gitmek ister miydin?',
  "Hiç öğretmene yanlışlıkla 'anne' dedin mi?", 'Çayı şekerli mi içersin?', 'Denize girmeyi sever misin?',
  'Hiç ünlü biriyle fotoğraf çektirdin mi?', "Genelde gece 1'den sonra mı yatarsın?", 'Hiç kemiğin kırıldı mı?',
  'Mayonezi ketçaba tercih eder misin?', 'Türkçeden başka bir dil konuşabiliyor musun?', 'Hiç bir çekiliş ya da yarışma kazandın mı?',
  'Karanlıktan korkar mısın?', 'Hiç tek başına sinemaya gittin mi?', 'Evcil hayvanın var mı?', 'Düzenli spor yapıyor musun?',
  'Sınavlara son gece mi çalışırsın?', 'Gözlük ya da lens kullanıyor musun?', 'Patlıcanı sever misin?',
  'Hiç yemek yaparken bir şey yaktın mı?', 'Bir enstrüman çalabiliyor musun?', 'Hiç telefonunu tuvalete düşürdün mü?',
  'Aynı diziyi iki kez baştan izledin mi?', 'Hiç kaybolup yolunu bulamadın mı?', 'Doğum gününü kutlamayı sever misin?',
];

// Ideas for the 🎲 button: "who is the most … here?" questions to rank the group by.
const SIR_IDEAS = [
  'Burada en çok kim uyur?', 'En çok kim geç kalır?', 'En komik kim?', 'En çok kim yer?', 'Telefona en çok kim bakar?',
  'En dağınık kim?', 'En çok kim konuşur?', 'En cimri kim?', 'En romantik kim?', 'En korkak kim?', 'En iyi kim dans eder?',
  'En çok kim ağlar?', 'En sabırsız kim?', 'Ünlü olma ihtimali en yüksek kim?', 'En çok kim alışveriş yapar?',
  'En iyi kim yemek yapar?', 'Zombi kıyametinde en uzun kim yaşar?', 'En iyi yalanı kim söyler?', 'En tembel kim?', 'En sporcu kim?',
];

const IKIZ_MATCH_POINTS = 100;   // you and your secret twin wrote the same thing
const IKIZ_GUESS_POINTS = 200;   // you guessed who your twin is
const TELE_MATCH_POINTS = 200;   // the pair wrote the same thing
const TELE_BET_POINTS = 100;     // you bet right on the pair
const AYNA_RIGHT_POINTS = 100;   // the mirror accepted your guess
const STEP_REVEAL_MS = 10000;    // auto mode: time on a reveal screen
const MAX_WORD = 40;

// Open prompts where people tend to land on the same answer.
const WORD_PROMPTS = [
  'Bir meyve söyle', 'Bir renk söyle', 'Bir hayvan söyle', 'Tatil için bir yer', 'Bir süper güç', 'Bir pizza malzemesi',
  'Bir içecek', 'Kahvaltıda olmazsa olmaz bir şey', 'Bir meslek', '1 ile 10 arasında bir sayı', 'Bir ülke', 'Bir okul dersi',
  'Bir çizgi film karakteri', 'Bir araba markası', 'Bir mevsim', 'Bir şehir', 'Bir tatlı', 'Bir bilgisayar oyunu',
  'Haftanın bir günü', 'Bir sosyal medya uygulaması', 'Bir müzik aleti', 'Bir mutfak eşyası', 'Kırmızı bir şey',
  'Denizde olan bir şey', 'Bir sebze', 'Bir spor', 'Bir dondurma çeşidi', 'Bir ünlü', 'Okulda olan bir şey',
  'Bir doğum günü hediyesi', 'Bir kıyafet', 'Gökyüzünde olan bir şey', 'Bir harf', 'Bir şarkıcı', 'Bir dizi',
  'Bir fast food', 'Soğuk bir şey', 'Yuvarlak bir şey', 'Bir masal kahramanı', 'Bir hafta sonu aktivitesi',
];

// Questions for the mirror, answered with a word or two.
const AYNA_QUESTIONS = [
  'En sevdiğin yemek ne?', 'En sevdiğin renk ne?', 'En sevdiğin dizi ya da film ne?', 'Hayalindeki tatil yeri neresi?',
  'En sevdiğin şarkıcı kim?', 'Bir süper gücün olsa ne olurdu?', 'En çok neyden korkarsın?', 'Kahvaltıda olmazsa olmazın ne?',
  'Hangi ülkede yaşamak isterdin?', 'En sevdiğin hayvan ne?', 'En sevdiğin mevsim hangisi?', 'Telefonunda en çok kullandığın uygulama?',
  'En sevdiğin tatlı ne?', 'Çocukken ne olmak istiyordun?', 'Issız adaya götüreceğin tek şey?', 'En sevdiğin içecek ne?',
  'En sevdiğin oyun ne?', 'Bir gün başka biri olabilsen kim olurdun?', 'En sevdiğin ders hangisi?', 'Şu an canın ne çekiyor?',
  'En sevdiğin çizgi film karakteri?', 'Kendini hangi hayvana benzetirsin?', 'En sevdiğin spor?', 'Seni en çok ne sinirlendirir?',
  'Piyango çıksa ilk ne alırsın?', 'En sevdiğin emoji hangisi?', 'Hafta sonu en çok ne yaparsın?',
];

const KAC_EXACT_POINTS = 200;    // guessed the number exactly
const KAC_CLOSE_POINTS = 100;    // nobody was exact: the closest guess(es)
const KAC_REVEAL_MS = 12000;     // auto mode: time on the reveal screen
const KAC_MAX = 1000000000;

// Ideas for the 🎲 button: questions about yourself that have a number answer.
const KAC_IDEAS = [
  'Dün gece kaç saat uyudum?',
  'Telefonumda kaç fotoğraf var?',
  'Telefonumda kaç uygulama var?',
  'Şu an okunmamış kaç mesajım var?',
  'Telefonumun şarjı şu an yüzde kaç?',
  'Rehberimde kaç kişi kayıtlı?',
  'Kaç tane WhatsApp grubundayım?',
  'Bugün kaç bardak su içtim?',
  'Kaç tane ayakkabım var?',
  'Bugüne kadar kaç ülkeye gittim?',
  'Bir oturuşta en fazla kaç dilim pizza yedim?',
  'Dünkü ekran sürem kaç saatti?',
  'Bu yıl kaç kere sinemaya gittim?',
  'Instagram\'da kaç kişiyi takip ediyorum?',
  'Kaç yaşında bisiklet sürmeyi öğrendim?',
  'Hayatımda kaç evcil hayvanım oldu?',
  'Kaç tane tişörtüm var?',
  'Bugün kaç adım attım?',
  'Kaç numara ayakkabı giyiyorum?',
  'Boyum kaç santim?',
  'En uzun kaç saat uyumadan kaldım?',
  'Haftada kaç saat oyun oynuyorum?',
  'Telefonumda kaç oyun yüklü?',
  'Hayatımda kaç kere taşındım?',
  'Kaç tane kuzenim var?',
  'Bugün kaç kere güldüm?',
  'Tarayıcımda şu an kaç sekme açık?',
  'En sevdiğim çalma listemde kaç şarkı var?',
];
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

// Badges handed out at the end of a round. Each player collects them on their own device.
const BADGES = {
  hz_king: { e: '👑', n: 'Unvan Kralı', d: "Kim En?'de en çok unvanı kaptın" },
  hz_star: { e: '⭐', n: 'Herkesin Gözdesi', d: "Kim En?'de en çok oyu sen aldın" },
  ky_champ: { e: '🏆', n: 'İtiraf Şampiyonu', d: "Kim Yazdı?'yı kazandın" },
  ky_detective: { e: '🕵️', n: 'Dedektif', d: "Kim Yazdı?'da en çok doğru tahmini yaptın" },
  ky_mystery: { e: '😎', n: 'Gizemli', d: "Kim Yazdı?'da en çok kişiyi kandırdın" },
  as_adventurer: { e: '🤠', n: 'Maceracı', d: "Asla Yapmadım'da en çok şeyi yapmış çıktın" },
  as_angel: { e: '😇', n: 'Melek', d: "Asla Yapmadım'da en masum sendin" },
  km_comedian: { e: '😂', n: 'Komedyen', d: "Komik Cevap'ı kazandın" },
  km_star: { e: '🎤', n: 'Sahnenin Yıldızı', d: 'Turun en komik cevabı seninkiydi' },
  ly_master: { e: '🤥', n: 'Usta Yalancı', d: 'Yalancıyken yakalanmadın' },
  ly_fox: { e: '🦊', n: 'Kurnaz Tilki', d: 'Yalancıyken yakalandın ama kelimeyi bildin' },
  ly_hunter: { e: '🔍', n: 'Yalan Avcısı', d: 'Yalancıyı doğru buldun' },
  kc_sniper: { e: '🎯', n: 'Keskin Nişancı', d: "Kaç Kaç?'ı kazandın" },
  kc_bullseye: { e: '💯', n: 'Tam İsabet', d: "Kaç Kaç?'ta bir sayıyı tam bildin" },
  ik_finder: { e: '💘', n: 'İkiz Bulucu', d: 'Ruh ikizini doğru tahmin ettin' },
  ik_twins: { e: '👯', n: 'Ruh İkizleri', d: 'Turun en uyumlu ikilisi sizdiniz' },
  tl_telepath: { e: '🧠', n: 'Telepat', d: "Telepati'yi kazandın" },
  tl_mindreader: { e: '🔮', n: 'Zihin Okuyucu', d: "Telepati'de eşinle aynı cevabı verdin" },
  ay_knower: { e: '🪞', n: 'Seni Tanıyorum', d: "Ayna'da en çok doğru tahmini yaptın" },
  em_artist: { e: '🎨', n: 'Emoji Sanatçısı', d: "Emojiyle Anlat'ta en çok kişiye anlattın" },
  em_flash: { e: '⚡', n: 'Şimşek', d: "Emojiyle Anlat'ta en çok ilk bilen sendin" },
  cg_pollster: { e: '📊', n: 'Anketçi', d: "Çoğunluğu Bil'i kazandın" },
  iy_poker: { e: '🃏', n: 'Poker Yüzü', d: "İki Doğru Bir Yalan'da en çok kişiyi kandırdın" },
  iy_detector: { e: '👃', n: 'Yalan Dedektörü', d: "İki Doğru Bir Yalan'da en çok yalanı buldun" },
  sr_ruler: { e: '📏', n: 'Cetvel', d: "Sıralama'yı kazandın" },
  ad_hunter: { e: '🧩', n: 'Kelime Avcısı', d: "Adam Asmaca'da en çok kelimeyi sen buldun" },
  ad_hangman: { e: '🪢', n: 'Cellat', d: "Adam Asmaca'da kelimenle en çok adam astın" },
  zr_king: { e: '🎲', n: 'Zar Kralı', d: "Yalan Zar'da son kalan sen oldun" },
  zr_hunter: { e: '🔍', n: 'Yalan Avcısı', d: "Yalan Zar'da en çok yalanı sen yakaladın" },
  kf_mogul: { e: '💰', n: 'Kahve Kralı', d: "Kafe Savaşları'nı en zengin bitirdin" },
  kf_fav: { e: '⭐', n: 'Semtin Gözdesi', d: "Kafe Savaşları'nda en çok müşteri senin kafene geldi" },
  cn_sherlock: { e: '🕵️', n: 'Sherlock', d: "Cinayet Gecesi'nde katili ve silahı bildin" },
  cn_perfect: { e: '🔪', n: 'Kusursuz Cinayet', d: "Cinayet Gecesi'nde katil olarak kaçmayı başardın" },
  qz_brain: { e: '🧠', n: 'Ansiklopedi', d: "Bilgi Yarışması'nı kazandın" },
  qz_compass: { e: '🧭', n: 'Pusula', d: "Bilgi Yarışması'nda haritada en isabetli sendin" },
  tk_master: { e: '🥸', n: 'Usta Taklitçi', d: "Taklitçi'de taklidinle en çok kişiyi kandırdın" },
  tk_knower: { e: '🔍', n: 'Herkesi Tanıyan', d: "Taklitçi'de en çok gerçeği sen buldun" },
  pt_cool: { e: '🧊', n: 'Soğukkanlı', d: "Sıcak Patates'te son kalan sen oldun" },
  vm_night: { e: '🧛', n: 'Gecenin Efendisi', d: "Vampir Köyü'nü vampirlerle kazandın" },
  vm_hero: { e: '🏡', n: 'Köyün Kahramanı', d: "Vampir Köyü'nde köyü kurtardın" },
  vm_jester: { e: '🃏', n: 'Son Gülen', d: "Vampir Köyü'nde Soytarı olarak sürgün edilip kazandın" },
  vm_survivor: { e: '🎒', n: 'Hayatta Kalan', d: "Vampir Köyü'nde Gezgin olarak sona kadar dayandın" },
  ay_openbook: { e: '📖', n: 'Açık Kitap', d: "Ayna'da seni en çok kişi bildi" },
};

const CHAT_MAX = 200;           // characters per message
const CHAT_KEEP = 40;           // messages the room remembers
const CHAT_REACTIONS = ['😂', '🤣', '😮', '😱', '👏', '🔥', '😍', '🥰', '💀', '🤔', '👍', '👎', '😭', '😡', '🤯', '🥳', '😎', '🙄', '🤡', '👀', '💯', '❤️', '🎉', '🫡'];

// The first 16 are handed out automatically; the rest are extra choices in the picker.
const AVATARS = ['🦊', '🐸', '🐼', '🐙', '🦄', '🐯', '🐵', '🐧', '🐨', '🦁', '🐷', '🐰', '🐻', '🐶', '🐱', '🦉',
  '🐲', '🦋', '🐝', '🐢', '🦖', '🐳', '🦩', '🦔', '🐺', '🦝', '🐮', '🐔', '👻', '👽', '🤖', '🤡', '🎃', '🌵', '🍕', '😎'];
const COLORS = ['#ffb36b', '#8be28b', '#9fd3ff', '#ff9fc4', '#d7b8ff', '#ffd36b', '#c9a27e', '#7fe0d4', '#ff8a8a', '#b8c4cf', '#a0b4ff', '#e3f27a', '#f5a3ff', '#6fcf97', '#ffc4a3', '#5b5b7a'];

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
  if (p.pic && validPic(p.pic)) {
    return '<span class="av pic ' + size + '" style="--c:' + esc(p.col) + '"><img src="' + esc(p.pic) + '" alt="" referrerpolicy="no-referrer" loading="lazy"></span>';
  }
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

// Personal settings, kept on this device only. Everything is on unless switched off.
const Prefs = {
  get(k) { return (store.get('hz-prefs') || {})[k] !== false; },
  set(k, v) { const p = store.get('hz-prefs') || {}; p[k] = v; store.set('hz-prefs', p); },
};

function buzz(pattern) {
  if (Prefs.get('vibrate') && navigator.vibrate) try { navigator.vibrate(pattern); } catch { /* not supported */ }
}

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

// Google sign-in. The Client ID is public (not a secret); empty = the button is hidden.
const GOOGLE_CLIENT_ID = '965124560848-hb29u0mta3dm5on7u09ji0k2cr243aii.apps.googleusercontent.com';

// Only Google profile photos are accepted as pictures, so nobody can slip other links into the room.
function validPic(u) {
  return typeof u === 'string' && u.length < 400 && /^https:\/\/lh\d\.googleusercontent\.com\/[A-Za-z0-9_\-/=.]+$/.test(u);
}

function validLook(l) {
  return !!l && AVATARS.includes(l.av) && COLORS.includes(l.col);
}

// The player's chosen animal + colour, remembered on this device.
App.look = validLook(store.get('hz-look')) ? store.get('hz-look')
  : { av: AVATARS[Math.floor(Math.random() * AVATARS.length)], col: COLORS[Math.floor(Math.random() * COLORS.length)] };
store.set('hz-look', App.look);

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
    this.addPlayer(myId, name, App.look).badges = sanitizeBadges(store.get('hz-badges'));
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
      p = this.addPlayer(id, name, msg.look);
      p.badges = sanitizeBadges(msg.badges);
    } else if (S.phase === 'lobby') {
      p.name = name;
      if (validLook(msg.look)) { p.av = msg.look.av; p.col = msg.look.col; p.pic = validPic(msg.look.pic) ? msg.look.pic : null; }
      p.badges = sanitizeBadges(msg.badges);
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

  addPlayer(id, name, look) {
    const S = this.S;
    let av;
    let col;
    if (validLook(look)) {
      ({ av, col } = look);
    } else {
      // No choice made: hand out the first animal nobody is using yet.
      const used = new Set(S.order.map((x) => S.players[x].av));
      const idx = Math.max(0, AVATARS.slice(0, COLORS.length).findIndex((a) => !used.has(a)));
      av = AVATARS[idx];
      col = COLORS[idx % COLORS.length];
    }
    const p = {
      id, name, av, col, pic: look && validPic(look.pic) ? look.pic : null,
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

      case 'chat': {
        const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX);
        if (!text) return;
        // Gartic-style: a message that gives the answer away never leaves the host.
        const limit = this.chatLimit(p);
        if (limit) { this.tell(pid, { t: 'chatBlocked', reason: limit, text }); return; }
        const block = chatBlockReason(S, pid, text);
        // A warning would itself reveal the secret ("you can't write that word"), so leaks are
        // only echoed back to the sender as if sent; nobody else ever sees them.
        if (block === SHADOW) { this.tell(pid, { t: 'chatShadow', text }); return; }
        if (block) { this.tell(pid, { t: 'chatBlocked', reason: block, text }); return; }
        this.pushChat(p, { text });
        return;
      }

      case 'react':
        if (!CHAT_REACTIONS.includes(msg.e) || this.chatLimit(p)) return;
        this.pushChat(p, { react: msg.e });
        return;

      case 'gvote':
        if (S.phase !== 'lobby' || !S.gameVote || !GAMES[msg.id]) return;
        S.gameVote.votes[pid] = msg.id;
        if (this.connectedIds().every((id) => S.gameVote.votes[id])) this.finishGameVote(); else this.changed();
        return;

      case 'badges':
        p.badges = sanitizeBadges(msg.badges);
        this.changed();
        return;

      case 'look':
        if (S.phase !== 'lobby' || !validLook(msg.look)) return;
        p.av = msg.look.av;
        p.col = msg.look.col;
        p.pic = validPic(msg.look.pic) ? msg.look.pic : null;
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

      case 'iword': {
        if (S.phase !== 'ikiz' || r.step !== 'answer' || !r.roster.includes(pid)) return;
        const text = cleanWord(msg.text);
        if (!text) return;
        r.answers[pid] = text;
        this.changed();
        this.ikizCheck();
        return;
      }

      case 'iguess':
        if (S.phase !== 'ikiz' || r.step !== 'guess' || !r.roster.includes(pid)) return;
        if (!r.roster.includes(msg.target) || msg.target === pid) return;
        r.twinGuess[pid] = msg.target;
        this.changed();
        this.ikizCheck();
        return;

      case 'tword': {
        if (S.phase !== 'tele' || r.step !== 'play' || !r.pairs[r.ri].includes(pid) || r.words[pid] != null) return;
        const text = cleanWord(msg.text);
        if (!text) return;
        r.words[pid] = text;
        this.changed();
        this.teleCheck();
        return;
      }

      case 'tbet':
        if (S.phase !== 'tele' || r.step !== 'play' || !r.roster.includes(pid) || r.pairs[r.ri].includes(pid) || r.bets[pid]) return;
        if (msg.v !== 'yes' && msg.v !== 'no') return;
        r.bets[pid] = msg.v;
        this.changed();
        this.teleCheck();
        return;

      case 'asend': {
        if (S.phase !== 'ayna' || r.step !== 'answer' || !r.roster.includes(pid)) return;
        const text = cleanWord(msg.text);
        if (!text) return;
        if (pid === r.turns[r.ti]) r.own = text; else r.guesses[pid] = text;
        this.changed();
        this.aynaCheck();
        return;
      }

      case 'ajudge':
        if (S.phase !== 'ayna' || r.step !== 'judge' || pid !== r.turns[r.ti] || !Array.isArray(msg.accepted)) return;
        this.aynaReveal(msg.accepted.map(String));
        return;

      case 'ereroll':
        if (S.phase !== 'emo' || r.step !== 'write' || pid !== r.turns[r.ti] || r.rerolls >= EMO_REROLLS) return;
        r.rerolls++;
        r.item = r.pool[r.pi++ % r.pool.length];
        this.changed();
        return;

      case 'eclue': {
        if (S.phase !== 'emo' || r.step !== 'write' || pid !== r.turns[r.ti]) return;
        const text = String(msg.text ?? '').trim();
        if (emojiCount(text) > EMO_MAX_CLUE) { this.tell(pid, { t: 'toast', text: 'En fazla ' + EMO_MAX_CLUE + ' emoji kullanabilirsin 🙂' }); return; }
        if (!isEmojiOnly(text)) { this.tell(pid, { t: 'toast', text: 'Sadece emoji kullanabilirsin 🙂 Harf ve rakam yok!' }); return; }
        r.clue = text;
        r.step = 'guess';
        r.hintIdx = [];
        r.hintAt = Date.now() + EMO_HINT_FIRST * 1000;
        this.setStepDeadline(r.cfg.guessTime);
        this.changed();
        return;
      }

      case 'eguess': {
        if (S.phase !== 'emo' || r.step !== 'guess' || !r.roster.includes(pid) || pid === r.turns[r.ti] || r.correct.includes(pid)) return;
        const text = cleanWord(msg.text);
        if (!text) return;
        const m = emoMatch(text, r.item);
        if (m === 'close') { this.tell(pid, { t: 'toast', text: '🔥 Çok yaklaştın! (' + text + ')' }); return; }
        if (m === 'hit') {
          r.correct.push(pid);
          r.feed.push({ id: pid, ok: true });
          this.tell(pid, { t: 'toast', text: '✅ Bildin! +' + (r.correct.length <= EMO_POINTS.length ? EMO_POINTS[r.correct.length - 1] : EMO_POINTS_REST) });
        } else {
          r.feed.push({ id: pid, text });
        }
        r.feed = r.feed.slice(-30);
        this.changed();
        this.emoCheck();
        return;
      }

      case 'cans': {
        if (S.phase !== 'cog' || r.step !== 'answer' || !r.roster.includes(pid)) return;
        const pred = Math.round(Number(msg.pred));
        if (typeof msg.yes !== 'boolean' || !Number.isFinite(pred) || pred < 0 || pred > r.roster.length) return;
        r.ans[pid] = { yes: msg.yes, pred };
        this.changed();
        this.cogCheck();
        return;
      }

      case 'iwrite': {
        if (S.phase !== 'iky' || r.step !== 'write' || pid !== r.turns[r.ti] || !Array.isArray(msg.list)) return;
        const list = msg.list.slice(0, 3).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN));
        const lie = Math.round(Number(msg.lie));
        if (list.length !== 3 || list.some((x) => !x) || ![0, 1, 2].includes(lie)) return;
        r.stmts[pid] = { list, lie };
        this.ikyStartGuess();
        return;
      }

      case 'ipick': {
        if (S.phase !== 'iky' || r.step !== 'guess' || !r.roster.includes(pid) || pid === r.turns[r.ti]) return;
        const idx = Math.round(Number(msg.idx));
        if (![0, 1, 2].includes(idx)) return;
        r.picks[pid] = idx;
        this.changed();
        this.ikyCheck();
        return;
      }

      case 'sask': {
        if (S.phase !== 'sir' || r.step !== 'ask' || pid !== r.turns[r.ti]) return;
        const q = String(msg.q ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN);
        if (!q) return;
        r.q = q;
        r.step = 'rank';
        r.rankIds = shuffle(r.roster);
        r.ranks = {};
        this.setStepDeadline(r.cfg.rankTime);
        this.changed();
        return;
      }

      case 'kplan': {
        if (S.phase !== 'kafe' || r.step !== 'plan' || !r.roster.includes(pid)) return;
        const price = Math.round(Number(msg.price) / 5) * 5;
        const inv = String(msg.inv || 'none');
        if (!(price >= 15 && price <= 150) || !KAFE_INV[inv]) return;
        let sab = null;
        if (msg.sab && KAFE_SAB[msg.sab.type] && r.roster.includes(msg.sab.target) && msg.sab.target !== pid && r.cafes[pid].sabLeft > 0) sab = { type: msg.sab.type, target: msg.sab.target };
        if (KAFE_INV[inv].cost > r.cafes[pid].money) { this.tell(pid, { t: 'toast', text: 'Bu yatırım için paran yetmiyor 😬' }); return; }
        r.plans[pid] = { price, inv, sab };
        this.changed();
        this.kafeCheck();
        return;
      }

      case 'calibi': {
        if (S.phase !== 'cin' || r.step === 'accuse' || !r.roster.includes(pid)) return;
        const room = Math.round(Number(msg.room));
        if (!(room >= 0 && room < CIN_ROOMS.length)) return;
        // The statement can only be made once; after that it is on the record.
        if (r.declared[pid] != null) return;
        r.declared[pid] = room;
        this.changed();
        this.cinCheck();
        return;
      }

      case 'cready': {
        if (S.phase !== 'cin' || r.step !== 'round' || !r.roster.includes(pid)) return;
        r.ready[pid] = !r.ready[pid];
        this.changed();
        this.cinCheck();
        return;
      }

      case 'cframe': {
        if (S.phase !== 'cin' || r.step !== 'round' || pid !== r.killer || r.frameUsed) return;
        const target = String(msg.target || '');
        if (target === pid || !r.roster.includes(target)) return;
        r.frameUsed = true;
        const letter = (S.players[target] ? S.players[target].name : '?').trim().charAt(0).toLocaleUpperCase('tr');
        r.events.push({ round: r.round, text: '🧣 ' + CIN_ROOMS[r.room].n + ' yakınında bir mendil bulundu. Üzerinde "' + letter + '" harfi işlenmiş!' });
        this.changed();
        return;
      }

      case 'cvote': {
        if (S.phase !== 'cin' || r.step !== 'accuse' || !r.roster.includes(pid)) return;
        const sus = String(msg.s || '');
        const w = Math.round(Number(msg.w));
        if (sus === pid || !r.roster.includes(sus) || !(w >= 0 && w < CIN_WEAPONS.length)) return;
        r.votes[pid] = { s: sus, w };
        this.changed();
        this.cinCheck();
        return;
      }

      case 'qans': {
        if (S.phase !== 'quiz' || r.step !== 'q' || !r.roster.includes(pid) || r.ans[pid]) return;
        const q = r.qs[r.qi];
        const t = Date.now() - r.qStart;
        if (q.type === 'map') {
          const lat = Number(msg.lat);
          const lng = Number(msg.lng);
          if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90) return;
          r.ans[pid] = { lat, lng: ((((lng + 180) % 360) + 360) % 360) - 180, t };
        } else {
          const i = Math.round(Number(msg.i));
          if (!(i >= 0 && i < q.opts.length)) return;
          r.ans[pid] = { i, t };
        }
        this.changed();
        this.quizCheck();
        return;
      }

      case 'tans': {
        if (S.phase !== 'tak' || r.step !== 'write' || !r.roster.includes(pid)) return;
        const clean = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, TAK_MAX);
        const real = clean(msg.real);
        const fake = clean(msg.fake);
        if (!real || !fake) return;
        r.answers[pid] = { real, fake };
        this.changed();
        this.takCheck();
        return;
      }

      case 'tvote': {
        if (S.phase !== 'tak' || r.step !== 'vote' || !r.roster.includes(pid)) return;
        const subject = String(msg.subject || '');
        const idx = Number(msg.idx);
        if (subject === pid || ![0, 1].includes(idx) || !r.cards.some((c) => c.subject === subject)) return;
        r.votes[pid] = r.votes[pid] || {};
        r.votes[pid][subject] = idx;
        this.changed();
        this.takCheck();
        return;
      }

      case 'tguess': {
        if (S.phase !== 'tak' || r.step !== 'guess' || !r.roster.includes(pid)) return;
        const target = String(msg.target || '');
        if (target === pid || !r.roster.includes(target)) return;
        r.guesses[pid] = target;
        this.changed();
        this.takCheck();
        return;
      }

      case 'zbid': {
        if (S.phase !== 'zar' || r.step !== 'bid' || pid !== this.zarTurn()) return;
        const q = Math.round(Number(msg.q));
        const f = Math.round(Number(msg.f));
        if (!this.zarBidOk(q, f)) return;
        this.zarBid(pid, q, f);
        return;
      }

      case 'zcall': {
        if (S.phase !== 'zar' || r.step !== 'bid' || pid !== this.zarTurn() || !r.bid) return;
        this.zarReveal(pid);
        return;
      }

      case 'pans': {
        if (S.phase !== 'pat' || r.step !== 'play' || pid !== r.holder) return;
        const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);
        const why = this.patCheckAnswer(text);
        if (why) { this.tell(pid, { t: 'toast', text: why }); return; }
        this.patAnswer(pid, text);
        return;
      }

      case 'pdown': {
        if (S.phase !== 'pat' || r.step !== 'play' || !r.last || !r.alive[pid] || pid === r.last.id) return;
        r.last.downs[pid] = true;
        this.patVeto();
        this.changed();
        return;
      }

      case 'vready': {
        if (S.phase !== 'vamp' || r.step !== 'roles' || !r.roster.includes(pid)) return;
        r.ready[pid] = true;
        this.changed();
        this.vampCheck();
        return;
      }

      case 'vact': {
        if (S.phase !== 'vamp' || r.step !== 'night' || !r.alive[pid]) return;
        const kind = String(msg.kind || '');
        if (kind === 'pass') {
          r.acts[pid] = { kind: 'pass', target: null };
        } else {
          const ctx = this.vampCtx(pid);
          if (!vampKindsFor(ctx).includes(kind)) return;
          const target = VAMP_KINDS[kind].t === 'use' ? null : String(msg.target || '');
          if (target !== null && !vampTargets(kind, ctx).includes(target)) return;
          r.acts[pid] = { kind, target };
        }
        this.changed();
        this.vampCheck();
        return;
      }

      case 'vvote': {
        if (S.phase !== 'vamp' || r.step !== 'day' || !r.alive[pid]) return;
        const target = String(msg.target || '');
        if (target !== 'none' && (!r.alive[target] || target === pid)) return;
        r.votes[pid] = target;
        this.changed();
        this.vampCheck();
        return;
      }

      case 'vchat': {
        if (S.phase !== 'vamp' || !r.alive[pid] || VAMP_ROLES[r.roles[pid]].team !== 'vamp') return;
        const text = String(msg.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        if (!text) return;
        r.vchat.push({ id: pid, text });
        r.vchat = r.vchat.slice(-30);
        this.changed();
        return;
      }

      case 'hword': {
        if (S.phase !== 'adam' || r.step !== 'write' || pid !== r.setter) return;
        const word = adamClean(msg.word);
        if (adamLetterCount(word) < 2) return;
        r.word = word;
        r.hint = String(msg.hint ?? '').replace(/\s+/g, ' ').trim().slice(0, 30);
        this.adamStartPlay();
        return;
      }

      case 'hletter': {
        if (S.phase !== 'adam' || r.step !== 'play' || pid !== this.adamTurn()) return;
        const l = String(msg.l ?? '').toLocaleUpperCase('tr');
        if (l.length !== 1 || !ADAM_ALPHABET.includes(l) || r.used[l] !== undefined) return;
        this.adamLetter(pid, l);
        return;
      }

      case 'hsolve': {
        if (S.phase !== 'adam' || r.step !== 'play' || pid !== this.adamTurn()) return;
        const text = adamClean(msg.text);
        if (!text) return;
        this.adamSolve(pid, text);
        return;
      }

      case 'srank': {
        if (S.phase !== 'sir' || r.step !== 'rank' || !r.roster.includes(pid) || !Array.isArray(msg.order)) return;
        const order = msg.order.map(String);
        const need = r.rankIds;
        if (order.length !== need.length || new Set(order).size !== order.length || !order.every((x) => need.includes(x))) return;
        r.ranks[pid] = order;
        this.changed();
        this.sirCheck();
        return;
      }

      case 'kask': {
        if (S.phase !== 'kac' || r.step !== 'ask' || pid !== r.turns[r.ti]) return;
        const q = String(msg.q ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN);
        const v = parseKacNumber(msg.v);
        if (!q || v == null) return;
        r.ask = { q, v };
        this.kacStartGuess();
        return;
      }

      case 'kguess': {
        if (S.phase !== 'kac' || r.step !== 'guess' || !r.roster.includes(pid) || pid === r.turns[r.ti] || r.guesses[pid] !== undefined) return;
        const v = parseKacNumber(msg.v);
        if (v == null) return;
        r.guesses[pid] = v;
        if (this.kacAllGuessed()) this.kacReveal(); else this.changed();
        return;
      }

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
      case 'spinGame': {
        if (S.phase !== 'lobby') return;
        const online = this.connectedIds().length;
        let pool = GAME_ORDER.filter((g) => GAMES[g].minPlayers <= online);
        if (!pool.length) pool = GAME_ORDER.slice();
        this.pickGame(pool[Math.floor(Math.random() * pool.length)], 'spin', pool);
        return;
      }
      case 'voteGame':
        if (S.phase !== 'lobby') return;
        S.gameVote = { votes: {} };
        this.changed();
        return;
      case 'voteEnd':
        if (S.gameVote) this.finishGameVote();
        return;
      case 'voteCancel':
        S.gameVote = null;
        this.changed();
        return;
      case 'start':
        if (S.phase === 'lobby') this.startRound();
        return;
      case 'skip':
        if (S.phase === 'writing') this.endWriting();
        else if (S.phase === 'answering') this.endAnswering();
        else if (S.phase === 'lie') this.lieTimeout('skip');
        else if (S.phase === 'kac') this.kacSkip();
        else if (S.phase === 'ikiz') this.ikizSkip();
        else if (S.phase === 'tele') this.teleSkip();
        else if (S.phase === 'ayna') this.aynaSkip();
        else if (S.phase === 'emo') this.emoSkip();
        else if (S.phase === 'cog') this.cogSkip();
        else if (S.phase === 'iky') this.ikySkip();
        else if (S.phase === 'sir') this.sirSkip();
        else if (S.phase === 'adam') this.adamSkip();
        else if (S.phase === 'vamp') this.vampSkip();
        else if (S.phase === 'zar') this.zarSkip();
        else if (S.phase === 'pat') this.patSkip();
        else if (S.phase === 'tak') this.takSkip();
        else if (S.phase === 'quiz') this.quizSkip();
        else if (S.phase === 'cin') this.cinSkip();
        else if (S.phase === 'kafe') this.kafeSkip();
        return;
      case 'lieReset':
        S.lieTotals = {};
        if (r && r.final && r.final.totals) for (const id of Object.keys(r.final.totals)) r.final.totals[id] = 0;
        this.changed();
        return;
      case 'next':
        if (S.phase === 'results') this.nextReveal();
        else if (S.phase === 'kac' && r.step === 'reveal') this.kacNext();
        else if (S.phase === 'ikiz' && r.step === 'reveal') this.ikizNext();
        else if (S.phase === 'tele' && r.step === 'reveal') this.teleNext();
        else if (S.phase === 'ayna' && r.step === 'reveal') this.aynaNext();
        else if (S.phase === 'emo' && r.step === 'reveal') this.emoNext();
        else if (S.phase === 'cog' && r.step === 'reveal') this.cogNext();
        else if (S.phase === 'iky' && r.step === 'reveal') this.ikyNext();
        else if (S.phase === 'sir' && r.step === 'reveal') this.sirNext();
        else if (S.phase === 'adam' && r.step === 'reveal') this.adamNext();
        else if (S.phase === 'vamp' && r.step === 'reveal') this.vampNext();
        else if (S.phase === 'zar' && r.step === 'reveal') this.zarNext();
        else if (S.phase === 'pat' && r.step === 'reveal') this.patNext();
        else if (S.phase === 'tak' && r.step === 'reveal') this.takNext();
        else if (S.phase === 'tak' && r.step === 'unmask') this.takFinish();
        else if (S.phase === 'quiz' && r.step === 'reveal') this.quizNext();
        else if (S.phase === 'kafe' && r.step === 'result') this.kafeNext();
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

  // Choose the next game and let every screen play the reveal animation.
  pickGame(id, kind, pool, counts) {
    const S = this.S;
    S.game = id;
    S.notice = null;
    S.gameVote = null;
    store.set('hz-game', id);
    S.spin = { seq: ((S.spin && S.spin.seq) || 0) + 1, kind, result: id, pool, counts: counts || null };
    this.changed();
  },

  finishGameVote() {
    const S = this.S;
    const counts = {};
    for (const g of Object.values(S.gameVote.votes)) counts[g] = (counts[g] || 0) + 1;
    const max = Math.max(0, ...Object.values(counts));
    if (!max) { S.gameVote = null; this.changed(); return; }
    const tied = Object.keys(counts).filter((g) => counts[g] === max);
    this.pickGame(tied[Math.floor(Math.random() * tied.length)], 'vote', tied, counts);
  },

  chatLimit(p) {
    const now = Date.now();
    p.chatTimes = (p.chatTimes || []).filter((t) => now - t < 5000);
    if (p.chatTimes.length >= 5) return 'Çok hızlı yazıyorsun, biraz yavaş 🙂';
    p.chatTimes.push(now);
    return null;
  },

  pushChat(p, body) {
    const S = this.S;
    S.chatSeq = (S.chatSeq || 0) + 1;
    S.chat = (S.chat || []).concat({ id: S.chatSeq, from: p.id, name: p.name, av: p.av, col: p.col, pic: p.pic || null, ...body }).slice(-CHAT_KEEP);
    this.changed();
  },

  // A message for one player only.
  tell(pid, msg) {
    if (pid === this.S.hostId) { onPrivate(msg); return; }
    const c = this.conns.get(pid);
    if (c && c.open) { try { c.send(msg); } catch { /* gone */ } }
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
      names[id] = { name: p.name, av: p.av, col: p.col, pic: p.pic || null };
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
    if (S.game === 'kackac') this.setupKac(S.round, now);
    for (const id of S.order) S.players[id].ready = false;
    if (S.game === 'ikiz') this.setupIkiz(S.round);
    if (S.game === 'tele') this.setupTele(S.round);
    if (S.game === 'ayna') this.setupAyna(S.round);
    if (S.game === 'emoji') this.setupEmo(S.round);
    if (S.game === 'cogunluk') this.setupCog(S.round);
    if (S.game === 'ikidogru') this.setupIky(S.round);
    if (S.game === 'sirala') this.setupSir(S.round);
    if (S.game === 'adam') this.setupAdam(S.round);
    if (S.game === 'vampir') this.setupVamp(S.round);
    if (S.game === 'zar') this.setupZar(S.round);
    if (S.game === 'patates') this.setupPat(S.round);
    if (S.game === 'taklit') this.setupTak(S.round);
    if (S.game === 'quiz') this.setupQuiz(S.round);
    if (S.game === 'cinayet') this.setupCin(S.round);
    if (S.game === 'kafe') this.setupKafe(S.round);
    S.phase = GAME_PHASE[S.game] || 'writing';
    this.changed();
  },

  /* ---------- shared by Ruh İkizi / Telepati / Ayna ---------- */

  liveIds() {
    const S = this.S;
    return S.round.roster.filter((id) => S.players[id] && S.players[id].connected);
  },

  setStepDeadline(sec) {
    const r = this.S.round;
    r.deadline = sec ? Date.now() + sec * 1000 : null;
    r.deadlineTotal = sec ? sec * 1000 : 0;
  },

  revealDeadline() {
    const r = this.S.round;
    r.deadline = r.cfg.revealMode === 'auto' ? Date.now() + STEP_REVEAL_MS : null;
    r.deadlineTotal = STEP_REVEAL_MS;
  },

  finishCustom(final) {
    const S = this.S;
    S.round.final = final;
    S.round.deadline = null;
    S.phase = 'final';
    this.changed();
  },

  /* ---------- Ruh İkizi ---------- */

  setupIkiz(r) {
    const ids = shuffle(r.roster);
    const groups = [];
    for (let i = 0; i + 1 < ids.length; i += 2) groups.push([ids[i], ids[i + 1]]);
    if (ids.length % 2) groups[groups.length - 1].push(ids[ids.length - 1]);   // odd count: one trio
    const partners = {};
    for (const g of groups) for (const id of g) partners[id] = g.filter((x) => x !== id);
    const scores = {};
    for (const id of r.roster) scores[id] = 0;
    Object.assign(r, { groups, partners, prompts: shuffle(WORD_PROMPTS).slice(0, r.cfg.rounds), ri: 0, step: 'answer', answers: {}, history: [], twinGuess: {}, scores });
    this.setStepDeadline(r.cfg.answerTime);
  },

  ikizReveal() {
    const r = this.S.round;
    const matched = {};
    for (const id of r.roster) {
      const k = r.answers[id] != null ? normWord(r.answers[id]) : null;
      matched[id] = !!k && r.partners[id].some((pt) => r.answers[pt] != null && normWord(r.answers[pt]) === k);
      if (matched[id]) r.scores[id] += IKIZ_MATCH_POINTS;
    }
    r.history.push({ prompt: r.prompts[r.ri], answers: { ...r.answers }, matched });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  ikizNext() {
    const r = this.S.round;
    r.ri++;
    r.answers = {};
    if (r.ri < r.prompts.length) {
      r.step = 'answer';
      this.setStepDeadline(r.cfg.answerTime);
    } else {
      r.step = 'guess';
      this.setStepDeadline(r.cfg.guessTime);
    }
    this.changed();
  },

  ikizFinish() {
    const r = this.S.round;
    const right = {};
    const matches = {};
    for (const id of r.roster) {
      right[id] = !!r.twinGuess[id] && r.partners[id].includes(r.twinGuess[id]);
      if (right[id]) r.scores[id] += IKIZ_GUESS_POINTS;
      matches[id] = r.history.filter((h) => h.matched[id]).length;
    }
    this.finishCustom({
      groups: r.groups, guess: r.twinGuess, right, matches, scores: { ...r.scores }, rounds: r.history.length,
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
      history: r.history.map((h) => ({ prompt: h.prompt, answers: h.answers })),
    });
  },

  ikizSkip() {
    const r = this.S.round;
    if (r.step === 'answer') this.ikizReveal();
    else if (r.step === 'reveal') this.ikizNext();
    else this.ikizFinish();
  },

  ikizCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (!live.length) return;
    if (r.step === 'answer' && live.every((id) => r.answers[id] != null)) this.ikizReveal();
    else if (r.step === 'guess' && live.every((id) => r.twinGuess[id])) this.ikizFinish();
  },

  /* ---------- Telepati ---------- */

  setupTele(r) {
    const plays = {};
    const scores = {};
    for (const id of r.roster) { plays[id] = 0; scores[id] = 0; }
    const all = [];
    for (let i = 0; i < r.roster.length; i++) for (let j = i + 1; j < r.roster.length; j++) all.push([r.roster[i], r.roster[j]]);
    const pairs = [];
    for (let k = 0; k < r.cfg.rounds; k++) {
      // Prefer people who played least and avoid repeating last round's players.
      const prev = pairs[pairs.length - 1] || [];
      const pool = shuffle(all).sort((x, y) => (plays[x[0]] + plays[x[1]]) - (plays[y[0]] + plays[y[1]]));
      const pick = pool.find((pr) => !pr.some((id) => prev.includes(id))) || pool[0];
      pairs.push(shuffle(pick));
      plays[pick[0]]++;
      plays[pick[1]]++;
    }
    Object.assign(r, { pairs, prompts: shuffle(WORD_PROMPTS).slice(0, r.cfg.rounds), ri: 0, step: 'play', words: {}, bets: {}, history: [], scores });
    this.setStepDeadline(r.cfg.answerTime);
  },

  teleReveal() {
    const r = this.S.round;
    const [a, b] = r.pairs[r.ri];
    const match = r.words[a] != null && r.words[b] != null && normWord(r.words[a]) === normWord(r.words[b]);
    const delta = {};
    if (match) { delta[a] = TELE_MATCH_POINTS; delta[b] = TELE_MATCH_POINTS; }
    const right = [];
    for (const [id, bet] of Object.entries(r.bets)) {
      if ((bet === 'yes') === match) { delta[id] = (delta[id] || 0) + TELE_BET_POINTS; right.push(id); }
    }
    for (const id of Object.keys(delta)) r.scores[id] += delta[id];
    r.history.push({ pair: [a, b], prompt: r.prompts[r.ri], words: { [a]: r.words[a] ?? null, [b]: r.words[b] ?? null }, match, bets: { ...r.bets }, right, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  teleNext() {
    const r = this.S.round;
    r.ri++;
    if (r.ri >= r.pairs.length) {
      const hits = {};
      for (const id of r.roster) hits[id] = r.history.filter((h) => h.match && h.pair.includes(id)).length;
      this.finishCustom({
        scores: { ...r.scores }, hits, ranking: r.roster.slice().sort((x, y) => r.scores[y] - r.scores[x]),
        history: r.history.map((h) => ({ pair: h.pair, prompt: h.prompt, words: h.words, match: h.match })),
      });
      return;
    }
    r.step = 'play';
    r.words = {};
    r.bets = {};
    this.setStepDeadline(r.cfg.answerTime);
    this.changed();
  },

  teleSkip() {
    if (this.S.round.step === 'play') this.teleReveal(); else this.teleNext();
  },

  teleCheck() {
    const r = this.S.round;
    if (r.step !== 'play') return;
    const pair = r.pairs[r.ri];
    const live = this.liveIds();
    // Both chosen players must answer; if one dropped, we wait (the leader can skip).
    const pairDone = pair.every((id) => r.words[id] != null);
    const betDone = live.filter((id) => !pair.includes(id)).every((id) => r.bets[id]);
    if (pairDone && betDone) this.teleReveal();
  },

  /* ---------- Ayna ---------- */

  setupAyna(r) {
    const scores = {};
    for (const id of r.roster) scores[id] = 0;
    const turns = [];
    for (let k = 0; k < r.cfg.perPlayer; k++) turns.push(...shuffle(r.roster));
    const qs = [];
    while (qs.length < turns.length) qs.push(...shuffle(AYNA_QUESTIONS));
    Object.assign(r, { turns, qs: qs.slice(0, turns.length), ti: 0, history: [], scores, step: 'answer', own: null, guesses: {}, accepted: [] });
    this.setStepDeadline(r.cfg.answerTime);
  },

  aynaBegin() {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.aynaFinish(); return; }
    Object.assign(r, { step: 'answer', own: null, guesses: {}, accepted: [] });
    this.setStepDeadline(r.cfg.answerTime);
    this.changed();
  },

  aynaToJudge() {
    const r = this.S.round;
    if (r.own == null || !Object.keys(r.guesses).length) { this.aynaReveal([]); return; }
    const k = normWord(r.own);
    r.accepted = Object.keys(r.guesses).filter((id) => normWord(r.guesses[id]) === k);   // exact matches start ticked
    r.step = 'judge';
    this.setStepDeadline(r.cfg.judgeTime);
    this.changed();
  },

  aynaReveal(accepted) {
    const r = this.S.round;
    const mirror = r.turns[r.ti];
    const ok = r.own == null ? [] : accepted.filter((id) => r.guesses[id] != null && id !== mirror);
    const delta = {};
    for (const id of ok) { delta[id] = AYNA_RIGHT_POINTS; r.scores[id] += AYNA_RIGHT_POINTS; }
    r.history.push({ mirror, q: r.qs[r.ti], own: r.own, guesses: { ...r.guesses }, accepted: ok, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  aynaNext() {
    this.S.round.ti++;
    this.aynaBegin();
  },

  aynaFinish() {
    const r = this.S.round;
    const right = {};
    const known = {};
    for (const id of r.roster) { right[id] = 0; known[id] = 0; }
    for (const h of r.history) {
      for (const id of h.accepted) right[id]++;
      known[h.mirror] += h.accepted.length;
    }
    this.finishCustom({
      scores: { ...r.scores }, right, known, ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a] || right[b] - right[a]),
      history: r.history.map((h) => ({ mirror: h.mirror, q: h.q, own: h.own, accepted: h.accepted, total: Object.keys(h.guesses).length })),
    });
  },

  aynaSkip() {
    const r = this.S.round;
    if (r.step === 'answer') this.aynaToJudge();
    else if (r.step === 'judge') this.aynaReveal(r.accepted);
    else this.aynaNext();
  },

  aynaCheck() {
    const r = this.S.round;
    if (r.step !== 'answer') return;
    const mirror = r.turns[r.ti];
    const live = this.liveIds();
    if (r.own != null && live.filter((id) => id !== mirror).every((id) => r.guesses[id] != null)) this.aynaToJudge();
  },

  zeroScores(r) {
    const scores = {};
    for (const id of r.roster) scores[id] = 0;
    return scores;
  },

  addPoints(r, delta) {
    for (const id of Object.keys(delta)) r.scores[id] = (r.scores[id] || 0) + delta[id];
  },

  /* ---------- Emojiyle Anlat ---------- */

  setupEmo(r) {
    const cats = r.cfg.category === 'mix' ? Object.keys(EMO_ITEMS) : [r.cfg.category];
    const pool = shuffle(cats.flatMap((c) => EMO_ITEMS[c].items.map((it) => ({ ...it, cat: EMO_ITEMS[c].name }))));
    const turns = [];
    for (let k = 0; k < r.cfg.perPlayer; k++) turns.push(...shuffle(r.roster));
    Object.assign(r, { turns, ti: 0, pool, pi: 0, history: [], scores: this.zeroScores(r) });
    this.emoBegin(true);
  },

  emoBegin(silent) {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.emoFinish(); return; }
    Object.assign(r, { step: 'write', item: r.pool[r.pi++ % r.pool.length], rerolls: 0, clue: null, correct: [], feed: [] });
    this.setStepDeadline(r.cfg.writeTime);
    if (!silent) this.changed();
  },

  emoAllGuessed() {
    const r = this.S.round;
    const narr = r.turns[r.ti];
    const live = this.liveIds().filter((id) => id !== narr);
    return live.length > 0 && live.every((id) => r.correct.includes(id));
  },

  emoReveal() {
    const r = this.S.round;
    const narr = r.turns[r.ti];
    const delta = {};
    r.correct.forEach((id, i) => { delta[id] = i < EMO_POINTS.length ? EMO_POINTS[i] : EMO_POINTS_REST; });
    if (r.correct.length) delta[narr] = (delta[narr] || 0) + r.correct.length * EMO_NARRATOR_POINTS;
    this.addPoints(r, delta);
    r.history.push({ narr, title: r.item.t, cat: r.item.cat, clue: r.clue, correct: r.correct.slice(), delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  emoNext() {
    this.S.round.ti++;
    this.emoBegin();
  },

  emoSkip() {
    const r = this.S.round;
    if (r.step === 'write') {
      // Narrator never sent anything: count it as a pass and move on.
      r.history.push({ narr: r.turns[r.ti], title: r.item.t, cat: r.item.cat, clue: null, correct: [], delta: {}, scores: { ...r.scores } });
      this.emoNext();
    } else if (r.step === 'guess') this.emoReveal();
    else this.emoNext();
  },

  emoCheck() {
    const r = this.S.round;
    if (r.step === 'guess' && this.emoAllGuessed()) { this.emoReveal(); return; }
    if (r.step === 'guess' && r.hintAt && Date.now() >= r.hintAt) this.emoHint();
  },

  // Nobody's getting it: open one more letter of the title for everyone.
  emoHint() {
    const r = this.S.round;
    const chars = [...r.item.t];
    const letters = chars.map((c, i) => (/[\p{L}\p{N}]/u.test(c) ? i : -1)).filter((i) => i >= 0);
    const hidden = letters.filter((i) => !r.hintIdx.includes(i));
    if (!hidden.length || r.hintIdx.length >= Math.max(1, Math.floor(letters.length * EMO_HINT_SHARE))) { r.hintAt = null; return; }
    r.hintIdx.push(hidden[Math.floor(Math.random() * hidden.length)]);
    r.hintAt = Date.now() + EMO_HINT_EVERY * 1000;
    this.changed();
  },

  emoFinish() {
    const r = this.S.round;
    const narrated = {};
    const firsts = {};
    const got = {};
    for (const id of r.roster) { narrated[id] = 0; firsts[id] = 0; got[id] = 0; }
    for (const h of r.history) {
      narrated[h.narr] += h.correct.length;
      if (h.correct[0]) firsts[h.correct[0]]++;
      for (const id of h.correct) got[id]++;
    }
    this.finishCustom({
      scores: { ...r.scores }, narrated, firsts, got,
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
      history: r.history.map((h) => ({ narr: h.narr, title: h.title, clue: h.clue, correct: h.correct })),
    });
  },

  /* ---------- Çoğunluğu Bil ---------- */

  setupCog(r) {
    Object.assign(r, { qs: shuffle(COG_QUESTIONS).slice(0, r.cfg.qCount), qi: 0, step: 'answer', ans: {}, history: [], scores: this.zeroScores(r) });
    this.setStepDeadline(r.cfg.answerTime);
  },

  cogReveal() {
    const r = this.S.round;
    const ids = r.roster.filter((id) => r.ans[id]);
    const yes = ids.filter((id) => r.ans[id].yes);
    const no = ids.filter((id) => !r.ans[id].yes);
    const preds = {};
    const delta = {};
    for (const id of ids) {
      const diff = Math.abs(r.ans[id].pred - yes.length);
      preds[id] = { pred: r.ans[id].pred, diff };
      if (diff === 0) delta[id] = COG_EXACT_POINTS; else if (diff === 1) delta[id] = COG_CLOSE_POINTS;
    }
    this.addPoints(r, delta);
    const named = r.cfg.showNames;
    r.history.push({ q: r.qs[r.qi], yesCount: yes.length, total: ids.length, yes: named ? yes : null, no: named ? no : null, preds, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  cogNext() {
    const r = this.S.round;
    r.qi++;
    if (r.qi >= r.qs.length) {
      const exact = {};
      for (const id of r.roster) exact[id] = r.history.filter((h) => h.preds[id] && h.preds[id].diff === 0).length;
      this.finishCustom({
        scores: { ...r.scores }, exact, ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a] || exact[b] - exact[a]),
        recap: r.history.map((h) => ({ q: h.q, yesCount: h.yesCount, total: h.total })),
      });
      return;
    }
    r.step = 'answer';
    r.ans = {};
    this.setStepDeadline(r.cfg.answerTime);
    this.changed();
  },

  cogSkip() {
    if (this.S.round.step === 'answer') this.cogReveal(); else this.cogNext();
  },

  cogCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (r.step === 'answer' && live.length && live.every((id) => r.ans[id])) this.cogReveal();
  },

  /* ---------- İki Doğru Bir Yalan ---------- */

  // One author at a time: they write their three lines, then everyone else hunts the lie right away.
  setupIky(r) {
    Object.assign(r, { turns: shuffle(r.roster), ti: 0, stmts: {}, order: {}, history: [], scores: this.zeroScores(r) });
    this.ikyBegin(true);
  },

  // The author's writing step. A dropped author keeps the turn; the leader can skip it.
  ikyBegin(silent) {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.ikyFinish(); return; }
    r.step = 'write';
    r.picks = {};
    this.setStepDeadline(r.cfg.writeTime);
    if (!silent) this.changed();
  },

  ikyStartGuess() {
    const r = this.S.round;
    // The three lines are shown in a random order so the lie's position gives nothing away.
    r.order[r.turns[r.ti]] = shuffle([0, 1, 2]);
    r.step = 'guess';
    r.picks = {};
    this.setStepDeadline(r.cfg.guessTime);
    this.changed();
  },

  ikyReveal() {
    const r = this.S.round;
    const author = r.turns[r.ti];
    const st = r.stmts[author];
    const list = r.order[author].map((i) => st.list[i]);
    const lie = r.order[author].indexOf(st.lie);
    const pickers = Object.keys(r.picks);
    const correct = pickers.filter((id) => r.picks[id] === lie);
    const fooled = pickers.length - correct.length;
    const delta = {};
    for (const id of correct) delta[id] = IKY_FOUND_POINTS;
    if (fooled) delta[author] = fooled * IKY_FOOL_POINTS;
    this.addPoints(r, delta);
    r.history.push({ author, list, lie, picks: { ...r.picks }, correct, fooled, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  ikyNext() {
    this.S.round.ti++;
    this.ikyBegin();
  },

  ikySkip() {
    const r = this.S.round;
    if (r.step === 'write') this.ikyNext();
    else if (r.step === 'guess') this.ikyReveal();
    else this.ikyNext();
  },

  ikyCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (!live.length) return;
    if (r.step === 'guess') {
      const author = r.turns[r.ti];
      const others = live.filter((id) => id !== author);
      if (others.length && others.every((id) => r.picks[id] != null)) this.ikyReveal();
    }
  },

  ikyFinish() {
    const r = this.S.round;
    const found = {};
    const fooled = {};
    for (const id of r.roster) { found[id] = 0; fooled[id] = 0; }
    for (const h of r.history) {
      for (const id of h.correct) found[id]++;
      fooled[h.author] += h.fooled;
    }
    this.finishCustom({
      scores: { ...r.scores }, found, fooled,
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
      history: r.history.map((h) => ({ author: h.author, lieText: h.list[h.lie], correct: h.correct.length, total: Object.keys(h.picks).length })),
    });
  },

  /* ---------- Sıralama ---------- */

  setupSir(r) {
    const turns = [];
    for (let k = 0; k < r.cfg.perPlayer; k++) turns.push(...shuffle(r.roster));
    Object.assign(r, { turns, ti: 0, history: [], scores: this.zeroScores(r) });
    this.sirBegin(true);
  },

  // The asker's turn: they write the question. A dropped asker keeps the turn; the leader can skip.
  sirBegin(silent) {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.sirFinish(); return; }
    Object.assign(r, { step: 'ask', q: null, ranks: {}, rankIds: [] });
    this.setStepDeadline(r.cfg.askTime);
    if (!silent) this.changed();
  },

  sirReveal() {
    const r = this.S.round;
    const ids = r.rankIds || [];
    const rankers = Object.keys(r.ranks);
    // The group's ranking: average place given by everyone (smaller = "more").
    const avg = {};
    for (const id of ids) avg[id] = rankers.length ? rankers.reduce((a, p) => a + r.ranks[p].indexOf(id), 0) / rankers.length : 0;
    const group = ids.slice().sort((a, b) => avg[a] - avg[b]);
    // People with the same average may swap places.
    const ok = (id, i) => {
      const first = group.findIndex((x) => avg[x] === avg[id]);
      let last = first;
      while (last + 1 < group.length && avg[group[last + 1]] === avg[id]) last++;
      return i >= first && i <= last;
    };
    const guesses = {};
    const delta = {};
    for (const p of rankers) {
      const order = r.ranks[p];
      const right = order.filter((x, i) => ok(x, i)).length;
      guesses[p] = { order, right };
      const pts = right * SIR_POS_POINTS + (right === group.length && rankers.length > 1 ? SIR_PERFECT_BONUS : 0);
      if (pts) delta[p] = pts;
    }
    this.addPoints(r, delta);
    r.history.push({ asker: r.turns[r.ti], q: r.q, group: group.map((id) => ({ id, avg: avg[id] })), guesses, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  sirNext() {
    this.S.round.ti++;
    this.sirBegin();
  },

  sirFinish() {
    const r = this.S.round;
    const perfect = {};
    for (const id of r.roster) perfect[id] = r.history.filter((h) => h.guesses[id] && h.guesses[id].right === h.group.length).length;
    this.finishCustom({
      scores: { ...r.scores }, perfect, ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
      recap: r.history.map((h) => ({ asker: h.asker, q: h.q, top: h.group[0] ? h.group[0].id : null })),
    });
  },

  sirSkip() {
    const r = this.S.round;
    if (r.step === 'ask') this.sirNext();
    else if (r.step === 'rank') this.sirReveal();
    else this.sirNext();
  },

  sirCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (r.step === 'rank' && live.length && live.every((id) => r.ranks[id])) this.sirReveal();
  },

  /* ---------- Kafe Savaşları ---------- */

  setupKafe(r) {
    const emojis = shuffle(KAFE_EMOJIS);
    const cafes = {};
    r.roster.forEach((id, i) => {
      cafes[id] = { name: 'Kafe ' + (this.S.players[id] ? this.S.players[id].name : '?'), e: emojis[i % emojis.length], money: KAFE_START, rep: 1, amb: 0, barista: 0,
        price: 40, sabLeft: KAFE_SABOTAGES, customers: 0, best: 0 };
    });
    const events = [KAFE_OPENING, ...shuffle(KAFE_EVENTS)];
    Object.assign(r, { cafes, day: 1, days: r.cfg.days, events, plans: {}, result: null, history: [] });
    this.kafeStartDay(true);
  },

  kafeEvent() {
    const r = this.S.round;
    return r.events[(r.day - 1) % r.events.length];
  },

  kafeStartDay(silent) {
    const r = this.S.round;
    r.step = 'plan';
    r.plans = {};
    this.setStepDeadline(r.cfg.planTime);
    if (!silent) this.changed();
  },

  kafeCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (r.step === 'plan' && live.length && live.every((id) => r.plans[id])) this.kafeResolve();
  },

  kafeSkip() {
    const r = this.S.round;
    if (r.step === 'plan') this.kafeResolve();
    else this.kafeNext();
  },

  // One day of business: customers pick cafés by quality, looks, ads, reputation and price.
  kafeResolve() {
    const r = this.S.round;
    const ev = this.kafeEvent();
    const ids = r.roster;
    const unit = ev.unit || KAFE_UNIT;
    const el = ev.el || 1.5;
    const base = (25 + 12 * ids.length) * (ev.c || 1);
    const plan = (id) => r.plans[id] || { price: r.cafes[id].price, inv: 'none', sab: null };
    const rats = new Set();
    const reviews = {};
    for (const id of ids) {
      const p = plan(id);
      const c = r.cafes[id];
      c.price = p.price;
      const inv = KAFE_INV[p.inv];
      if (inv.cost > c.money) p.inv = 'none';
      if (p.inv === 'decor') c.amb++;
      if (p.inv === 'barista') c.barista += 0.5;
      if (p.sab && c.sabLeft > 0) {
        c.sabLeft--;
        if (p.sab.type === 'rat') rats.add(p.sab.target);
        else reviews[p.sab.target] = (reviews[p.sab.target] || 0) + 1;
      }
    }
    for (const [id, n] of Object.entries(reviews)) r.cafes[id].rep = Math.max(0.4, r.cafes[id].rep - 0.25 * n);
    const attract = {};
    const quality = {};
    for (const id of ids) {
      const c = r.cafes[id];
      const p = plan(id);
      quality[id] = 1 + c.barista + (p.inv === 'bean' ? 0.7 : 0);
      attract[id] = Math.pow(quality[id], ev.q || 1) * (1 + 0.2 * c.amb) * (1 + (p.inv === 'ad' ? 0.7 * (ev.ad || 1) : 0)) * c.rep / Math.pow(p.price / 40, el);
    }
    const sum = Object.values(attract).reduce((a, b) => a + b, 0) || 1;
    const rows = {};
    for (const id of ids) {
      const c = r.cafes[id];
      const p = plan(id);
      const cust = Math.round(base * attract[id] / sum * (rats.has(id) ? 0.5 : 1));
      const revenue = cust * p.price;
      const cost = cust * unit + KAFE_INV[p.inv].cost + KAFE_RENT + (ev.tax || 0);
      const profit = revenue - cost;
      c.money += profit;
      c.customers += cust;
      c.best = Math.max(c.best, profit);
      // Good coffee at a fair price builds a reputation; rip-offs slowly ruin it.
      if (quality[id] >= 1.5 && p.price <= 60) c.rep = Math.min(1.6, c.rep + 0.08);
      if (p.price > 90) c.rep = Math.max(0.4, c.rep - 0.05);
      rows[id] = { cust, price: p.price, inv: p.inv, revenue, cost, profit, money: c.money, rat: rats.has(id), reviews: reviews[id] || 0 };
    }
    const avg = ids.reduce((a, id) => a + rows[id].cust, 0) / ids.length;
    for (const id of ids) rows[id].says = this.kafeComments(rows[id], r.cafes[id], avg);
    r.result = { day: r.day, ev, rows };
    r.history.push({ day: r.day, ev: ev.e + ' ' + ev.t, top: ids.slice().sort((a, b) => rows[b].profit - rows[a].profit)[0] });
    r.step = 'result';
    this.revealDeadline();
    this.changed();
  },

  // What customers said about a café today (two of the most relevant).
  kafeComments(row, c, avg) {
    const out = [];
    if (row.rat) out.push('Mutfakta fare gördüm 🐀🤢 Bir daha gelmem!');
    if (row.reviews) out.push('İnternette kötü yorumlar okudum, emin olamadım 🤔');
    if (row.price >= 90) out.push('Bir kahve ' + row.price + '₺ mi?! 😱');
    if (row.price <= 25) out.push('Bu fiyata bu kahve! Bedava gibi 😍');
    if (row.inv === 'bean') out.push('Çekirdekler efsane, böyle kahve içmedim ☕✨');
    if (row.inv === 'ad') out.push('Instagram\'da reklamını gördüm, geldim 📱');
    if (row.cust >= avg * 1.5 && row.cust > 5) out.push('Kuyruk kapıya kadar uzanıyordu! 🚶🚶🚶');
    if (row.cust <= avg * 0.4) out.push('Bomboştu, biraz ürktüm 👻');
    if (c.amb >= 2) out.push('Mekan çok şirin, saatlerce oturdum 🪴');
    if (c.barista >= 1) out.push('Barista latte art yaptı, kalp çizdi 🥹');
    if (!out.length) out.push(['Fena değildi, tekrar gelebilirim 🙂', 'Kahvesi idare eder ☕', 'Wi-Fi şifresini sormadan verdiler, güzel 📶'][Math.floor(Math.random() * 3)]);
    return out.slice(0, 2);
  },

  kafeNext() {
    const r = this.S.round;
    if (r.day >= r.days) { this.kafeFinish(); return; }
    r.day++;
    this.kafeStartDay();
  },

  kafeFinish() {
    const r = this.S.round;
    const scores = {};
    const customers = {};
    for (const id of r.roster) { scores[id] = r.cafes[id].money; customers[id] = r.cafes[id].customers; }
    this.finishCustom({
      scores, customers, cafes: JSON.parse(JSON.stringify(r.cafes)), history: r.history, days: r.days,
      ranking: r.roster.slice().sort((a, b) => scores[b] - scores[a]),
    });
  },

  /* ---------- Cinayet Gecesi ---------- */

  // A fresh, solvable mystery every time: who, where and with what is decided here, the clues follow from it.
  setupCin(r) {
    const ids = shuffle(r.roster);
    const killer = ids[0];
    const room = Math.floor(Math.random() * CIN_ROOMS.length);
    const weapon = Math.floor(Math.random() * CIN_WEAPONS.length);
    const chars = {};
    const charIdx = shuffle(CIN_CHARS.map((_, i) => i));
    r.roster.forEach((id, i) => { chars[id] = charIdx[i % charIdx.length]; });
    // Where everyone really was at 23:00. Innocents share rooms now and then, so they can vouch for each other.
    const truth = { [killer]: room };
    const free = shuffle(CIN_ROOMS.map((_, i) => i).filter((i) => i !== room));
    const used = [];
    for (const id of ids.slice(1)) {
      if (used.length && Math.random() < 0.45) truth[id] = used[Math.floor(Math.random() * used.length)];
      else { const rr = free.find((x) => !used.includes(x)); truth[id] = rr != null ? rr : used[0]; if (!used.includes(truth[id])) used.push(truth[id]); }
    }
    // Two traits each; the killer's traits are made to match a few other people, so no trait alone gives them away.
    const traits = {};
    for (const id of r.roster) traits[id] = shuffle(CIN_TRAITS.map((_, i) => i)).slice(0, 2);
    const innocents = ids.slice(1);
    for (const t of traits[killer]) {
      const holders = () => r.roster.filter((id) => traits[id].includes(t));
      for (const id of shuffle(innocents)) {
        if (holders().length >= Math.min(3, Math.ceil(r.roster.length / 2))) break;
        if (!traits[id].includes(t)) traits[id] = [traits[id][0], t];
      }
    }
    Object.assign(r, {
      killer, room, weapon, chars, truth, traits, victim: CIN_VICTIMS[Math.floor(Math.random() * CIN_VICTIMS.length)],
      place: CIN_PLACES[Math.floor(Math.random() * CIN_PLACES.length)], pubTrait: traits[killer][0], privTrait: traits[killer][1],
      declared: {}, round: 0, step: 'intro', ready: {}, votes: {}, events: [], clues: {}, frameUsed: false, result: null,
    });
    for (const id of r.roster) r.clues[id] = [];
    this.setStepDeadline(Math.max(60, r.cfg.discussTime));
  },

  cinName(id) {
    const p = this.S.players[id];
    return p ? p.name : '?';
  },

  // Public clue revealed at the start of each round.
  cinPublic(round) {
    const r = this.S.round;
    if (round === 1) return '🔪 ' + r.victim + ', saat 23:00 civarında ' + CIN_ROOMS[r.room].de + ' ölü bulundu.';
    if (round === 2) return '🩺 Otopsi raporu: ' + CIN_AUTOPSY[CIN_WEAPONS[r.weapon].k];
    return '🔍 Olay yerinde ' + CIN_TRAITS[r.pubTrait].t + '.';
  },

  // Everyone gets one private clue per round, built from the truth (and from what people claimed).
  cinDealClues(round) {
    const r = this.S.round;
    const innocents = shuffle(r.roster.filter((id) => id !== r.killer));
    const otherWeapons = shuffle(CIN_WEAPONS.map((_, i) => i).filter((i) => i !== r.weapon));
    const occupied = new Set(Object.entries(r.truth).filter(([id]) => id !== r.killer).map(([, v]) => v));
    const emptyRooms = CIN_ROOMS.map((_, i) => i).filter((i) => i !== r.room && !occupied.has(i));
    const say = (id, text) => r.clues[id].push({ round, text });
    const cleared = (id) => {
      const others = innocents.filter((x) => x !== id && r.truth[x] !== r.truth[id]);
      if (!others.length) return false;
      const z = others[Math.floor(Math.random() * others.length)];
      say(id, '👀 Saat 23:00\'te ' + CIN_ROOMS[r.truth[z]].de + ' ' + this.cinName(z) + ' vardı, kendi gözünle gördün.');
      return true;
    };
    const notWeapon = (id) => {
      const w = otherWeapons.pop();
      if (w == null) return false;
      say(id, CIN_WEAPONS[w].e + ' ' + CIN_WEAPONS[w].n + ' yerinde duruyordu. Cinayet onunla işlenmedi.');
      return true;
    };
    innocents.forEach((id, k) => {
      if (round === 2 && k === 0) {
        say(id, '🚶 Saat 23\'e doğru koridorda ' + CIN_TRAITS[r.privTrait].s + ' birini gördün ama yüzünü seçemedin.');
      } else if (round === 2 && k === 1 && emptyRooms.length) {
        // If the killer claimed an empty room, this is the clue that catches the lie.
        const claimed = r.declared[r.killer];
        const lr = emptyRooms.includes(claimed) && Math.random() < 0.6 ? claimed : emptyRooms[Math.floor(Math.random() * emptyRooms.length)];
        say(id, '🔒 ' + CIN_ROOMS[lr].n + ' saat 22:30\'dan sonra kilitliydi. Anahtarı sendeydi, içeride kimse olamazdı.');
      } else if (round === 3 && k === 0) {
        const other = innocents[1] || innocents[0];
        const pair = shuffle([r.killer, other]).map((x) => this.cinName(x));
        say(id, '🚪 Saat 22:55\'te biri ' + CIN_ROOMS[r.room].ye + ' girdi. Karanlıktı ama ya ' + pair[0] + ' ya da ' + pair[1] + ' olduğuna eminsin.');
      } else if (!(Math.random() < 0.5 ? cleared(id) || notWeapon(id) : notWeapon(id) || cleared(id))) {
        say(id, '🤷 Bu tur dikkatini çeken bir şey olmadı.');
      }
    });
    const k = r.killer;
    if (round === 1) {
      // Tell the killer whether their alibi room was really empty, so they know how risky their lie is.
      const d = r.declared[k];
      const there = d >= 0 ? r.roster.filter((id) => id !== k && r.truth[id] === d) : [];
      if (d < 0) say(k, '🤐 İfade vermedin. Bu da şüphe çekebilir…');
      else if (there.length) say(k, '😬 Kötü haber: Söylediğin odada (' + CIN_ROOMS[d].n + ') aslında ' + there.map((x) => this.cinName(x)).join(' ve ') + ' vardı. Yalanın ortaya çıkabilir!');
      else say(k, '😌 İyi haber: Söylediğin odada (' + CIN_ROOMS[d].n + ') kimse yoktu. Şimdilik güvendesin.');
    }
    if (round === 2) say(k, '😰 Dedikodu: Biri koridorda ' + CIN_TRAITS[r.privTrait].s + ' birini görmüş. Bu sensin!');
    if (round === 3) say(k, '😱 Biri seni ' + CIN_ROOMS[r.room].ye + ' girerken görmüş olabilir. Soğukkanlı ol!');
  },

  cinCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (!live.length) return;
    if (r.step === 'intro' && live.every((id) => r.declared[id] != null)) this.cinNextRound();
    else if (r.step === 'round' && live.every((id) => r.ready[id])) this.cinNextRound();
    else if (r.step === 'accuse' && live.every((id) => r.votes[id])) this.cinFinish();
  },

  cinNextRound() {
    const r = this.S.round;
    // Anyone who never made a statement is put on the record as "didn't say".
    if (r.round === 0) for (const id of r.roster) if (r.declared[id] == null) r.declared[id] = -1;
    if (r.round >= CIN_ROUNDS) {
      r.step = 'accuse';
      this.setStepDeadline(90);
      this.changed();
      return;
    }
    r.round++;
    r.step = 'round';
    r.ready = {};
    r.events.push({ round: r.round, text: this.cinPublic(r.round), pub: true });
    this.cinDealClues(r.round);
    this.setStepDeadline(r.cfg.discussTime);
    this.changed();
  },

  cinSkip() {
    const r = this.S.round;
    if (r.step === 'accuse') this.cinFinish();
    else this.cinNextRound();
  },

  cinFinish() {
    const r = this.S.round;
    const tally = {};
    for (const v of Object.values(r.votes)) tally[v.s] = (tally[v.s] || 0) + 1;
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((id) => tally[id] === top);
    const caught = top > 0 && leaders.length === 1 && leaders[0] === r.killer;
    const scores = {};
    const sherlocks = [];
    for (const id of r.roster) {
      scores[id] = 0;
      if (id === r.killer) continue;
      const v = r.votes[id];
      if (caught) scores[id] += CIN_WIN_POINTS;
      if (v && v.s === r.killer) {
        scores[id] += CIN_VOTE_POINTS;
        if (v.w === r.weapon) { scores[id] += CIN_WEAPON_POINTS; sherlocks.push(id); }
      }
    }
    if (!caught) scores[r.killer] += CIN_ESCAPE_POINTS;
    scores[r.killer] += Object.entries(r.votes).filter(([id, v]) => id !== r.killer && v.s !== r.killer).length * CIN_DODGE_POINTS;
    this.finishCustom({
      killer: r.killer, room: r.room, weapon: r.weapon, victim: r.victim, place: r.place, caught, tally, votes: { ...r.votes },
      chars: { ...r.chars }, truth: { ...r.truth }, declared: { ...r.declared }, traits: { ...r.traits }, events: r.events, sherlocks,
      scores, ranking: r.roster.slice().sort((a, b) => scores[b] - scores[a]),
    });
  },

  /* ---------- Bilgi Yarışması ---------- */

  setupQuiz(r) {
    const zero = () => Object.fromEntries(r.roster.map((id) => [id, 0]));
    Object.assign(r, { qs: buildQuiz(r.cfg.category, r.cfg.qCount), qi: 0, scores: zero(), mapPts: zero(), right: zero(), result: null });
    this.quizBegin(true);
  },

  quizTime() {
    const r = this.S.round;
    return r.cfg.time + (r.qs[r.qi] && r.qs[r.qi].type === 'map' ? QUIZ_MAP_EXTRA : 0);
  },

  quizBegin(silent) {
    const r = this.S.round;
    if (r.qi >= r.qs.length) { this.quizFinish(); return; }
    Object.assign(r, { step: 'q', ans: {}, qStart: Date.now(), result: null });
    this.setStepDeadline(this.quizTime());
    if (!silent) this.changed();
  },

  quizCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (r.step === 'q' && live.length && live.every((id) => r.ans[id])) this.quizReveal();
  },

  quizReveal() {
    const r = this.S.round;
    const q = r.qs[r.qi];
    const total = this.quizTime() * 1000;
    const delta = {};
    const picks = {};
    const pins = {};
    for (const [id, a] of Object.entries(r.ans)) {
      if (q.type === 'map') {
        const d = distKm(a.lat, a.lng, q.lat, q.lng);
        const pts = Math.round(1000 * Math.max(0, 1 - d / (q.tr ? QUIZ_TR_KM : QUIZ_WORLD_KM)));
        pins[id] = { lat: a.lat, lng: a.lng, km: Math.round(d), pts };
        if (pts) { delta[id] = pts; r.mapPts[id] += pts; }
      } else {
        picks[id] = a.i;
        if (a.i === q.ans) {
          delta[id] = QUIZ_BASE + Math.round(QUIZ_SPEED * Math.max(0, 1 - a.t / total));
          r.right[id]++;
        }
      }
    }
    this.addPoints(r, delta);
    r.result = { ans: q.ans, lat: q.lat, lng: q.lng, place: q.place, picks, pins, delta, scores: { ...r.scores } };
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  quizNext() {
    this.S.round.qi++;
    this.quizBegin();
  },

  quizSkip() {
    const r = this.S.round;
    if (r.step === 'q') this.quizReveal();
    else this.quizNext();
  },

  quizFinish() {
    const r = this.S.round;
    this.finishCustom({
      scores: { ...r.scores }, mapPts: { ...r.mapPts }, right: { ...r.right }, qn: r.qs.length,
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
    });
  },

  /* ---------- Taklitçi ---------- */

  // Everyone secretly plays someone else (nobody plays themselves).
  setupTak(r) {
    const ids = r.roster.slice();
    let perm;
    do { perm = shuffle(ids); } while (perm.some((id, i) => id === ids[i]));
    const target = {};
    const imp = {};
    ids.forEach((id, i) => { target[id] = perm[i]; imp[perm[i]] = id; });
    Object.assign(r, { target, imp, qs: shuffle(TAK_QUESTIONS).slice(0, r.cfg.rounds), ri: 0, history: [], scores: this.zeroScores(r), guesses: {}, unmask: null });
    this.takBegin(true);
  },

  takBegin(silent) {
    const r = this.S.round;
    if (r.ri >= r.qs.length) { this.takStartGuess(); return; }
    Object.assign(r, { step: 'write', answers: {}, cards: [], votes: {} });
    this.setStepDeadline(r.cfg.writeTime);
    if (!silent) this.changed();
  },

  // One card per person: their real answer next to the imitation of them, in random order.
  takStartVote() {
    const r = this.S.round;
    r.cards = shuffle(r.roster.filter((sub) => r.answers[sub] && r.answers[r.imp[sub]]).map((sub) => {
      const real = r.answers[sub].real;
      const fake = r.answers[r.imp[sub]].fake;
      const realIdx = Math.random() < 0.5 ? 0 : 1;
      return { subject: sub, opts: realIdx ? [fake, real] : [real, fake], realIdx };
    }));
    r.votes = {};
    if (!r.cards.length) { this.takReveal(); return; }
    r.step = 'vote';
    this.setStepDeadline(r.cfg.voteTime);
    this.changed();
  },

  takVotedAll(id) {
    const r = this.S.round;
    const v = r.votes[id] || {};
    return r.cards.every((c) => c.subject === id || v[c.subject] != null);
  },

  takCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (!live.length) return;
    if (r.step === 'write' && live.every((id) => r.answers[id])) this.takStartVote();
    else if (r.step === 'vote' && live.every((id) => this.takVotedAll(id))) this.takReveal();
    else if (r.step === 'guess' && live.every((id) => r.guesses[id])) this.takUnmask();
  },

  // Everyone except the person themselves votes on a card, the hidden imitator too (so nobody stands out).
  takReveal() {
    const r = this.S.round;
    const delta = {};
    const add = (id, n) => { delta[id] = (delta[id] || 0) + n; };
    const cards = r.cards.map((c) => {
      const picks = {};
      for (const [voter, v] of Object.entries(r.votes)) if (voter !== c.subject && v[c.subject] != null) picks[voter] = v[c.subject];
      let fooled = 0;
      for (const [voter, idx] of Object.entries(picks)) {
        if (idx === c.realIdx) add(voter, TAK_REAL_POINTS);
        else { fooled++; add(r.imp[c.subject], TAK_FOOL_POINTS); }
      }
      return { ...c, picks, fooled };
    });
    this.addPoints(r, delta);
    r.history.push({ q: r.qs[r.ri], cards, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  takNext() {
    this.S.round.ri++;
    this.takBegin();
  },

  takStartGuess() {
    const r = this.S.round;
    r.step = 'guess';
    r.guesses = {};
    this.setStepDeadline(TAK_GUESS_SECONDS);
    this.changed();
  },

  takUnmask() {
    const r = this.S.round;
    const delta = {};
    const rows = shuffle(r.roster).map((sub) => {
      const imp = r.imp[sub];
      const guess = r.guesses[sub] || null;
      const right = guess === imp;
      if (right) delta[sub] = (delta[sub] || 0) + TAK_GUESS_POINTS;
      else delta[imp] = (delta[imp] || 0) + TAK_HIDDEN_POINTS;
      return { subject: sub, imp, guess, right };
    });
    this.addPoints(r, delta);
    r.unmask = { rows, delta, scores: { ...r.scores } };
    r.step = 'unmask';
    this.revealDeadline();
    this.changed();
  },

  takFinish() {
    const r = this.S.round;
    const found = {};
    const fooled = {};
    for (const id of r.roster) { found[id] = 0; fooled[id] = 0; }
    let best = null;
    for (const h of r.history) {
      for (const c of h.cards) {
        const imp = r.imp[c.subject];
        fooled[imp] += c.fooled;
        for (const [v, idx] of Object.entries(c.picks)) if (idx === c.realIdx) found[v]++;
        if (c.fooled && (!best || c.fooled > best.fooled)) best = { imp, subject: c.subject, text: c.opts[1 - c.realIdx], q: h.q, fooled: c.fooled };
      }
    }
    const caught = {};
    for (const row of (r.unmask ? r.unmask.rows : [])) caught[row.imp] = row.right;
    this.finishCustom({
      scores: { ...r.scores }, found, fooled, caught, best, target: { ...r.target },
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
    });
  },

  takSkip() {
    const r = this.S.round;
    if (r.step === 'write') this.takStartVote();
    else if (r.step === 'vote') this.takReveal();
    else if (r.step === 'reveal') this.takNext();
    else if (r.step === 'guess') this.takUnmask();
    else this.takFinish();
  },

  /* ---------- Yalan Zar ---------- */

  setupZar(r) {
    const n = Number(r.cfg.dice) || 5;
    const counts = {};
    for (const id of r.roster) counts[id] = n;
    Object.assign(r, { seats: shuffle(r.roster), counts, out: [], round: 0, caught: {}, dice: {}, history: [] });
    for (const id of r.roster) r.caught[id] = 0;
    this.zarRoll(r.seats[0], true);
  },

  zarAlive() {
    const r = this.S.round;
    return r.seats.filter((id) => r.counts[id] > 0);
  },

  // The next player still in the game after id, going round the table.
  zarAfter(id) {
    const r = this.S.round;
    const i = r.seats.indexOf(id);
    for (let k = 1; k <= r.seats.length; k++) {
      const c = r.seats[(i + k) % r.seats.length];
      if (r.counts[c] > 0) return c;
    }
    return id;
  },

  zarRoll(starter, silent) {
    const r = this.S.round;
    r.round++;
    r.dice = {};
    for (const id of this.zarAlive()) r.dice[id] = Array.from({ length: r.counts[id] }, () => 1 + Math.floor(Math.random() * 6)).sort();
    r.turn = r.counts[starter] > 0 ? starter : this.zarAfter(starter);
    Object.assign(r, { step: 'bid', bid: null, bids: [], result: null, pendingEnd: false });
    this.setStepDeadline(r.cfg.moveTime);
    if (!silent) this.changed();
  },

  zarTurn() {
    const r = this.S.round;
    return r && r.step === 'bid' ? r.turn : null;
  },

  zarTotal() {
    const r = this.S.round;
    return this.zarAlive().reduce((a, id) => a + r.counts[id], 0);
  },

  zarBidOk(q, f) {
    const r = this.S.round;
    const minF = r.cfg.jokers ? 2 : 1;
    if (!(q >= 1 && q <= this.zarTotal() && f >= minF && f <= 6)) return false;
    return !r.bid || q > r.bid.q || (q === r.bid.q && f > r.bid.f);
  },

  zarBid(pid, q, f) {
    const r = this.S.round;
    r.bid = { id: pid, q, f };
    r.bids.push(r.bid);
    r.turn = this.zarAfter(pid);
    this.setStepDeadline(r.cfg.moveTime);
    this.changed();
  },

  // Out of time (or skipped by the leader): the smallest possible raise is made for them.
  zarSkip() {
    const r = this.S.round;
    if (r.step === 'reveal') { this.zarNext(); return; }
    const minF = r.cfg.jokers ? 2 : 1;
    let q = r.bid ? r.bid.q : 1;
    let f = r.bid ? r.bid.f + 1 : minF;
    if (f > 6) { q++; f = minF; }
    if (this.zarBidOk(q, f)) this.zarBid(r.turn, q, f);
    else this.zarReveal(r.turn);
  },

  zarReveal(caller) {
    const r = this.S.round;
    const bid = r.bid;
    let count = 0;
    for (const id of Object.keys(r.dice)) for (const d of r.dice[id]) if (d === bid.f || (r.cfg.jokers && d === 1)) count++;
    const truth = count >= bid.q;
    const loser = truth ? caller : bid.id;
    if (!truth) r.caught[caller]++;
    r.counts[loser]--;
    if (!r.counts[loser]) r.out.push(loser);
    r.result = { caller, bid, count, truth, loser, dice: { ...r.dice }, gone: !r.counts[loser] };
    r.history.push({ round: r.round, caller, bid, count, loser });
    r.starter = loser;
    r.pendingEnd = this.zarAlive().length <= 1;
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  zarNext() {
    const r = this.S.round;
    if (r.pendingEnd) { this.zarFinish(); return; }
    this.zarRoll(r.starter);
  },

  zarFinish() {
    const r = this.S.round;
    const ranking = this.zarAlive().concat(r.out.slice().reverse()).concat(r.roster.filter((id) => !r.seats.includes(id)));
    const scores = {};
    ranking.forEach((id, i) => { scores[id] = ranking.length - 1 - i; });
    this.finishCustom({ scores, ranking, caught: { ...r.caught }, rounds: r.round, history: r.history });
  },

  /* ---------- Sıcak Patates ---------- */

  setupPat(r) {
    const lives = Number(r.cfg.lives) || 2;
    const alive = {};
    const hearts = {};
    for (const id of r.roster) { alive[id] = true; hearts[id] = lives; }
    Object.assign(r, { seats: shuffle(r.roster), alive, hearts, maxH: lives, out: [], round: 0, prompts: [], history: [] });
    this.patStart(r.seats[0], true);
  },

  patAfter(id) {
    const r = this.S.round;
    const i = r.seats.indexOf(id);
    for (let k = 1; k <= r.seats.length; k++) {
      const c = r.seats[(i + k) % r.seats.length];
      if (r.alive[c]) return c;
    }
    return id;
  },

  patStart(holder, silent) {
    const r = this.S.round;
    const [lo, hi] = PAT_FUSE[r.cfg.fuse] || PAT_FUSE.normal;
    r.round++;
    r.prompt = patPrompt(r.prompts);
    r.prompts.push(r.prompt.text);
    r.holder = r.alive[holder] ? holder : this.patAfter(holder);
    r.boomAt = Date.now() + (lo + Math.random() * (hi - lo)) * 1000;
    r.used = [];
    r.feed = [];
    r.last = null;
    r.step = 'play';
    r.deadline = null;
    r.result = null;
    if (!silent) this.changed();
  },

  // Returns why an answer is refused, or null.
  patCheckAnswer(text) {
    const r = this.S.round;
    if (normWord(text).length < 2) return 'Biraz daha uzun bir cevap yaz 🙂';
    if (r.prompt.letter && text.toLocaleUpperCase('tr')[0] !== r.prompt.letter) return '"' + r.prompt.letter + '" harfiyle başlamalı!';
    if (r.used.includes(normWord(text))) return 'Bu cevap bu turda zaten yazıldı! 🔁';
    return null;
  },

  patAnswer(pid, text) {
    const r = this.S.round;
    r.used.push(normWord(text));
    r.last = { id: pid, text, downs: {} };
    r.feed.push({ id: pid, text, ok: true });
    r.holder = this.patAfter(pid);
    this.changed();
  },

  // Enough people said "no way": the answer doesn't count and the bomb goes back.
  patVeto() {
    const r = this.S.round;
    const others = r.seats.filter((id) => r.alive[id] && id !== r.last.id).length;
    const need = Math.max(1, Math.ceil(others / 2));
    if (Object.keys(r.last.downs).length < need) return;
    const f = r.feed[r.feed.length - 1];
    f.ok = false;
    r.used = r.used.filter((x) => x !== normWord(r.last.text));
    r.holder = r.last.id;
    r.last = null;
  },

  // Leader skip: the bomb moves on without an answer.
  patSkip() {
    const r = this.S.round;
    if (r.step === 'reveal') { this.patNext(); return; }
    r.feed.push({ id: r.holder, text: null, ok: false });
    r.last = null;
    r.holder = this.patAfter(r.holder);
    this.changed();
  },

  patBoom() {
    const r = this.S.round;
    const victim = r.holder;
    r.hearts[victim]--;
    if (r.hearts[victim] <= 0) { r.alive[victim] = false; r.out.push(victim); }
    r.result = { victim, gone: !r.alive[victim], prompt: r.prompt.text, feed: r.feed };
    r.history.push({ round: r.round, prompt: r.prompt.text, victim, answers: r.feed.filter((f) => f.ok).length });
    r.pendingEnd = r.seats.filter((id) => r.alive[id]).length <= 1;
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  patNext() {
    const r = this.S.round;
    if (r.pendingEnd) {
      const ranking = r.seats.filter((id) => r.alive[id]).concat(r.out.slice().reverse());
      const scores = {};
      ranking.forEach((id, i) => { scores[id] = ranking.length - 1 - i; });
      this.finishCustom({ scores, ranking, rounds: r.round, history: r.history });
      return;
    }
    this.patStart(r.result.victim);
  },

  /* ---------- Vampir Köyü ---------- */

  setupVamp(r) {
    const n = r.roster.length;
    const cfg = r.cfg;
    let vc = cfg.vamps === 'auto' ? (n <= 6 ? 1 : n <= 9 ? 2 : 3) : Number(cfg.vamps);
    vc = Math.max(1, Math.min(vc, Math.floor((n - 1) / 2)));
    const roles = [];
    roles.push(Math.random() < 0.5 ? 'vampir' : 'kont');
    for (let k = 1; k < vc; k++) roles.push('vampir');
    // The Uşak only joins a lone vampire (or a big village), so the night team never gets too strong.
    if (n >= 6 && (vc === 1 || n >= 10)) roles.push('usak');
    if (cfg.neutral && n >= 5) roles.push(...shuffle(['soytari', 'gezgin']).slice(0, n >= 9 ? 2 : 1));
    roles.push('kahin');
    // With roles visible on death the Mezarcı has nothing to do.
    const pool = shuffle(VAMP_EXTRA_POOL.filter((x) => !(x === 'mezarci' && cfg.reveal === 'role')));
    while (roles.length < n) roles.push(pool.length ? pool.pop() : 'koylu');
    const order = shuffle(r.roster);
    const assigned = {};
    const alive = {};
    const hearts = {};
    const maxH = {};
    const used = {};
    const log = {};
    const base = Number(cfg.hearts) || 2;
    order.forEach((id, i) => {
      assigned[id] = roles[i];
      alive[id] = true;
      maxH[id] = hearts[id] = base + (roles[i] === 'gezgin' ? 1 : 0);
      used[id] = {};
      log[id] = [];
    });
    const teamOrder = { vamp: 0, koy: 1, neutral: 2 };
    Object.assign(r, {
      roles: assigned, alive, hearts, maxH, used, log, lastHeal: {}, night: 1, nights: cfg.nights,
      step: 'roles', ready: {}, acts: {}, votes: {}, report: null, result: null, history: [], vchat: [], shown: {}, pendingEnd: null,
      roleList: roles.slice().sort((a, b) => teamOrder[VAMP_ROLES[a].team] - teamOrder[VAMP_ROLES[b].team]),
    });
    this.setStepDeadline(VAMP_ROLE_SECONDS);
  },

  vampTeam(id) {
    return VAMP_ROLES[this.S.round.roles[id]].team;
  },

  vampCtx(pid) {
    const r = this.S.round;
    const mates = r.roster.filter((id) => this.vampTeam(id) === 'vamp');
    return { self: pid, role: r.roles[pid], alive: r.alive, roster: r.roster, mates: this.vampTeam(pid) === 'vamp' ? mates : [], used: r.used[pid], lastHeal: r.lastHeal[pid] };
  },

  // Everyone alive and connected; a dropped player doesn't hold the night up.
  vampWaiting() {
    const r = this.S.round;
    return this.liveIds().filter((id) => r.alive[id]);
  },

  vampCheck() {
    const r = this.S.round;
    const live = this.vampWaiting();
    if (!live.length) return;
    if (r.step === 'roles' && live.every((id) => r.ready[id])) this.vampStartNight();
    else if (r.step === 'night' && live.every((id) => r.acts[id])) this.vampResolveNight();
    else if (r.step === 'day' && live.every((id) => r.votes[id])) this.vampResolveDay();
  },

  vampSkip() {
    const r = this.S.round;
    if (r.step === 'roles') this.vampStartNight();
    else if (r.step === 'night') this.vampResolveNight();
    else if (r.step === 'day') this.vampResolveDay();
    else this.vampNext();
  },

  vampStartNight() {
    const r = this.S.round;
    r.step = 'night';
    r.acts = {};
    this.setStepDeadline(r.cfg.nightTime);
    this.changed();
  },

  // What the village is told about a dead player, depending on the setting.
  vampShow(id) {
    const r = this.S.round;
    if (r.cfg.reveal === 'role') r.shown[id] = r.roles[id];
    else if (r.cfg.reveal === 'team') r.shown[id] = 'team:' + VAMP_ROLES[r.roles[id]].team;
  },

  vampResolveNight() {
    const r = this.S.round;
    const ids = r.roster.filter((id) => r.alive[id]);
    const info = {};
    for (const id of r.roster) info[id] = [];
    const act = (id) => r.acts[id] || { kind: 'pass', target: null };
    // 1) Police custody comes first: the suspect spends the night at the station and their plan is heard.
    const jailed = new Set();
    for (const id of ids) {
      const a = act(id);
      if (a.kind === 'jail') { jailed.add(a.target); info[id].push({ k: 'jailInfo', t: a.target, plan: act(a.target).kind }); }
    }
    // 2) The Uşak keeps people busy: their move is lost (an interrogation can't be stopped).
    const blocked = new Set(jailed);
    for (const id of ids) {
      const a = act(id);
      if (a.kind !== 'block' || jailed.has(id)) continue;
      if (act(a.target).kind !== 'jail') blocked.add(a.target);
      info[id].push({ k: 'blockDone', t: a.target });
    }
    const did = (id) => !blocked.has(id) && act(id).kind !== 'pass';
    for (const id of ids) {
      if (jailed.has(id)) info[id].push({ k: 'jailed' });
      else if (blocked.has(id)) info[id].push({ k: 'blocked' });
      else if (act(id).kind === 'pass') info[id].push({ k: 'pass' });
    }
    // 2) Hiding and the bell.
    const hidden = new Set();
    let bell = false;
    for (const id of ids) {
      if (!did(id)) continue;
      const a = act(id);
      if (a.kind === 'hide') { hidden.add(id); r.used[id].hide = (r.used[id].hide || 0) + 1; }
      if (a.kind === 'bell') { bell = true; r.used[id].bell = true; info[id].push({ k: 'bellRang' }); }
    }
    // Nobody can reach someone who is at the police station.
    for (const id of jailed) hidden.add(id);
    // 3) The vampires' choice: most picked target, ties go to the earlier vampire in the list.
    const biters = ids.filter((id) => act(id).kind === 'bite' && did(id));
    const count = {};
    for (const id of biters) count[act(id).target] = (count[act(id).target] || 0) + 1;
    let prey = null;
    for (const id of biters) if (!prey || count[act(id).target] > count[prey]) prey = act(id).target;
    const biter = prey ? biters.find((id) => act(id).target === prey) : null;
    // 4) Visits (watchers count them, the Dedektif follows them).
    const visits = [];
    for (const id of ids) {
      const a = act(id);
      if (!did(id) || !VAMP_KINDS[a.kind].visit) continue;
      if (a.kind === 'bite' && id !== biter) continue;
      visits.push({ from: id, to: a.target });
    }
    const garlic = new Set(ids.filter((id) => did(id) && act(id).kind === 'garlic').map((id) => act(id).target));
    const knocked = new Set();
    const killed = new Set();
    let bites = 0;
    // 5) The bite.
    if (biter) {
      let why = null;
      if (bell) why = 'bell';
      else if (hidden.has(prey)) why = 'hide';
      else if (garlic.has(prey)) why = 'garlic';
      if (why) {
        info[biter].push({ k: 'biteFail', t: prey, why });
        if (why === 'hide') knocked.add(prey);
        if (why === 'garlic') for (const id of ids) if (did(id) && act(id).kind === 'garlic' && act(id).target === prey) info[id].push({ k: 'garlicHit', t: prey });
      } else {
        r.hearts[prey]--;
        bites++;
        info[biter].push({ k: 'biteOk', t: prey });
        info[prey].push({ k: 'bitten' });
      }
    }
    for (const id of ids) {
      const a = act(id);
      if (did(id) && a.kind === 'garlic' && !info[id].some((x) => x.k === 'garlicHit')) info[id].push({ k: 'garlicQuiet', t: a.target });
    }
    // 6) The Avcı's stake.
    for (const id of ids) {
      const a = act(id);
      if (!did(id) || a.kind !== 'stake') continue;
      r.used[id].stake = true;
      if (hidden.has(a.target)) { knocked.add(a.target); info[id].push({ k: 'stakeLost', t: a.target }); continue; }
      const role = r.roles[a.target];
      if (role === 'vampir' || role === 'kont') { killed.add(a.target); info[id].push({ k: 'stakeVamp', t: a.target }); }
      else { r.hearts[a.target]--; info[id].push({ k: 'stakeMiss', t: a.target }); info[a.target].push({ k: 'staked' }); }
    }
    // 6b) The Polis's gun: a vampire-side target dies, an innocent one costs the Polis their own life.
    for (const id of ids) {
      const a = act(id);
      if (!did(id) || a.kind !== 'shoot') continue;
      r.used[id].bullets = (r.used[id].bullets || 0) + 1;
      if (hidden.has(a.target)) { knocked.add(a.target); info[id].push({ k: 'shotLost', t: a.target }); continue; }
      if (VAMP_ROLES[r.roles[a.target]].team === 'vamp') { killed.add(a.target); info[id].push({ k: 'shotHit', t: a.target }); info[a.target].push({ k: 'shot' }); }
      else { killed.add(id); info[id].push({ k: 'shotMiss', t: a.target }); }
    }
    // 7) Healing comes last, so the Doktor can save someone who was hurt tonight.
    for (const id of ids) {
      const a = act(id);
      if (!did(id) || a.kind !== 'heal') continue;
      r.lastHeal[id] = a.target;
      if (a.target === id) r.used[id].selfHeal = true;
      if (hidden.has(a.target)) { knocked.add(a.target); info[id].push({ k: 'healLost', t: a.target }); continue; }
      info[id].push({ k: 'healDone', t: a.target });
      if (r.hearts[a.target] < r.maxH[a.target] && !killed.has(a.target)) {
        r.hearts[a.target]++;
        if (a.target !== id) info[a.target].push({ k: 'healed' });
      }
    }
    // 8) Who didn't make it.
    const deaths = ids.filter((id) => killed.has(id) || r.hearts[id] <= 0);
    for (const id of deaths) { r.alive[id] = false; r.hearts[id] = 0; info[id].push({ k: 'died' }); this.vampShow(id); }
    // 9) What the quiet roles found out.
    for (const id of ids) {
      const a = act(id);
      if (!did(id)) continue;
      if (a.kind === 'seer') info[id].push({ k: 'seer', t: a.target, team: vampSeenTeam(r.roles[a.target]) });
      if (a.kind === 'watch') info[id].push({ k: 'watch', t: a.target, n: visits.filter((v) => v.to === a.target).length });
      if (a.kind === 'track') { const v = visits.find((x) => x.from === a.target); info[id].push({ k: 'track', t: a.target, to: v ? v.to : null }); }
      if (a.kind === 'grave') info[id].push({ k: 'grave', t: a.target, role: r.roles[a.target] });
      if (a.kind === 'roam') info[id].push({ k: 'roam', t: a.target });
      if (a.kind === 'hide') info[id].push({ k: 'hid', knocked: knocked.has(id) });
    }
    for (const id of r.roster) if (info[id].length) r.log[id].push({ night: r.night, items: info[id] });
    r.info = info;
    r.report = { night: r.night, deaths, bites: bites - deaths.filter((id) => !killed.has(id) && biter && prey === id).length, bell };
    r.history.push({ night: r.night, deaths, bell, staked: null, votes: null });
    const end = this.vampWinner();
    if (end) { this.vampEnd(end); return; }
    r.step = 'day';
    r.votes = {};
    this.setStepDeadline(r.cfg.dayTime);
    this.changed();
  },

  vampResolveDay() {
    const r = this.S.round;
    const tally = {};
    let none = 0;
    for (const [id, t] of Object.entries(r.votes)) {
      if (!r.alive[id]) continue;
      const w = r.roles[id] === 'muhtar' ? 2 : 1;
      if (t === 'none') none += w; else tally[t] = (tally[t] || 0) + w;
    }
    const top = Math.max(0, ...Object.values(tally));
    const leaders = Object.keys(tally).filter((id) => tally[id] === top);
    const staked = top > 0 && leaders.length === 1 && top > none ? leaders[0] : null;
    if (staked) { r.alive[staked] = false; r.hearts[staked] = 0; this.vampShow(staked); }
    const h = r.history[r.history.length - 1];
    h.staked = staked;
    h.votes = { ...r.votes };
    r.result = { staked, votes: { ...r.votes }, tally, none, tie: !staked && top > 0 && top >= none };
    r.pendingEnd = staked && r.roles[staked] === 'soytari' ? 'soytari' : this.vampWinner() || (r.night >= r.nights ? 'moon' : null);
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  // 'koy' when every vampire is gone, 'vamp' when they can't be outvoted any more.
  vampWinner() {
    const r = this.S.round;
    const living = r.roster.filter((id) => r.alive[id]);
    const fangs = living.filter((id) => r.roles[id] === 'vampir' || r.roles[id] === 'kont');
    if (!fangs.length) return 'koy';
    const team = living.filter((id) => this.vampTeam(id) === 'vamp').length;
    if (team >= living.length - team) return 'vamp';
    return null;
  },

  vampNext() {
    const r = this.S.round;
    if (r.pendingEnd) { this.vampEnd(r.pendingEnd); return; }
    r.night++;
    this.vampStartNight();
  },

  vampEnd(end) {
    const r = this.S.round;
    const winTeam = end === 'moon' ? 'vamp' : end;
    const winners = r.roster.filter((id) => (winTeam === 'soytari' ? r.roles[id] === 'soytari' : this.vampTeam(id) === winTeam) || (r.roles[id] === 'gezgin' && r.alive[id]));
    const scores = {};
    for (const id of r.roster) scores[id] = winners.includes(id) ? 1 : 0;
    this.finishCustom({
      end, winTeam, winners, roles: { ...r.roles }, alive: { ...r.alive }, history: r.history, nights: r.nights, report: r.report,
      scores, ranking: r.roster.slice().sort((a, b) => scores[b] - scores[a]),
    });
  },

  /* ---------- Adam Asmaca ---------- */

  // Own mode: each turn one player writes the word and the rest take turns guessing.
  // Bank mode: the word comes from the list and everyone guesses.
  setupAdam(r) {
    const own = r.cfg.source !== 'bank';
    const turns = [];
    for (let k = 0; k < r.cfg.perPlayer; k++) turns.push(...(own ? shuffle(r.roster) : r.roster.map(() => null)));
    Object.assign(r, { turns, ti: 0, lives: Number(r.cfg.lives) || 8, history: [], scores: this.zeroScores(r), order: shuffle(r.roster) });
    this.adamBegin(true);
  },

  adamBegin(silent) {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.adamFinish(); return; }
    const setter = r.turns[r.ti];
    // Guessers take turns starting with the player after the word owner.
    const base = r.order;
    const start = setter ? (base.indexOf(setter) + 1) % base.length : r.ti % base.length;
    const guessers = base.slice(start).concat(base.slice(0, start)).filter((id) => id !== setter);
    Object.assign(r, { setter, word: null, hint: '', used: {}, wrong: 0, gi: 0, guessers, last: null, rd: {} });
    if (setter) {
      r.step = 'write';
      this.setStepDeadline(r.cfg.writeTime);
      if (!silent) this.changed();
    } else {
      const pick = adamPick(r.cfg.category, r.history.map((h) => h.word));
      r.word = adamClean(pick.word);
      r.hint = pick.hint;
      this.adamStartPlay(silent);
    }
  },

  adamStartPlay(silent) {
    const r = this.S.round;
    r.step = 'play';
    this.setStepDeadline(r.cfg.moveTime);
    if (!silent) this.changed();
  },

  adamTurn() {
    const r = this.S.round;
    return r && r.guessers && r.guessers.length ? r.guessers[r.gi % r.guessers.length] : null;
  },

  adamPass(last) {
    const r = this.S.round;
    r.last = last;
    r.gi++;
    this.setStepDeadline(r.cfg.moveTime);
    this.changed();
  },

  adamMiss(last) {
    const r = this.S.round;
    r.wrong++;
    if (r.wrong >= r.lives) { r.last = last; this.adamReveal('hanged', null); return; }
    this.adamPass(last);
  },

  adamLetter(pid, l) {
    const r = this.S.round;
    const n = [...r.word].filter((c) => c === l).length;
    r.used[l] = n > 0;
    if (!n) { this.adamMiss({ id: pid, l, n: 0 }); return; }
    r.rd[pid] = (r.rd[pid] || 0) + n * ADAM_LETTER_POINTS;
    const last = { id: pid, l, n, pts: n * ADAM_LETTER_POINTS };
    if ([...r.word].every((c) => c === ' ' || r.used[c])) {
      r.rd[pid] += ADAM_LAST_POINTS;
      r.last = last;
      this.adamReveal('letters', pid);
      return;
    }
    // A right letter keeps the turn.
    r.last = last;
    this.setStepDeadline(r.cfg.moveTime);
    this.changed();
  },

  adamSolve(pid, text) {
    const r = this.S.round;
    if (normWord(text) !== normWord(r.word)) { this.adamMiss({ id: pid, text, bad: true }); return; }
    const hidden = [...r.word].filter((c) => c !== ' ' && !r.used[c]).length;
    r.rd[pid] = (r.rd[pid] || 0) + ADAM_SOLVE_POINTS + hidden * ADAM_HIDDEN_POINTS;
    r.last = { id: pid, text, ok: true };
    this.adamReveal('solved', pid);
  },

  adamReveal(outcome, solver) {
    const r = this.S.round;
    const delta = { ...r.rd };
    if (r.setter) {
      const pts = r.wrong * ADAM_MISS_POINTS + (outcome === 'hanged' ? ADAM_HANG_POINTS : 0);
      if (pts) delta[r.setter] = (delta[r.setter] || 0) + pts;
    }
    for (const id of Object.keys(delta)) if (!delta[id]) delete delta[id];
    this.addPoints(r, delta);
    r.history.push({ setter: r.setter, word: r.word, hint: r.hint, used: { ...r.used }, outcome, solver, wrong: r.wrong, lives: r.lives, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    this.revealDeadline();
    this.changed();
  },

  adamNext() {
    this.S.round.ti++;
    this.adamBegin();
  },

  adamSkip() {
    const r = this.S.round;
    if (r.step === 'write') this.adamNext();
    else if (r.step === 'play') this.adamPass({ id: this.adamTurn(), pass: true });
    else this.adamNext();
  },

  adamFinish() {
    const r = this.S.round;
    const solved = {};
    const hanged = {};
    for (const id of r.roster) { solved[id] = 0; hanged[id] = 0; }
    for (const h of r.history) {
      if (h.solver && solved[h.solver] != null) solved[h.solver]++;
      if (h.outcome === 'hanged' && h.setter && hanged[h.setter] != null) hanged[h.setter]++;
    }
    this.finishCustom({
      scores: { ...r.scores }, solved, hanged, own: r.cfg.source !== 'bank',
      ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a]),
      history: r.history.map((h) => ({ setter: h.setter, word: h.word, outcome: h.outcome, solver: h.solver, wrong: h.wrong, lives: h.lives })),
    });
  },

  /* ---------- Kaç Kaç? ---------- */

  setupKac(r, now) {
    const scores = {};
    for (const id of r.roster) scores[id] = 0;
    const turns = [];
    for (let k = 0; k < r.cfg.perPlayer; k++) turns.push(...shuffle(r.roster));
    Object.assign(r, { turns, ti: 0, step: 'ask', ask: null, guesses: {}, results: [], scores });
    this.kacBeginTurn(now);
  },

  kacLive(id) {
    return !!(this.S.players[id] && this.S.players[id].connected);
  },

  // Start the asking step for the current turn. Someone who dropped keeps their turn; the leader can skip it.
  kacBeginTurn(now = Date.now()) {
    const S = this.S;
    const r = S.round;
    if (r.ti >= r.turns.length) {
      r.final = computeKacFinal(r);
      S.phase = 'final';
      r.deadline = null;
      this.changed();
      return;
    }
    r.step = 'ask';
    r.ask = null;
    r.guesses = {};
    r.deadline = now + r.cfg.askTime * 1000;
    r.deadlineTotal = r.cfg.askTime * 1000;
    this.changed();
  },

  kacAllGuessed() {
    const r = this.S.round;
    const asker = r.turns[r.ti];
    const live = r.roster.filter((id) => id !== asker && this.kacLive(id));
    return live.length > 0 && live.every((id) => r.guesses[id] !== undefined);
  },

  kacStartGuess() {
    const r = this.S.round;
    r.step = 'guess';
    r.deadline = Date.now() + r.cfg.guessTime * 1000;
    r.deadlineTotal = r.cfg.guessTime * 1000;
    this.changed();
  },

  kacReveal() {
    const r = this.S.round;
    const asker = r.turns[r.ti];
    const answer = r.ask.v;
    const guesses = Object.entries(r.guesses)
      .map(([id, v]) => ({ id, v, diff: Math.round(Math.abs(v - answer) * 10) / 10 }))
      .sort((a, b) => a.diff - b.diff);
    const exact = guesses.filter((g) => g.diff === 0).map((g) => g.id);
    const closest = exact.length || !guesses.length ? [] : guesses.filter((g) => g.diff === guesses[0].diff).map((g) => g.id);
    const delta = {};
    for (const id of exact) delta[id] = KAC_EXACT_POINTS;
    for (const id of closest) delta[id] = KAC_CLOSE_POINTS;
    for (const id of Object.keys(delta)) r.scores[id] = (r.scores[id] || 0) + delta[id];
    r.results.push({ asker, q: r.ask.q, v: answer, guesses, exact, closest, delta, scores: { ...r.scores } });
    r.step = 'reveal';
    r.deadline = r.cfg.revealMode === 'auto' ? Date.now() + KAC_REVEAL_MS : null;
    r.deadlineTotal = KAC_REVEAL_MS;
    this.changed();
  },

  kacNext() {
    this.S.round.ti++;
    this.kacBeginTurn();
  },

  kacSkip() {
    const r = this.S.round;
    if (r.step === 'ask') this.kacNext();            // asker ran out of time: next person
    else if (r.step === 'guess') this.kacReveal();
    else this.kacNext();
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
    // A player who dropped keeps their turn until they come back or the leader skips it.
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

  lieTimeout(why = 'time') {
    const r = this.S.round;
    if (r.step === 'roles') this.lieStartClues();
    else if (r.step === 'clues') {
      r.clues.push({ by: this.lieCurrent(), text: null, why });
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

  // In "Süresiz" mode only the (auto) reveal screens keep a timer; everything else waits for everyone.
  untimedNow() {
    const S = this.S;
    const r = S.round;
    return !!r && r.cfg.timeMode === 'untimed' && S.phase !== 'results' && S.phase !== 'final' && r.step !== 'reveal';
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
    if (r && r.deadline && !this.untimedNow()) {
      if (S.phase === 'writing' && now >= r.deadline + WRITE_GRACE_MS) this.endWriting();
      else if (S.phase === 'answering' && now >= r.deadline) this.endAnswering();
      else if (S.phase === 'results' && now >= r.deadline) this.nextReveal();
      else if (S.phase === 'lie' && now >= r.deadline) this.lieTimeout();
      else if (S.phase === 'kac' && now >= r.deadline) this.kacSkip();
      else if (S.phase === 'ikiz' && now >= r.deadline) this.ikizSkip();
      else if (S.phase === 'tele' && now >= r.deadline) this.teleSkip();
      else if (S.phase === 'ayna' && now >= r.deadline) this.aynaSkip();
      else if (S.phase === 'emo' && now >= r.deadline) this.emoSkip();
      else if (S.phase === 'cog' && now >= r.deadline) this.cogSkip();
      else if (S.phase === 'iky' && now >= r.deadline) this.ikySkip();
      else if (S.phase === 'sir' && now >= r.deadline) this.sirSkip();
      else if (S.phase === 'adam' && now >= r.deadline) this.adamSkip();
      else if (S.phase === 'vamp' && now >= r.deadline) this.vampSkip();
      else if (S.phase === 'zar' && now >= r.deadline) this.zarSkip();
      else if (S.phase === 'pat' && now >= r.deadline) this.patSkip();
      else if (S.phase === 'tak' && now >= r.deadline) this.takSkip();
      else if (S.phase === 'quiz' && now >= r.deadline) this.quizSkip();
      else if (S.phase === 'cin' && now >= r.deadline) this.cinSkip();
      else if (S.phase === 'kafe' && now >= r.deadline) this.kafeSkip();
    }
    if (S.phase === 'ikiz' && r) this.ikizCheck();
    if (S.phase === 'tele' && r) this.teleCheck();
    if (S.phase === 'ayna' && r) this.aynaCheck();
    if (S.phase === 'emo' && r) this.emoCheck();
    if (S.phase === 'cog' && r) this.cogCheck();
    if (S.phase === 'iky' && r) this.ikyCheck();
    if (S.phase === 'sir' && r) this.sirCheck();
    if (S.phase === 'vamp' && r) this.vampCheck();
    if (S.phase === 'tak' && r) this.takCheck();
    if (S.phase === 'quiz' && r) this.quizCheck();
    if (S.phase === 'cin' && r) this.cinCheck();
    if (S.phase === 'kafe' && r) this.kafeCheck();
    // The bomb ignores "Süresiz": it is the whole game.
    if (S.phase === 'pat' && r && r.step === 'play' && now >= r.boomAt) this.patBoom();
    if (S.phase === 'kac' && r) {
      if (r.step === 'guess' && this.kacAllGuessed()) this.kacReveal();
    }
    if (S.phase === 'lie' && r) {
      if (r.step === 'vote' && this.lieAllVoted()) this.lieFinish();
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
    // First time a round reaches its final screen: decide who earned which badges.
    const S = this.S;
    if (S.phase === 'final' && S.round && !S.round.awards) S.round.awards = computeAwards(S.round);
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
      chat: S.chat || [],
      spin: S.spin || null,
      gameVote: S.gameVote ? {
        counts: Object.values(S.gameVote.votes).reduce((c, g) => { c[g] = (c[g] || 0) + 1; return c; }, {}),
        mine: S.gameVote.votes[pid] || null,
        voted: Object.keys(S.gameVote.votes).length,
      } : null,
      players: S.order.map((id) => {
        const p = S.players[id];
        return { id, name: p.name, av: p.av, col: p.col, pic: p.pic || null, connected: p.connected, ready: p.ready, inRound: !!(r && r.roster.includes(id)), badges: p.badges || null };
      }),
      left: r && r.deadline && !this.untimedNow() ? Math.max(0, r.deadline - now) : null,
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
    } else if (S.phase === 'ikiz') {
      const last = r.history[r.history.length - 1];
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'guess' ? !!r.twinGuess[id] : r.answers[id] != null;
      pub.stepKey = r.step + r.ri;
      pub.ikiz = {
        step: r.step,
        ri: r.ri,
        rn: r.prompts.length,
        prompt: r.step === 'guess' ? null : r.prompts[r.ri],
        done,
        myAnswer: r.answers[pid] ?? null,
        myGuess: r.twinGuess[pid] || null,
        twins: (r.partners[pid] || []).length,
        myScore: r.scores[pid] || 0,
        // Answers are public; whether *you* matched your twin is told only to you.
        history: r.history.map((h) => ({ prompt: h.prompt, answers: h.answers, me: !!h.matched[pid] })),
        reveal: r.step === 'reveal' ? { answers: last.answers, me: !!last.matched[pid] } : null,
      };
    } else if (S.phase === 'tele') {
      const pair = r.pairs[r.ri] || [];
      const done = {};
      for (const id of r.roster) done[id] = pair.includes(id) ? r.words[id] != null : !!r.bets[id];
      pub.stepKey = r.step + r.ri;
      pub.tele = {
        step: r.step,
        ri: r.ri,
        rn: r.pairs.length,
        pair,
        prompt: r.prompts[r.ri],
        amPair: pair.includes(pid),
        myWord: r.words[pid] ?? null,
        myBet: r.bets[pid] || null,
        done,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'ayna') {
      const mirror = r.turns[r.ti];
      const done = {};
      for (const id of r.roster) done[id] = id === mirror ? r.own != null : r.guesses[id] != null;
      pub.stepKey = r.step + r.ti;
      pub.ayna = {
        step: r.step,
        ti: r.ti,
        tn: r.turns.length,
        mirror,
        q: r.qs[r.ti],
        amMirror: pid === mirror,
        myText: pid === mirror ? r.own : (r.guesses[pid] ?? null),
        done,
        judge: r.step === 'judge' && pid === mirror ? { own: r.own, guesses: r.guesses, pre: r.accepted } : null,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'emo') {
      const narr = r.turns[r.ti];
      const showItem = r.step === 'reveal' || (pid === narr);
      pub.stepKey = r.step + r.ti;
      pub.emo = {
        step: r.step, ti: r.ti, tn: r.turns.length, narr, amNarr: pid === narr,
        cat: r.item ? r.item.cat : '', title: showItem && r.item ? r.item.t : null,
        rerollsLeft: EMO_REROLLS - (r.rerolls || 0), clue: r.clue,
        correct: r.correct || [], feed: r.feed || [], iGot: (r.correct || []).includes(pid),
        hint: r.step === 'guess' && r.hintIdx && r.hintIdx.length
          ? [...r.item.t].map((c, i) => (c === ' ' ? ' ' : !/[\p{L}\p{N}]/u.test(c) || r.hintIdx.includes(i) ? c : '')) : null,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'cog') {
      const done = {};
      for (const id of r.roster) done[id] = !!r.ans[id];
      pub.stepKey = r.step + r.qi;
      pub.cog = {
        step: r.step, qi: r.qi, qn: r.qs.length, q: r.qs[r.qi], n: r.roster.length, done, mine: r.ans[pid] || null,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'iky') {
      const author = r.turns[r.ti];
      const done = {};
      for (const id of r.roster) if (id !== author) done[id] = r.picks[id] != null;
      pub.stepKey = r.step + r.ti;
      pub.iky = {
        step: r.step, done, ti: r.ti, tn: r.turns.length, author, amAuthor: pid === author,
        list: r.step === 'guess' ? r.order[author].map((i) => r.stmts[author].list[i]) : null,
        myPick: r.picks[pid] ?? null,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'sir') {
      const asker = r.turns[r.ti];
      const done = {};
      for (const id of r.roster) done[id] = !!(r.ranks && r.ranks[id]);
      pub.stepKey = r.step + r.ti;
      pub.sir = {
        step: r.step, ti: r.ti, tn: r.turns.length, asker, amAsker: pid === asker, q: r.q, done,
        rankIds: r.step === 'rank' ? r.rankIds : null, myRank: (r.ranks && r.ranks[pid]) || null,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'kafe') {
      // Plans stay secret until the day is over; everyone sees the cafés' money and stats.
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'plan' ? !!r.plans[id] : true;
      const pubCafes = {};
      for (const id of r.roster) {
        const c = r.cafes[id];
        pubCafes[id] = { name: c.name, e: c.e, money: c.money, stars: Math.max(1, Math.min(5, Math.round(c.rep * 3.2))), amb: c.amb, barista: c.barista, price: c.price };
      }
      pub.stepKey = r.step + r.day;
      pub.kafe = {
        step: r.step, day: r.day, days: r.days, ev: this.kafeEvent(), done, cafes: pubCafes,
        myPlan: r.plans[pid] || null, sabLeft: r.cafes[pid] ? r.cafes[pid].sabLeft : 0,
        result: r.step === 'result' ? r.result : null,
      };
    } else if (S.phase === 'cin') {
      // Roles, true whereabouts and the solution never leave the host; each player sees only their own.
      const mine = r.roster.includes(pid);
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'intro' ? r.declared[id] != null : r.step === 'round' ? !!r.ready[id] : !!r.votes[id];
      const killer = mine && pid === r.killer;
      pub.stepKey = r.step + r.round;
      pub.cin = {
        step: r.step, round: r.round, rounds: CIN_ROUNDS, victim: r.victim, place: r.place, done,
        chars: r.chars, traits: r.traits, declared: r.step === 'intro' ? Object.fromEntries(Object.entries(r.declared).map(([k, v]) => [k, k === pid ? v : -2])) : r.declared,
        events: r.events, myClues: mine ? r.clues[pid] : [], ready: r.ready[pid] || false,
        me: mine ? { killer, truth: killer ? null : r.truth[pid], with: killer ? [] : r.roster.filter((x) => x !== pid && x !== r.killer && r.truth[x] === r.truth[pid]),
          crime: killer ? { room: r.room, weapon: r.weapon } : null, canFrame: killer && !r.frameUsed } : null,
        myVote: r.votes[pid] || null,
      };
    } else if (S.phase === 'quiz') {
      const q = r.qs[r.qi];
      const nextQ = r.qs[r.qi + 1];
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'q' ? !!r.ans[id] : true;
      pub.stepKey = r.step + r.qi;
      pub.quiz = {
        step: r.step, qi: r.qi, qn: r.qs.length, done,
        q: { type: q.type, cat: q.cat, text: q.text, img: q.img || null, opts: q.opts || null, tr: !!q.tr },
        myAns: r.ans[pid] || null,
        result: r.step === 'reveal' ? r.result : null,
        nextImg: r.step === 'reveal' && nextQ ? nextQ.img || null : null,
      };
    } else if (S.phase === 'tak') {
      // Scores stay hidden until the masks come off: other people's points would give the imitators away.
      const mine = r.roster.includes(pid);
      const last = r.history[r.history.length - 1];
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'write' ? !!r.answers[id] : r.step === 'vote' ? this.takVotedAll(id) : r.step === 'guess' ? !!r.guesses[id] : true;
      pub.stepKey = r.step + r.ri;
      pub.tak = {
        step: r.step, ri: r.ri, rn: r.qs.length, q: r.qs[Math.min(r.ri, r.qs.length - 1)], done,
        myTarget: mine ? r.target[pid] : null, myScore: mine ? r.scores[pid] : 0,
        mine: r.step === 'write' ? r.answers[pid] || null : null,
        cards: r.step === 'vote' ? r.cards.map((c) => ({ subject: c.subject, opts: c.opts })) : null,
        myVotes: r.step === 'vote' ? r.votes[pid] || {} : null,
        result: r.step === 'reveal' && last ? { q: last.q, cards: last.cards } : null,
        myDelta: r.step === 'reveal' && last ? last.delta[pid] || 0 : 0,
        // Clues for the final guess: everything that was written pretending to be me.
        aboutMe: r.step === 'guess' && mine ? r.history.map((h) => {
          const c = h.cards.find((x) => x.subject === pid);
          return c ? { q: h.q, text: c.opts[1 - c.realIdx], fooled: c.fooled } : null;
        }).filter(Boolean) : null,
        myGuess: r.step === 'guess' ? r.guesses[pid] || null : null,
        unmask: r.step === 'unmask' ? r.unmask : null,
      };
    } else if (S.phase === 'zar') {
      const reveal = r.step === 'reveal';
      pub.stepKey = r.step + r.round;
      pub.zar = {
        step: r.step, round: r.round, seats: r.seats, counts: r.counts, total: this.zarTotal(), jokers: !!r.cfg.jokers,
        turn: this.zarTurn(), myTurn: this.zarTurn() === pid, myDice: r.dice[pid] || [], bid: r.bid, bids: r.bids,
        result: reveal ? r.result : null, pendingEnd: reveal && r.pendingEnd,
      };
    } else if (S.phase === 'pat') {
      const others = r.seats.filter((id) => r.alive[id] && (!r.last || id !== r.last.id)).length;
      pub.stepKey = r.step + r.round;
      pub.pat = {
        step: r.step, round: r.round, seats: r.seats, alive: r.alive, hearts: r.hearts, maxH: r.maxH, prompt: r.prompt.text, letter: r.prompt.letter,
        holder: r.holder, amHolder: r.step === 'play' && r.holder === pid, feed: r.feed,
        last: r.last ? { id: r.last.id, text: r.last.text, downs: Object.keys(r.last.downs).length, mine: !!r.last.downs[pid] } : null,
        need: Math.max(1, Math.ceil(others / 2)), result: r.step === 'reveal' ? r.result : null, pendingEnd: r.step === 'reveal' && r.pendingEnd,
      };
    } else if (S.phase === 'vamp') {
      // Everyone only ever gets their own role, hearts and night results; vampires also see each other.
      const mine = r.roster.includes(pid);
      const fang = mine && VAMP_ROLES[r.roles[pid]].team === 'vamp';
      const mates = fang ? r.roster.filter((id) => VAMP_ROLES[r.roles[id]].team === 'vamp') : [];
      const done = {};
      for (const id of r.roster) if (r.alive[id]) done[id] = r.step === 'roles' ? !!r.ready[id] : r.step === 'night' ? !!r.acts[id] : r.step === 'day' ? !!r.votes[id] : true;
      const mateActs = {};
      if (fang && r.step === 'night') for (const id of mates) if (r.acts[id]) mateActs[id] = r.acts[id];
      pub.stepKey = r.step + r.night;
      pub.vamp = {
        step: r.step, night: r.night, nights: r.nights, alive: r.alive, roleList: r.roleList, shown: r.shown, done,
        me: mine ? { role: r.roles[pid], hearts: r.hearts[pid], maxH: r.maxH[pid], alive: !!r.alive[pid], used: r.used[pid], lastHeal: r.lastHeal[pid] || null } : null,
        mates: fang ? mates.map((id) => ({ id, role: r.roles[id] })) : null,
        mateActs, vchat: fang ? r.vchat : null,
        myAct: r.step === 'night' ? r.acts[pid] || null : null,
        report: r.report, myLog: mine ? r.log[pid] : [],
        votes: r.step === 'day' ? r.votes : null,
        result: r.step === 'reveal' ? r.result : null, pendingEnd: r.step === 'reveal' ? r.pendingEnd : null,
      };
    } else if (S.phase === 'adam') {
      // Guessers only ever get the masked word; the owner and the reveal get the real one.
      const turn = r.step === 'play' ? this.adamTurn() : null;
      const amSetter = !!r.setter && pid === r.setter;
      pub.stepKey = r.step + r.ti;
      pub.adam = {
        step: r.step, ti: r.ti, tn: r.turns.length, setter: r.setter, amSetter, hint: r.hint,
        word: r.step === 'reveal' || amSetter ? r.word : null,
        mask: r.word ? [...r.word].map((c) => (c === ' ' ? ' ' : r.used[c] ? c : '')) : null,
        used: r.used, wrong: r.wrong, lives: r.lives, turn, myTurn: turn === pid, guessers: r.guessers,
        last: r.last, rd: r.rd,
        result: r.step === 'reveal' ? r.history[r.history.length - 1] : null,
      };
    } else if (S.phase === 'kac') {
      // The asker's real number stays on the host until the reveal.
      const asker = r.turns[r.ti];
      const guessed = {};
      for (const id of r.roster) if (id !== asker) guessed[id] = r.guesses[id] !== undefined;
      pub.kac = {
        step: r.step,
        ti: r.ti,
        tn: r.turns.length,
        asker,
        q: r.ask ? r.ask.q : null,
        guessed,
        myGuess: r.guesses[pid] ?? null,
        myAnswer: pid === asker && r.ask ? r.ask.v : null,
        result: r.step === 'reveal' ? r.results[r.results.length - 1] : null,
      };
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
      pub.awards = r.awards || {};
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
  const common = COMMON_DEFS.filter((d) => !hidden.includes(d.key));
  return common.filter((d) => d.top).concat(GAMES[game].defs, common.filter((d) => !d.top));
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

/* ---------- Kaç Kaç? ---------- */

/* ---------- badges ---------- */

function sanitizeBadges(b) {
  const out = {};
  if (b && typeof b === 'object') {
    for (const [k, v] of Object.entries(b)) if (BADGES[k] && Number.isFinite(+v) && +v > 0) out[k] = Math.min(9999, Math.round(+v));
  }
  return out;
}

// Who earned what in a finished round: { playerId: [badgeId, …] }.
function computeAwards(r) {
  const F = r.final || {};
  const out = {};
  const give = (ids, b) => {
    for (const id of ids || []) {
      if (!r.roster.includes(id)) continue;
      out[id] = out[id] || [];
      if (!out[id].includes(b)) out[id].push(b);
    }
  };
  const top = (obj) => {
    const max = Math.max(0, ...Object.values(obj || {}));
    return max > 0 ? Object.keys(obj).filter((k) => obj[k] === max) : [];
  };
  const positive = (obj) => Object.keys(obj || {}).filter((k) => obj[k] > 0);
  switch (r.game) {
    case 'hangimiz': {
      const titles = {};
      for (const id of r.roster) titles[id] = ((F.titles || {})[id] || []).length;
      give(top(titles), 'hz_king');
      give(top(F.votes), 'hz_star');
      break;
    }
    case 'kimyazdi':
      give(top(F.scores), 'ky_champ');
      give(F.detective && F.detective.ids, 'ky_detective');
      give(F.hider && F.hider.ids, 'ky_mystery');
      break;
    case 'asla':
      if (!F.anon) { give(top(F.done), 'as_adventurer'); give(F.innocent, 'as_angel'); }
      break;
    case 'komik':
      give(top(F.scores), 'km_comedian');
      if (F.best) give([F.best.author], 'km_star');
      break;
    case 'yalanci':
      if (!F.caught) give([F.liar], 'ly_master');
      else if (F.guessedRight) give([F.liar], 'ly_fox');
      give(Object.keys(F.votes || {}).filter((v) => F.votes[v] === F.liar), 'ly_hunter');
      break;
    case 'kackac':
      give(top(F.scores), 'kc_sniper');
      give(positive(F.exact), 'kc_bullseye');
      break;
    case 'ikiz': {
      give(positive(F.right), 'ik_finder');
      const together = (g) => (F.history || []).filter((h) => g.some((a) => g.some((b) => a < b && h.answers[a] != null &&
        h.answers[b] != null && normWord(h.answers[a]) === normWord(h.answers[b])))).length;
      const scored = (F.groups || []).map((g) => ({ g, n: together(g) }));
      const best = Math.max(0, ...scored.map((x) => x.n));
      if (best > 0) for (const x of scored) if (x.n === best) give(x.g, 'ik_twins');
      break;
    }
    case 'tele':
      give(top(F.scores), 'tl_telepath');
      give(positive(F.hits), 'tl_mindreader');
      break;
    case 'ayna':
      give(top(F.right), 'ay_knower');
      give(top(F.known), 'ay_openbook');
      break;
    case 'emoji':
      give(top(F.narrated), 'em_artist');
      give(top(F.firsts), 'em_flash');
      break;
    case 'cogunluk':
      give(top(F.scores), 'cg_pollster');
      break;
    case 'ikidogru':
      give(top(F.fooled), 'iy_poker');
      give(top(F.found), 'iy_detector');
      break;
    case 'sirala':
      give(top(F.scores), 'sr_ruler');
      break;
    case 'adam':
      give(top(F.solved), 'ad_hunter');
      give(top(F.hanged), 'ad_hangman');
      break;
    case 'kafe':
      give(F.ranking.slice(0, 1), 'kf_mogul');
      give(top(F.customers), 'kf_fav');
      break;
    case 'cinayet':
      give(F.sherlocks, 'cn_sherlock');
      if (!F.caught) give([F.killer], 'cn_perfect');
      break;
    case 'quiz':
      give(F.ranking.slice(0, 1).filter((id) => F.scores[id] > 0), 'qz_brain');
      give(top(F.mapPts), 'qz_compass');
      break;
    case 'taklit':
      give(top(F.fooled), 'tk_master');
      give(top(F.found), 'tk_knower');
      break;
    case 'zar':
      give(F.ranking.slice(0, 1), 'zr_king');
      give(top(F.caught), 'zr_hunter');
      break;
    case 'patates':
      give(F.ranking.slice(0, 1), 'pt_cool');
      break;
    case 'vampir': {
      const team = (id) => VAMP_ROLES[F.roles[id]].team;
      if (F.winTeam === 'vamp') give(F.winners.filter((id) => team(id) === 'vamp'), 'vm_night');
      if (F.winTeam === 'koy') give(F.winners.filter((id) => team(id) === 'koy'), 'vm_hero');
      if (F.winTeam === 'soytari') give(F.winners.filter((id) => F.roles[id] === 'soytari'), 'vm_jester');
      give(F.winners.filter((id) => F.roles[id] === 'gezgin'), 'vm_survivor');
      break;
    }
  }
  return out;
}

/* ---------- chat guard ---------- */

// Why a chat message must not be sent right now, or null if it's fine.
const SHADOW = 'shadow';

function chatBlockReason(S, pid, text) {
  const r = S.round;
  if (!r || S.phase === 'lobby' || S.phase === 'final') return null;
  const t = normWord(text);
  const has = (secret) => {
    if (secret == null) return false;
    const k = normWord(secret);
    return k.length >= 2 && t.includes(k);
  };
  // Short titles ("It", "Av", "Söz") only count as whole words, or "tavuk" would leak "Av".
  const words = String(text).split(/[^\p{L}\p{N}]+/u).map(normWord).filter(Boolean);
  const hasTitle = (secret) => {
    const k = normWord(secret);
    if (k.length >= 5) return has(secret);
    for (let i = 0; i < words.length; i++) {
      let joined = '';
      for (let j = i; j < Math.min(words.length, i + 3); j++) { joined += words[j]; if (joined === k) return true; }
    }
    return false;
  };
  const SECRET = SHADOW;
  switch (S.phase) {
    case 'lie':
      return has(r.word) || has(r.liarWord) ? SHADOW : null;
    case 'tele':
      return r.step === 'play' && r.pairs[r.ri].includes(pid) ? '🤐 Telepati sırasında sohbet yok, kendi aklınla bul!' : null;
    case 'ikiz':
      return r.step === 'answer' && has(r.answers[pid]) ? SECRET : null;
    case 'ayna':
      return pid === r.turns[r.ti] && r.step !== 'reveal' && has(r.own) ? SHADOW : null;
    case 'emo':
      // Nobody may type the answer into the chat while it's still being guessed.
      return r.step !== 'reveal' && r.item && [r.item.t, ...(r.item.a || [])].some((x) => hasTitle(x)) ? SHADOW : null;
    case 'vamp':
      return r.roster.includes(pid) && !r.alive[pid] ? '👻 Ölüler konuşamaz! Oyun bitince yine yazabilirsin.' : null;
    case 'adam':
      return r.setter === pid && r.word && r.step !== 'reveal' && hasTitle(r.word) ? SHADOW : null;
    case 'kac': {
      if (pid !== r.turns[r.ti] || !r.ask || r.step === 'reveal') return null;
      const nums = (String(text).match(/\d+(?:[.,]\d+)*/g) || []).map(parseKacNumber);
      return nums.includes(r.ask.v) ? SHADOW : null;
    }
    case 'writing':
    case 'answering': {
      // Kim Yazdı? / Komik Cevap: your own (secret-author) texts can't be quoted.
      if (r.game !== 'kimyazdi' && r.game !== 'komik') return null;
      const mine = S.phase === 'writing' ? (r.drafts[pid] || []) : ownTexts(r, pid);
      const leaks = (x) => {
        if (!x) return false;
        if (has(x) || (t.length >= 8 && normWord(x).includes(t))) return true;
        // Two words in a row from your own text ("denize girmedim") also give it away.
        const w = String(x).split(/\s+/).map(normWord).filter(Boolean);
        for (let i = 0; i + 1 < w.length; i++) if ((w[i] + w[i + 1]).length >= 6 && t.includes(w[i] + w[i + 1])) return true;
        return false;
      };
      return mine.some(leaks) ? SECRET : null;
    }
  }
  return null;
}

function ownTexts(r, pid) {
  if (r.game === 'komik') return r.questions.flatMap((q) => q.answers.filter((a) => a.author === pid).map((a) => a.text));
  return r.questions.filter((q) => q.author === pid).map((q) => q.text);
}

/* ---------- word matching (Ruh İkizi / Telepati / Ayna) ---------- */

// Letters and numbers dressed up as emoji: ©®, ℹ️™, ⓐ①, 🅰️🆗, flag letters 🇸🇭, 🔟, tag letters.
const EMO_DISGUISED = /[\u00a9\u00ae\u2100-\u214f\u2460-\u24ff\u{1F100}-\u{1F1FF}\u{1F51F}\u{E0000}-\u{E007F}]/gu;
const EMO_NOT_EMOJI = /[^\p{Extended_Pictographic}\p{Emoji_Modifier}\u200d\ufe0f ]/gu;

function isEmojiOnly(t) {
  if (!t) return false;
  EMO_DISGUISED.lastIndex = EMO_NOT_EMOJI.lastIndex = 0;
  const bad = EMO_DISGUISED.test(t) || EMO_NOT_EMOJI.test(t);
  EMO_DISGUISED.lastIndex = EMO_NOT_EMOJI.lastIndex = 0;
  return !bad && /\p{Extended_Pictographic}/u.test(t);
}

// Drops everything that isn't allowed in an emoji clue (used while typing).
function emojiFilter(t) {
  return String(t).replace(EMO_NOT_EMOJI, '').replace(EMO_DISGUISED, '').replace(/ {2,}/g, ' ');
}

function emojiCount(t) {
  return graphemes(String(t)).filter((g) => g.trim()).length;
}

function graphemes(t) {
  if (typeof Intl !== 'undefined' && Intl.Segmenter) return [...new Intl.Segmenter('tr', { granularity: 'grapheme' }).segment(t)].map((x) => x.segment);
  return Array.from(t);
}

function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// Emoji guesses: case, spaces and Turkish letters don't matter, and small typos are forgiven.
// How many typos a title of this length forgives.
const emoSlack = (len) => (len >= 10 ? 2 : len >= 4 ? 1 : 0);

const emoNorm = (t) => normWord(String(t).replace(/^\s*the\s+/i, ''));

function emoDistance(guess, item) {
  const g = emoNorm(guess);
  return Math.min(...[item.t, ...(item.a || [])].map(emoNorm).map((a) => levenshtein(a, g) - emoSlack(a.length)));
}

// 'hit' = accepted, 'close' = one or two letters off (told only to the guesser so it doesn't leak), null = miss.
function emoMatch(guess, item) {
  const d = emoDistance(guess, item);
  return d <= 0 ? 'hit' : d <= 2 ? 'close' : null;
}

function cleanWord(t) {
  return String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_WORD);
}

// "Muz", "muz!" and "MUZ" count as the same answer; Turkish letters are folded so "çilek" = "cilek".
function normWord(t) {
  const s = String(t ?? '').toLocaleLowerCase('tr').replace(/ı/g, 'i').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return s.replace(/[^\p{L}\p{N}]+/gu, '') || String(t ?? '').trim();
}

// Accepts "7", "7,5", "12.000" (Turkish thousands dots). Keeps one decimal.
function parseKacNumber(raw) {
  let t = String(raw ?? '').trim().replace(/\s/g, '');
  if (!t) return null;
  if (/^\d{1,3}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, '');
  t = t.replace(',', '.');
  const v = Number(t);
  if (!Number.isFinite(v) || v < 0 || v > KAC_MAX) return null;
  return Math.round(v * 10) / 10;
}

function computeKacFinal(r) {
  const exact = {};
  const close = {};
  for (const id of r.roster) { exact[id] = 0; close[id] = 0; }
  for (const res of r.results) {
    for (const id of res.exact) exact[id]++;
    for (const id of res.closest) close[id]++;
  }
  return {
    ranking: r.roster.slice().sort((a, b) => r.scores[b] - r.scores[a] || exact[b] - exact[a]),
    scores: { ...r.scores },
    exact,
    close,
    recap: r.results.map((res) => ({ asker: res.asker, q: res.q, v: res.v, exact: res.exact, closest: res.closest })),
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
      conn.send({ t: 'hello', id: myId, name: myName, look: App.look, badges: store.get('hz-badges') || {} });
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
      case 'chatBlocked':
      case 'chatShadow':
      case 'toast':
        onPrivate(msg);
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
    App.state = null;
    closeChat();
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

/* ---------- theme ---------- */

function isDark() {
  const t = document.documentElement.dataset.theme;
  return t ? t === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function themePill() {
  return '<button class="pill" data-act="theme" title="Tema">' + (isDark() ? '☀️' : '🌙') + '</button>';
}

function applyTheme(t) {
  if (t) document.documentElement.dataset.theme = t;
  const meta = document.querySelector('meta[name=theme-color]');
  if (meta) meta.content = isDark() ? '#1c1145' : '#5b2be0';
}

function prefsHTML() {
  const sw = (k, on, icon, title, sub) => '<div class="prefrow"><div><b>' + icon + ' ' + esc(title) + '</b>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</div>' +
    '<button class="sw ' + (on ? 'on' : '') + '" data-act="prefToggle" data-k="' + k + '" aria-pressed="' + on + '"></button></div>';
  const t = document.documentElement.dataset.theme || 'auto';
  const th = (v, label) => '<button class="btn small ' + (t === v ? 'yellow' : 'ghost') + '" data-act="prefTheme" data-v="' + v + '">' + label + '</button>';
  return '<div class="chathead"><b>⚙️ Ayarlar</b><button class="pill dark" data-act="closePrefs">✕</button></div>' +
    '<p class="muted" style="margin:0 0 6px;font-size:14px">Bu ayarlar sadece senin cihazında geçerli.</p>' +
    sw('sound', !Sound.muted, '🔊', 'Ses efektleri', 'Bütün sesleri açar ya da kapatır') +
    sw('bombTick', Prefs.get('bombTick'), '💣', 'Bomba tık tık sesi', 'Sıcak Patates\'te bomba sendeyken') +
    sw('countTick', Prefs.get('countTick'), '⏱️', 'Son saniyeler tık sesi', 'Süre bitmek üzereyken') +
    sw('vibrate', Prefs.get('vibrate'), '📳', 'Titreşim', 'Bomba sana gelince (destekleyen telefonlarda)') +
    '<div class="prefrow"><div><b>🎨 Tema</b></div><div class="prefseg">' + th('auto', '📱 Otomatik') + th('light', '☀️ Açık') + th('dark', '🌙 Karanlık') + '</div></div>';
}

function header(extra = '') {
  const chat = App.state ? '<button class="pill" data-act="chat" title="Sohbet">💬<span class="badge" id="chatBadge" hidden></span></button>' : '';
  return '<div class="top"><div class="logo">Hangimiz<span>?</span></div><div class="row">' + extra + chat +
    themePill() + '<button class="pill" data-act="mute" title="Ses">' + (Sound.muted ? '🔇' : '🔊') + '</button>' +
    '<button class="pill" data-act="settings" title="Ayarlar">⚙️</button></div></div>';
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
    '<div class="toprow">' + themePill() + '<button class="pill" data-act="settings" title="Ayarlar">⚙️</button></div>' +
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div>' +
    '<p>Arkadaşlarınla telefondan oynanan parti oyunları.<br>Oda kur, linki at, gerisi kendiliğinden!</p>' +
    '<div class="bubbles"><span>En iyi yalanı kim söyler? 🤥</span><span>En yakışıklımız? 😎</span><span>Hep kim geç kalır? ⏰</span></div></div>' +
    '<div class="card">' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Tekin" value="' + esc(myName) + '">' +
      '<div id="gBox">' + googleBoxHTML() + '</div>' +
      '<div id="lookBox">' + lookBoxHTML() + '</div>' +
      '<div style="height:12px"></div>' +
      '<button class="btn yellow big block" data-act="create">🎉 Oda Kur</button>' +
      '<div class="or">ya da arkadaşının odasına gir</div>' +
      '<div class="row"><input id="cd" class="field code grow" maxlength="' + CODE_LEN + '" placeholder="KOD" autocomplete="off" autocapitalize="characters">' +
      '<button class="btn" data-act="joinCode">Katıl</button></div>' +
      '<p class="err" id="err">' + esc(err) + '</p>' +
    '</div>' +
    (Object.keys(store.get('hz-badges') || {}).length
      ? '<div class="ctrl" style="margin-bottom:16px"><button class="btn ghost" data-act="myBadges">🏷️ Rozet koleksiyonum (' +
        Object.values(store.get('hz-badges')).reduce((a, b) => a + b, 0) + ')</button></div>' : '') +
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
  googleMount();
  $('#cd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('joinCode'); });
  if (!myName) setTimeout(() => $('#nm') && $('#nm').focus(), 50);
}

/* ---------- character picker ---------- */

function lookPickerHTML() {
  const g = store.get('hz-google');
  const photo = g && validPic(g.pic) ? '<button class="avopt ' + (App.look.pic ? 'on' : '') + '" data-act="pickpic" title="Google fotoğrafım">' +
    avatarHTML({ pic: g.pic, col: App.look.col }) + '</button>' : '';
  return '<div class="lookpick"><div class="lbl">Karakterin</div><div class="avgrid">' + photo +
    AVATARS.map((a) => '<button class="avopt ' + (a === App.look.av && !App.look.pic ? 'on' : '') + '" style="--c:' + App.look.col + '" data-act="pickav" data-v="' + a + '">' + a + '</button>').join('') +
    '</div><div class="lbl">Rengin</div><div class="colgrid">' +
    COLORS.map((c) => '<button class="colopt ' + (c === App.look.col ? 'on' : '') + '" style="--c:' + c + '" data-act="pickcol" data-v="' + c + '" aria-label="renk"></button>').join('') +
    '</div></div>';
}

// "Sign in with Google": fills in the name and offers the profile photo as the avatar.
function loadGIS() {
  if (window.google && google.accounts) return Promise.resolve();
  if (!App.gisP) {
    App.gisP = new Promise((ok, fail) => {
      const js = document.createElement('script');
      js.src = 'https://accounts.google.com/gsi/client';
      js.async = true;
      js.onload = ok;
      js.onerror = () => { App.gisP = null; fail(); };
      document.head.appendChild(js);
    });
  }
  return App.gisP;
}

function googleCredential(resp) {
  try {
    const part = resp.credential.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
    const info = JSON.parse(new TextDecoder().decode(bytes));
    const name = cleanName(info.given_name || info.name || '');
    // Only the name and photo are kept; the e-mail is never stored or sent.
    store.set('hz-google', { name, full: cleanName(info.name || ''), pic: validPic(info.picture) ? info.picture : null });
    const nm = $('#nm');
    if (nm && name) { nm.value = name; nm.dispatchEvent(new Event('input', { bubbles: true })); }
    if (validPic(info.picture)) setLook({ pic: info.picture });
    toast('✅ Google ile giriş yapıldı: ' + (info.name || name), 2600);
    googleMount();
  } catch {
    toast('Google girişi okunamadı 😕');
  }
}

function googleBoxHTML() {
  if (!GOOGLE_CLIENT_ID) return '';
  const g = store.get('hz-google');
  if (g) {
    return '<div class="gbox in">' + avatarHTML({ pic: g.pic, av: App.look.av, col: App.look.col }, 'sm') +
      '<span class="grow">Google ile girildi: <b>' + esc(g.full || g.name) + '</b></span><button class="linkbtn" data-act="gOut">Çıkış</button></div>';
  }
  return '<div class="gbox"><div class="or" style="margin:4px 0 8px">ya da</div><div id="gBtn" class="gbtn"></div></div>';
}

function googleMount() {
  const box = $('#gBox');
  if (!box) return;
  box.innerHTML = googleBoxHTML();
  const lb = $('#lookBox');
  if (lb) lb.innerHTML = lookBoxHTML();
  if (!GOOGLE_CLIENT_ID || store.get('hz-google')) return;
  loadGIS().then(() => {
    const el = $('#gBtn');
    if (!el) return;
    google.accounts.id.initialize({ client_id: GOOGLE_CLIENT_ID, callback: googleCredential, auto_select: false, cancel_on_tap_outside: true });
    const w = Math.max(220, Math.min(400, Math.round(el.clientWidth || 300)));
    google.accounts.id.renderButton(el, { theme: isDark() ? 'filled_black' : 'outline', size: 'large', shape: 'pill', text: 'signin_with', logo_alignment: 'center', locale: 'tr', width: w });
  }).catch(() => { const el = $('#gBtn'); if (el) el.innerHTML = '<p class="muted center" style="margin:0;font-size:13px">Google girişi şu an yüklenemedi.</p>'; });
}

function lookBoxHTML() {
  return '<div class="lookrow">' + avatarHTML(App.look, 'lg') +
    '<div class="grow"><b>Karakterin</b><div class="muted" style="font-size:14px">' + (App.look.pic ? 'Google fotoğrafın' : 'Hayvanını ve rengini seç') + '</div></div>' +
    '<button class="btn small ghost" data-act="toggleLook">' + (App.lookOpen ? 'Tamam ✓' : '🎨 Değiştir') + '</button></div>' +
    (App.lookOpen ? lookPickerHTML() : '');
}

function setLook(change) {
  App.look = { ...App.look, ...change };
  store.set('hz-look', App.look);
  Sound.click();
  const box = $('#lookBox');
  if (box) box.innerHTML = lookBoxHTML();
  // Already in a room: tell the host straight away.
  if (App.state && App.state.phase === 'lobby') send({ t: 'look', look: App.look });
}

function showJoin(code, canRestore, err = '') {
  App.screenKey = 'join';
  App.code = code;
  mount(
    '<div class="toprow">' + themePill() + '<button class="pill" data-act="settings" title="Ayarlar">⚙️</button></div>' +
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div><p>Seni bir odaya çağırdılar! 🎈</p></div>' +
    '<div class="card">' +
      '<div class="center muted" style="font-weight:700">Oda kodu</div>' +
      '<div class="center" style="font-size:44px;font-weight:800;letter-spacing:8px;color:var(--purple);line-height:1.1">' + esc(code) + '</div>' +
      '<div style="height:12px"></div>' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Tekinsv" value="' + esc(myName) + '">' +
      '<div id="gBox">' + googleBoxHTML() + '</div>' +
      '<div id="lookBox">' + lookBoxHTML() + '</div>' +
      '<div style="height:12px"></div>' +
      '<button class="btn yellow big block" data-act="join">Odaya Gir 🚪</button>' +
      '<p class="err" id="err">' + esc(err) + '</p>' +
      (canRestore ? '<div class="or">bu odayı sen kurmuştun</div><button class="btn ghost block" data-act="restore">👑 Odayı geri aç (lider olarak)</button>' : '') +
    '</div>' +
    '<p class="foot"><a href="' + esc(location.pathname) + '" style="color:#fff">Kendi odanı kurmak için tıkla</a></p>'
  );
  $('#nm').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('join'); });
  googleMount();
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

  const dKey = s.phase + ':' + (s.roundId || '') + ':' + (s.reveal ? s.reveal.index : '') + ':' + (s.lie ? s.lie.step + s.lie.turn : '') + ':' + (s.kac ? s.kac.step + s.kac.ti : '') + ':' + (s.stepKey || '');
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
  updateChat(s);
  collectBadges(s);
  // A new random pick / vote result: play the reveal (but not for history we just joined into).
  const seq = s.spin ? s.spin.seq : 0;
  if (App.spinSeen != null && seq > App.spinSeen) playSpin(s.spin);
  App.spinSeen = seq;
}

// Add this round's badges to my collection once, and tell the room.
function collectBadges(s) {
  if (s.phase !== 'final' || !s.awards || !s.roundId) return;
  const seen = store.get('hz-badge-rounds') || [];
  if (seen.includes(s.roundId)) return;
  store.set('hz-badge-rounds', seen.concat(s.roundId).slice(-60));
  const mine = s.awards[s.you] || [];
  if (!mine.length) return;
  const col = store.get('hz-badges') || {};
  for (const b of mine) col[b] = (col[b] || 0) + 1;
  store.set('hz-badges', col);
  send({ t: 'badges', badges: col });
  setTimeout(() => toast('🏷️ Yeni rozet: ' + mine.map((b) => BADGES[b].e + ' ' + BADGES[b].n).join(', '), 4000), 1200);
}

// Top few badge emojis for next to a name.
function badgeEmojis(b, n = 3) {
  return Object.entries(b || {}).filter(([k]) => BADGES[k]).sort((x, y) => y[1] - x[1]).slice(0, n).map(([k]) => BADGES[k].e).join('');
}

function awardsHTML() {
  const s = App.state;
  const A = (s && s.awards) || {};
  const ids = Object.keys(A).filter((id) => A[id].length);
  if (!ids.length) return '';
  return '<div class="card"><h2>🏷️ Kazanılan rozetler</h2><div class="awards">' + ids.map((id) => '<div class="award">' + avatarHTML(nameOf(id), 'sm') +
    '<div class="body"><b>' + esc(nameOf(id).name) + '</b><div class="tchips">' + A[id].map((b) => '<span class="bchip" title="' + esc(BADGES[b].d) + '">' +
    BADGES[b].e + ' ' + esc(BADGES[b].n) + '</span>').join('') + '</div></div></div>').join('') + '</div>' +
    '<div class="ctrl" style="margin-top:12px"><button class="btn small ghost" data-act="myBadges">🏷️ Rozet koleksiyonum</button></div></div>';
}

function playSpin(spin) {
  let box = $('#spinBox');
  if (!box) {
    box = document.createElement('div');
    box.id = 'spinBox';
    box.className = 'spinwrap';
    document.body.appendChild(box);
  }
  const target = GAMES[spin.result];
  const title = spin.kind === 'vote'
    ? (spin.pool.length > 1 ? '🗳️ Berabere! Kura çekiliyor…' : '🗳️ Oylama sonucu')
    : '🎰 Sıradaki oyun…';
  box.innerHTML = '<div class="spincard"><div class="spinlbl">' + esc(title) + '</div><div class="spinemoji"></div><div class="spinname"></div><div class="spinsub"></div></div>';
  box.hidden = false;
  const emojiEl = box.querySelector('.spinemoji');
  const nameEl = box.querySelector('.spinname');
  const show = (id) => { emojiEl.textContent = GAMES[id].emoji; nameEl.textContent = GAMES[id].name; };
  const pool = spin.pool.length ? spin.pool : [spin.result];
  // Slow down step by step and stop on the result.
  const steps = pool.length > 1 ? 16 + Math.floor(Math.random() * 4) : 0;
  let k = Math.floor(Math.random() * pool.length);
  let i = 0;
  const tick = () => {
    if (i >= steps) {
      show(spin.result);
      box.querySelector('.spincard').classList.add('done');
      const votes = spin.counts && spin.counts[spin.result];
      box.querySelector('.spinsub').textContent = votes ? votes + ' oy ile seçildi!' : 'Hadi başlayalım!';
      Sound.fanfare();
      clearTimeout(App.spinHide);
      App.spinHide = setTimeout(() => { box.hidden = true; }, 2200);
      return;
    }
    k = (k + 1) % pool.length;
    if (pool[k] === spin.result && i === steps - 1) k = (k + 1) % pool.length;
    show(pool[k]);
    Sound.tick();
    i++;
    setTimeout(tick, 60 + i * i * 1.1);
  };
  if (target) tick();
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
  if (['writing', 'answering', 'lie', 'kac', 'ikiz', 'tele', 'ayna', 'emo', 'cog', 'iky', 'sir', 'adam', 'vamp', 'zar', 'pat', 'tak', 'quiz', 'cin', 'kafe'].includes(s.phase) && !inRound) screen = 'spectate';
  if (screen === 'lie') screen = 'lie:' + s.lie.step;
  if (screen === 'kac') screen = 'kac:' + s.kac.step;
  if (['ikiz', 'tele', 'ayna', 'emo', 'cog', 'iky', 'sir', 'adam', 'vamp', 'zar', 'pat', 'tak', 'quiz', 'cin', 'kafe'].includes(screen)) screen += ':' + s[screen].step;
  let key = screen + ':' + (s.roundId || '');
  if (screen === 'results') key += ':' + s.reveal.index;
  if (screen === 'lie:clues') key += ':' + s.lie.turn;
  if (screen.startsWith('kac:')) key += ':' + s.kac.ti;
  if (/^(ikiz|tele|ayna|emo|cog|iky|sir|adam|vamp|zar|pat|tak|quiz|cin|kafe):/.test(screen)) key += ':' + s.stepKey;
  if (screen === 'writing' && s.writing.stage) key += ':' + s.writing.stage;

  const fresh = key !== App.screenKey;
  App.screenKey = key;
  const view = Views[screen];
  if (fresh) view.mount(s);
  if (view.update) view.update(s);
  updateChatBadge();
}

/* ---------- chat ---------- */

function chatDom() {
  if ($('#chatPanel')) return;
  const box = document.createElement('div');
  box.innerHTML =
    '<div id="chatPanel" class="chatpanel" hidden>' +
      '<div class="chathead"><b>💬 Sohbet</b><button class="pill dark" data-act="chat" aria-label="Kapat">✕</button></div>' +
      '<div class="chatlist" id="chatList"></div>' +
      '<div class="reacts">' + CHAT_REACTIONS.map((e) => '<button data-act="react" data-e="' + e + '">' + e + '</button>').join('') + '</div>' +
      '<div class="chatemo" id="chatEmo" hidden></div>' +
      '<div class="row chatrow"><button class="chatemobtn" data-act="chatEmo" title="Emoji ekle">😊</button>' +
      '<input id="chatInput" class="field grow" maxlength="' + CHAT_MAX + '" placeholder="Mesaj yaz…" autocomplete="off">' +
      '<button class="btn small" data-act="chatSend">Gönder</button></div>' +
    '</div>' +
    '<div id="chatPeek" class="chatpeek" data-act="chat" hidden></div>' +
    '<div id="reactLayer" class="reactlayer"></div>';
  document.body.append(...box.children);
}

function chatEmoPaint(i) {
  EMOJI_CATS[i].list = EMOJI_CATS[i].list || graphemes(EMOJI_CATS[i].s).filter(isEmojiOnly);
  $('#chatEmo').innerHTML = '<div class="emotabs">' + EMOJI_CATS.map((c, k) => '<button class="emotab ' + (k === i ? 'on' : '') + '" data-act="chatEmoTab" data-i="' + k + '" title="' + esc(c.n) + '">' + c.e + '</button>').join('') + '</div>' +
    '<div class="emogrid">' + EMOJI_CATS[i].list.map((e) => '<button class="emob" data-act="chatEmoPick" data-e="' + e + '">' + e + '</button>').join('') + '</div>';
}

function chatMsgHTML(m, you) {
  const who = { av: m.av, col: m.col, pic: m.pic };
  const mine = m.from === you;
  return '<div class="cmsg ' + (mine ? 'me' : '') + (m.react ? ' react' : '') + '">' + avatarHTML(who, 'sm') +
    '<div class="bub">' + (mine ? '' : '<b>' + esc(m.name) + '</b>') + esc(m.react || m.text) + '</div></div>';
}

function renderChatList(forceBottom = false) {
  const s = App.state;
  const el = $('#chatList');
  if (!s || !el) return;
  const server = s.chat || [];
  const oldest = server.length ? server[0].id : 0;
  const list = server.concat((App.chatShadows || []).filter((m) => m.id >= oldest)).sort((a, b) => a.id - b.id);
  // Stay where the reader is if they scrolled up; otherwise follow the newest message.
  const atBottom = forceBottom || el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  el.innerHTML = list.length ? list.map((m) => chatMsgHTML(m, s.you)).join('') : '<div class="chatempty">Henüz mesaj yok. İlk sen yaz! 👋</div>';
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function updateChat(s) {
  chatDom();
  const list = s.chat || [];
  const last = list.length ? list[list.length - 1].id : 0;
  // On joining, the room's earlier messages are history, not news.
  if (App.chatShown == null || last < App.chatShown) { App.chatShown = last; App.chatSeen = last; }
  for (const m of list.filter((x) => x.id > App.chatShown)) {
    if (m.react) floatReact(m.react);
    else if (!App.chatOpen && m.from !== s.you) chatPeek(m);
  }
  App.chatShown = last;
  if (App.chatOpen) { App.chatSeen = last; renderChatList(); }
  updateChatBadge();
}

function updateChatBadge() {
  const s = App.state;
  const b = $('#chatBadge');
  if (!s || !b) return;
  const n = (s.chat || []).filter((m) => m.id > (App.chatSeen || 0) && !m.react && m.from !== s.you).length;
  b.hidden = !n;
  b.textContent = n > 9 ? '9+' : n;
}

function chatPeek(m) {
  const el = $('#chatPeek');
  el.innerHTML = avatarHTML({ av: m.av, col: m.col }, 'sm') + '<span><b>' + esc(m.name) + ':</b> ' + esc(m.text) + '</span>';
  el.hidden = false;
  Sound.beep(740, 0.05, 'sine', 0.05);
  clearTimeout(App.peekTimer);
  App.peekTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

function floatReact(e) {
  const layer = $('#reactLayer');
  if (!layer) return;
  const el = document.createElement('span');
  el.textContent = e;
  el.style.left = 8 + Math.random() * 80 + '%';
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2700);
}

function closeChat() {
  App.chatOpen = false;
  document.body.classList.remove('chat-open');
  const p = $('#chatPanel');
  if (p) p.hidden = true;
}

// Messages meant only for this player (e.g. "that gives the answer away").
function onPrivate(msg) {
  if (msg.t === 'toast') { toast(msg.text, 3000); return; }
  if (msg.t === 'chatShadow') {
    // Show it to the sender like a normal message; it never reached anyone else.
    const s = App.state;
    const mine = me() || {};
    const list = (s && s.chat) || [];
    const last = list.length ? list[list.length - 1].id : 0;
    App.chatShadows = (App.chatShadows || []).concat({
      id: last + 0.001 * ((App.chatShadows || []).length + 1), from: s.you, name: mine.name, av: mine.av, col: mine.col, pic: mine.pic || null, text: msg.text,
    }).slice(-20);
    renderChatList(true);
    return;
  }
  if (msg.t !== 'chatBlocked') return;
  toast(msg.reason, 3500);
  Sound.beep(220, 0.15, 'square', 0.04);
  const el = $('#chatInput');
  if (el && !el.value) el.value = msg.text || '';
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
      const edit = p.id === s.you ? '<button class="kick edit" data-act="toggleLook" title="Karakterini değiştir">🎨</button>' : '';
      const be = badgeEmojis(p.badges);
      const badges = be ? '<span class="pbadges' + (p.id === s.you ? ' mine" data-act="myBadges' : '') + '" title="Rozetler">' + be + '</span>' : '';
      return '<div class="player ' + (p.connected ? '' : 'off') + '">' + avatarHTML(p) + '<span class="nm">' + esc(p.name) + '</span>' + badges + tags.join('') + edit + kick + '</div>';
    }).join('') + (App.lookOpen ? '<div class="card-in">' + lookPickerHTML() +
      '<button class="btn small block" data-act="toggleLook" style="margin-top:10px">Tamam ✓</button></div>' : '');

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
        '<div class="card span2"><h2>Oyun ' + (s.gameVote ? '<small>(oylama açık)</small>' : host ? '<small>(seçmek için dokun)</small>' : '<small>(lider seçer)</small>') + '</h2>' +
          gameToolsHTML(s, host, online) + gamePickerHTML(s.game, host, s.gameVote) + '</div>' +
        '<div class="card"><h2>Oyuncular <small>(' + online + ' kişi)</small></h2><div class="players">' + players + '</div></div>' +
        '<div class="card"><h2>' + esc(game.emoji + ' ' + game.name) + ' ayarları ' + (host ? '' : '<small>(lider ayarlar)</small>') + '</h2>' + settingsHTML(s.settings, host, s.game) + '</div>' +
        '<div class="startbar span2">' + startArea + '</div>' +
      '</div>';
  },
};

// Random pick / vote controls above the game list.
function gameToolsHTML(s, host, online) {
  const V = s.gameVote;
  if (V) {
    return '<div class="votebar">🗳️ <b>Sıradaki oyunu oylayın!</b> Bir karta dokun. <span class="muted">(' + V.voted + '/' + online + ' oy)</span>' +
      (host ? '<div class="gtools"><button class="btn small green" data-act="voteEnd">✅ Oylamayı bitir</button>' +
        '<button class="btn small ghost" data-act="voteCancel">İptal</button></div>' : '') + '</div>';
  }
  if (!host) return '';
  return '<div class="gtools"><button class="btn small yellow" data-act="spinGame">🎲 Rastgele seç</button>' +
    '<button class="btn small" data-act="voteGame">🗳️ Oylayalım</button></div>';
}

function gamePickerHTML(current, editable, vote) {
  const cards = GAME_ORDER.map((id) => {
    const g = GAMES[id];
    const on = id === current && !vote;
    const attrs = vote ? ' data-act="gvote" data-id="' + id + '"' : editable ? ' data-act="game" data-id="' + id + '"' : ' disabled';
    const n = vote ? vote.counts[id] || 0 : 0;
    const mine = vote && vote.mine === id;
    return '<button class="gcard ' + (on ? 'on' : '') + (mine ? ' myvote' : '') + '" style="--gc:' + (GAME_COLORS[id] || '#8b5cf6') + '"' + attrs + '><span class="ge">' + g.emoji + '</span><span class="gb"><b>' + esc(g.name) + '</b>' +
      '<small>' + esc(g.desc) + '</small><small class="gmin">En az ' + g.minPlayers + ' kişi</small></span>' +
      (on ? '<span class="gcheck">✓</span>' : '') + (n ? '<span class="gvotes">🗳️ ' + n + '</span>' : '') + '</button>';
  });
  const soon = COMING_SOON.map((x) => '<div class="gcard soon"><span class="ge">' + x[0] + '</span><span class="gb"><b>' + esc(x[1]) + '</b><small>Yakında…</small></span></div>');
  // In the lobby (a game is selected) phones get a compact two-column list.
  return '<div class="games' + (current ? ' compact' : '') + '">' + cards.concat(soon).join('') + '</div>';
}

function settingsHTML(set, editable, game) {
  return '<div class="settings">' + settingDefs(game).filter((d) => (!d.showIf || d.showIf(set)) && !(d.unit === 'sn' && set.timeMode === 'untimed')).map((d) => {
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
    writeHint: (n) => 'Herkesin oylayacağı ' + n + ' soru yaz ("En … kim?" gibi). Aklına gelmezse 🎲 bas.',
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
    if (first) autoFocus(first);
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
    $('#gtimer').innerHTML = s.settings.answerTime > 0 && s.settings.timeMode !== 'untimed' ? timerHTML('Herkesin bitirmesi için kalan süre') : '';
    stage.innerHTML = '<div class="card center"><div class="big-emoji">🎉</div><h2>' + esc(U.doneAll) + '</h2><p class="muted">Diğerleri bitirince sonuçlar başlayacak.</p></div>';
    return;
  }
  const q = s.questions[idx];
  A.current = q.id;
  const per = s.settings.timeMode === 'untimed' ? 0 : s.settings.answerTime;
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

/* ---------- shared view helpers (Ruh İkizi / Telepati / Ayna) ---------- */

function sendWord(sel, type) {
  const el = $(sel);
  const text = el ? el.value.trim() : '';
  if (!text) { toast('Bir şey yaz 🙂'); if (el) el.focus(); return; }
  Sound.click();
  send({ t: type, text });
}

function doneChips(s, done, ids = s.roster) {
  return ids.map((id) => '<span class="chip ' + (done[id] ? 'done' : '') + '">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) +
    ' <span class="cnt">' + (done[id] ? '✓' : '⏳') + '</span></span>').join('');
}

function stepDots(i, n) {
  return '<div class="dots">' + Array.from({ length: n }, (_, k) => '<i class="' + (k <= i ? 'on' : '') + '"></i>').join('') + '</div>';
}

function nameList(ids) {
  return ids.map((id) => nameOf(id).name).join(' & ');
}

function hostSkip(label) {
  return isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ ' + esc(label) + '</button></div>' : '';
}

function hostNext(s, label) {
  if (isHost()) return '<div class="ctrl"><button class="btn yellow big" data-act="next">' + esc(label) + '</button></div>';
  return s.settings.revealMode === 'auto' ? '' : '<div class="waiting-pill">Lider bir sonrakine geçecek…</div>';
}

function revealTimer(s) {
  return s.settings.revealMode === 'auto' ? timerHTML('Sonrakine geçiliyor') : '';
}

function wordInput(id, act, placeholder) {
  return '<div class="row"><input id="' + id + '" class="field grow" maxlength="' + MAX_WORD + '" placeholder="' + esc(placeholder) + '" autocomplete="off">' +
    '<button class="btn green" data-act="' + act + '">Gönder</button></div>';
}

function scoreBoard(s, scores, delta = {}) {
  return '<div class="board">' + s.roster.slice().sort((a, b) => scores[b] - scores[a]).map((id, i) => '<div class="srow"><span class="rk">' + (i + 1) + '</span>' +
    avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + '</span>' + (delta[id] ? '<span class="dl">+' + delta[id] + '</span>' : '') +
    '<b>' + scores[id] + '</b></div>').join('') + '</div>';
}

// Shown while the player whose turn it is has dropped out. We wait for them; the leader may skip.
const OFFLINE_NOTE = '<p class="offnote" id="offNote" hidden></p>';

function updateOffline(s, ids) {
  const el = $('#offNote');
  if (!el) return;
  const off = ids.filter((id) => { const p = s.players.find((x) => x.id === id); return !p || !p.connected; });
  el.hidden = !off.length;
  if (off.length) el.textContent = '🔌 ' + nameList(off) + ' bağlantıdan düştü, geri gelmesi bekleniyor…' + (isHost() ? ' İstersen ⏭ ile sırayı geçebilirsin.' : '');
}

function focusFine(sel, myTurn = false) {
  const el = $(sel);
  if (el) autoFocus(el, myTurn);
}

// Focus a game field, unless the player is busy in the chat: then just tell them it's their turn.
function autoFocus(el, myTurn = false) {
  const chatBusy = App.chatOpen || document.activeElement === $('#chatInput');
  if (chatBusy) {
    if (myTurn) toast('🎤 Sıra sende! Sohbeti kapatıp yazabilirsin.', 3500);
    return;
  }
  if (myTurn || window.matchMedia('(pointer:fine)').matches) el.focus();
}

// Group answers that count as the same word, biggest group first.
function sameGroups(answers) {
  const g = new Map();
  for (const [id, t] of Object.entries(answers)) {
    const k = normWord(t);
    if (!g.has(k)) g.set(k, { text: t, ids: [] });
    g.get(k).ids.push(id);
  }
  return [...g.values()].sort((a, b) => b.ids.length - a.ids.length);
}

function finalHeadline(F, scores, unit) {
  const lead = F.ranking[0];
  const champs = F.ranking.filter((id) => scores[id] === scores[lead]);
  if (!scores[lead]) return '<h1>Kimse puan alamadı 😅</h1><p>Bir dahaki sefere!</p>';
  if (champs.length > 1) return '<h1>🤝 Berabere!</h1><p>' + esc(nameList(champs)) + ' eşit puan topladı.</p>';
  return '<h1>' + esc(nameOf(lead).av) + ' ' + esc(nameOf(lead).name) + ' kazandı!</h1><p>' + scores[lead] + ' puanla ' + esc(unit) + '</p>';
}

/* ---------- Ruh İkizi ---------- */

Views['ikiz:answer'] = {
  mount(s) {
    const I = s.ikiz;
    const hist = I.history.length
      ? '<div class="ihist">' + I.history.map((h, k) => '<span class="' + (h.me ? 'yes' : '') + '">' + (k + 1) + '. tur ' + (h.me ? '💞' : '💔') + '</span>').join('') + '</div>'
      : '';
    mount(header() + timerHTML('Cevap süresi') + stepDots(I.ri, I.rn) +
      '<div class="card center ikizinfo"><b>💞 Gizli ruh ' + (I.twins > 1 ? 'ikizlerinle' : 'ikizinle') + ' aynı cevabı vermeye çalış!</b>' +
        '<div class="muted">' + (I.twins > 1 ? 'Senin 2 ikizin var. ' : '') + 'Kim olduğunu bilmiyorsun. Aynı cevap = +' + IKIZ_MATCH_POINTS + '</div>' + hist + '</div>' +
      '<div class="card qcard"><div class="meta">Tur ' + (I.ri + 1) + ' / ' + I.rn + '</div><div class="qtext">' + esc(I.prompt) + '</div></div>' +
      '<div class="card">' + wordInput('ikizWord', 'iword', 'Aklına ilk gelen…') + '<p class="muted" id="ikizMine" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Kim yazdı?</h2><div class="chips" id="ikizChips"></div></div>' +
      hostSkip('Cevapları aç'));
    focusFine('#ikizWord');
  },
  update(s) {
    const I = s.ikiz;
    $('#ikizMine').innerHTML = I.myAnswer != null ? '✅ Cevabın: <b>' + esc(I.myAnswer) + '</b> (değiştirebilirsin)' : '';
    $('#ikizChips').innerHTML = doneChips(s, I.done);
  },
};

Views['ikiz:reveal'] = {
  mount(s) {
    const I = s.ikiz;
    const R = I.reveal;
    const mine = R.answers[s.you];
    const groups = sameGroups(R.answers).map((g) => '<div class="wgroup ' + (g.ids.length > 1 ? 'multi' : '') + '"><div class="wtext">' + esc(g.text) + '</div><div class="chips">' +
      g.ids.map((id) => '<span class="chip">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</span>').join('') + '</div></div>').join('');
    const silent = s.roster.filter((id) => R.answers[id] == null);
    const banner = mine == null ? '🤐 Bu tur cevap vermedin'
      : R.me ? '💞 Ruh ikizin de aynısını yazmış! +' + IKIZ_MATCH_POINTS : '💔 Ruh ikizin farklı bir şey yazdı';
    const tip = mine == null ? '' : R.me ? 'Seninle aynı şeyi yazanlardan biri ikizin 😉' : 'İkizin, senden farklı yazanların arasında 🤔';
    const last = I.ri >= I.rn - 1;
    mount(header() + revealTimer(s) + stepDots(I.ri, I.rn) +
      '<div class="card qcard"><div class="meta">Tur ' + (I.ri + 1) + ' / ' + I.rn + '</div><div class="qtext">' + esc(I.prompt) + '</div></div>' +
      '<div class="card center mybanner ' + (R.me ? 'yes' : '') + '">' + banner + '<div class="small">Bunu sadece sen görüyorsun 🤫 · Puanın: ' + I.myScore + '</div></div>' +
      '<div class="card"><h2>Cevaplar</h2><div class="wgroups">' + groups + '</div>' +
        (silent.length ? '<p class="muted" style="margin:8px 0 0">Cevap vermeyen: ' + esc(nameList(silent)) + '</p>' : '') +
        (tip ? '<p class="muted" style="margin:8px 0 0">' + esc(tip) + '</p>' : '') + '</div>' +
      hostNext(s, last ? '💞 İkizini tahmin et' : 'Sonraki tur ▶'));
    Sound.beep(R.me ? 988 : 330, 0.2, 'triangle', 0.08);
  },
};

Views['ikiz:guess'] = {
  mount(s) {
    const I = s.ikiz;
    const rows = I.history.map((h, k) => {
      const mine = h.answers[s.you];
      const same = mine != null ? Object.keys(h.answers).filter((id) => id !== s.you && normWord(h.answers[id]) === normWord(mine)) : [];
      return '<div class="ihrow ' + (h.me ? 'yes' : '') + '"><div><b>' + (k + 1) + '. ' + esc(h.prompt) + '</b> ' + (h.me ? '💞' : '💔') + '</div>' +
        '<div class="muted">Sen: ' + (mine != null ? esc(mine) : '—') + (same.length ? ' · aynı yazan: ' + esc(nameList(same)) : '') + '</div></div>';
    }).join('');
    mount(header() + timerHTML('İkiz tahmini') +
      '<div class="phase-title"><h1>Ruh ikizin kim? 💞</h1><p>' + (I.twins > 1 ? '2 ikizin var, birini seçmen yeterli. ' : '') + 'Doğru bilirsen +' + IKIZ_GUESS_POINTS + '!</p></div>' +
      '<div id="ikizGuessArea"><div class="choices">' + s.roster.filter((id) => id !== s.you).map((id) => '<button class="choice" data-act="iguess" data-id="' + esc(id) + '">' +
        avatarHTML(nameOf(id)) + '<span class="nm">' + esc(nameOf(id).name) + '</span></button>').join('') + '</div></div>' +
      '<div class="card" style="margin-top:16px"><h2>İpuçların 🔎</h2><div class="ihist2">' + rows + '</div></div>' +
      '<div class="card"><h2>Kim seçti?</h2><div class="chips" id="ikizChips"></div></div>' +
      hostSkip('Sonuçları aç'));
  },
  update(s) {
    const I = s.ikiz;
    if (I.myGuess && !$('#ikizSent')) {
      $('#ikizGuessArea').innerHTML = '<div class="waiting-pill" id="ikizSent">Seçimin: <b>' + esc(nameOf(I.myGuess).name) + '</b> ✓ Diğerleri bekleniyor…</div>';
    }
    $('#ikizChips').innerHTML = doneChips(s, I.done);
  },
};

function ikizFinalMount(s) {
  const F = s.final;
  const together = (g) => F.history.filter((h) => g.some((a) => g.some((b) => a < b && h.answers[a] != null && h.answers[b] != null &&
    normWord(h.answers[a]) === normWord(h.answers[b])))).length;
  const scored = F.groups.map((g) => ({ g, n: together(g) }));
  const best = Math.max(0, ...scored.map((x) => x.n));
  const pairs = scored.map(({ g, n }) => {
    const people = g.map((id) => '<div class="twin">' + avatarHTML(nameOf(id), 'lg') + '<b>' + esc(nameOf(id).name) + '</b><small>' +
      (F.guess[id] ? (F.right[id] ? '✅ ikizini bildi' : '❌ ' + esc(nameOf(F.guess[id]).name) + ' dedi') : '🤐 seçmedi') + '</small></div>').join('<div class="heart">💞</div>');
    return '<div class="card twinpair ' + (n === best && best > 0 ? 'best' : '') + '"><div class="twins">' + people + '</div>' +
      '<div class="center muted" style="margin-top:6px"><b>' + n + ' / ' + F.rounds + '</b> turda aynı cevap' + (n === best && best > 0 ? ' · 🏆 en uyumlu' : '') + '</div></div>';
  }).join('');
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.matches[id] + ' eşleşme' + (F.right[id] ? ' · ikizini bildi' : '') + '</small></span><b>' + F.scores[id] + '</b></div>').join('');
  mount(
    header() +
    '<div class="phase-title"><h1>Ruh ikizleri açıklandı! 💞</h1><p>Kim kiminle eşleşmiş, bakalım…</p></div>' +
    pairs +
    '<div class="card"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">İkizinle aynı cevap: +' + IKIZ_MATCH_POINTS + ' · İkizini bilmek: +' + IKIZ_GUESS_POINTS + '</p></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Telepati ---------- */

Views['tele:play'] = {
  mount(s) {
    const T = s.tele;
    const [a, b] = T.pair;
    const ban = '<div class="card pairban">' + avatarHTML(nameOf(a), 'lg') + '<div class="heart">🧠</div>' + avatarHTML(nameOf(b), 'lg') +
      '<div class="pairnames">' + esc(nameOf(a).name) + ' & ' + esc(nameOf(b).name) + '</div></div>';
    const other = T.pair.find((x) => x !== s.you);
    const body = T.amPair
      ? '<div class="card myturn" id="teleArea"><h2>Sen seçildin! 🎤</h2><p class="muted" style="margin:0 0 10px">' + esc(nameOf(other).name) +
        ' ile aynı cevabı vermeye çalış. Konuşmak yasak! 🤐</p>' + wordInput('teleWord', 'tword', 'Cevabın…') + '</div>'
      : '<div id="teleArea"><div class="card center"><h2 style="margin-top:0">Tutturacaklar mı? 🤔</h2><p class="muted" style="margin:0 0 12px">Doğru bahis: +' + TELE_BET_POINTS + '</p>' +
        '<div class="yn"><button class="ynb no" data-act="tbet" data-v="yes"><span>✅</span>Tuttururlar</button>' +
        '<button class="ynb yes" data-act="tbet" data-v="no"><span>❌</span>Tutturamazlar</button></div></div></div>';
    mount(header() + timerHTML('Süre') + stepDots(T.ri, T.rn) +
      '<div class="phase-title"><h1>Telepati ' + (T.ri + 1) + ' / ' + T.rn + '</h1></div>' + ban +
      '<div class="card qcard"><div class="qtext">' + esc(T.prompt) + '</div></div>' + body +
      OFFLINE_NOTE + '<div class="card"><h2>Kim hazır?</h2><div class="chips" id="teleChips"></div></div>' +
      hostSkip('Cevapları aç'));
    if (T.amPair) { Sound.join(); focusFine('#teleWord', true); }
  },
  update(s) {
    const T = s.tele;
    if (!$('#teleSent')) {
      if (T.amPair && T.myWord != null) $('#teleArea').innerHTML = '<div class="waiting-pill" id="teleSent">Cevabın: <b>' + esc(T.myWord) + '</b> ✓ Bakalım tutacak mı… 🤞</div>';
      if (!T.amPair && T.myBet) $('#teleArea').innerHTML = '<div class="waiting-pill" id="teleSent">Bahsin: <b>' + (T.myBet === 'yes' ? '✅ Tuttururlar' : '❌ Tutturamazlar') + '</b> ✓</div>';
    }
    $('#teleChips').innerHTML = doneChips(s, T.done);
    updateOffline(s, T.pair);
  },
};

Views['tele:reveal'] = {
  mount(s) {
    const T = s.tele;
    const R = T.result;
    const [a, b] = R.pair;
    const w = (id) => '<div class="tw">' + avatarHTML(nameOf(id), 'lg') + '<b>' + esc(nameOf(id).name) + '</b><div class="twword">' +
      (R.words[id] != null ? esc(R.words[id]) : '🤐') + '</div></div>';
    const bettors = Object.keys(R.bets);
    const last = T.ri >= T.rn - 1;
    mount(header() + revealTimer(s) + stepDots(T.ri, T.rn) +
      '<div class="card qcard"><div class="qtext">' + esc(R.prompt) + '</div></div>' +
      '<div class="card rescard" id="rescard"><div class="twrow">' + w(a) + '<div class="heart">' + (R.match ? '🧠' : '💥') + '</div>' + w(b) + '</div>' +
        '<div class="winline">' + (R.match ? '🎉 TUTTURDULAR! +' + TELE_MATCH_POINTS : '💥 Tutturamadılar!') + '</div>' +
        (bettors.length ? '<p class="center muted late" style="margin:10px 0 0">Doğru bahis: ' + (R.right.length ? esc(nameList(R.right)) : 'kimse 😅') + '</p>' : '') + '</div>' +
      '<div class="card late"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sonraki ▶'));
    setTimeout(() => $$('#rescard, .card.late').forEach((el) => el.classList.add('revealed')), 60);
    setTimeout(() => (R.match ? Sound.fanfare() : Sound.beep(200, 0.3, 'sawtooth', 0.05)), 1100);
  },
};

function teleFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.hits[id] + ' kez tutturdu</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.history.map((h) => '<div><span class="q"><b>' + esc(nameList(h.pair)) + ':</b> ' + esc(h.prompt) + '</span><span class="w">' +
    esc(h.pair.map((id) => h.words[id] ?? '—').join(' / ')) + ' ' + (h.match ? '✅' : '❌') + '</span></div>').join('');
  const hits = F.history.filter((h) => h.match).length;
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'en güçlü telepat 🧠') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Tutturan çift: +' + TELE_MATCH_POINTS + ' (ikisine de) · Doğru bahis: +' + TELE_BET_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün turlar <small>(' + hits + ' / ' + F.history.length + ' tuttu)</small></h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Ayna ---------- */

function aynaHead(s, timer) {
  const A = s.ayna;
  const m = nameOf(A.mirror);
  return header() + timer + stepDots(A.ti, A.tn) +
    '<div class="card qcard"><div class="kasker">🪞 Ayna: ' + avatarHTML(m) + '<b>' + esc(m.name) + '</b></div><div class="qtext">' + esc(A.q) + '</div></div>';
}

Views['ayna:answer'] = {
  mount(s) {
    const A = s.ayna;
    const m = nameOf(A.mirror).name;
    const body = A.amMirror
      ? '<div class="card myturn"><h2>Ayna sensin! 🪞</h2><p class="muted" style="margin:0 0 10px">Kendi gerçek cevabını yaz. Diğerleri senin ne yazdığını tahmin edecek.</p>' +
        wordInput('aynaText', 'asend', 'Senin cevabın…') + '<p class="muted" id="aynaMine" style="margin:8px 0 0"></p></div>'
      : '<div class="card"><label class="lbl" for="aynaText">Sence ' + esc(m) + ' ne yazdı?</label>' + wordInput('aynaText', 'asend', m + ' ne yazardı…') +
        '<p class="muted" id="aynaMine" style="margin:8px 0 0"></p><p class="muted" style="margin:6px 0 0">Doğru bilirsen +' + AYNA_RIGHT_POINTS + '</p></div>';
    mount(aynaHead(s, timerHTML('Cevap süresi')) + body + OFFLINE_NOTE +
      '<div class="card"><h2>Kim yazdı?</h2><div class="chips" id="aynaChips"></div></div>' +
      hostSkip('Kontrole geç'));
    if (A.amMirror) Sound.join();
    focusFine('#aynaText', A.amMirror);
  },
  update(s) {
    const A = s.ayna;
    $('#aynaMine').innerHTML = A.myText != null ? '✅ Yazdığın: <b>' + esc(A.myText) + '</b> (değiştirebilirsin)' : '';
    $('#aynaChips').innerHTML = doneChips(s, A.done);
    updateOffline(s, [A.mirror]);
  },
};

Views['ayna:judge'] = {
  mount(s) {
    const A = s.ayna;
    if (A.amMirror && A.judge) {
      App.aynaAcc = new Set(A.judge.pre);
      const rows = Object.entries(A.judge.guesses).map(([id, t]) => '<button class="tgl ' + (App.aynaAcc.has(id) ? 'on' : '') + '" data-act="atoggle" data-id="' + esc(id) + '">' +
        avatarHTML(nameOf(id), 'sm') + '<span class="nm"><b>' + esc(nameOf(id).name) + ':</b> ' + esc(t) + '</span><span class="mark">' + (App.aynaAcc.has(id) ? '✅' : '❌') + '</span></button>').join('');
      mount(aynaHead(s, timerHTML('Kontrol süresi')) +
        '<div class="card"><h2>Hangileri doğru sayılsın? 🧐</h2><p class="muted" style="margin:0 0 10px">Senin cevabın: <b>' + esc(A.judge.own) +
        '</b>. Aynı anlama gelenlere dokunup ✅ yap.</p><div class="tgls">' + rows + '</div>' +
        '<div style="height:14px"></div><button class="btn yellow big block" data-act="ajudge">Onayla ✅</button></div>');
    } else {
      mount(aynaHead(s, timerHTML('Kontrol süresi')) +
        '<div class="card center"><div class="big-emoji">🧐</div><h2>' + esc(nameOf(A.mirror).name) + ' cevapları kontrol ediyor…</h2>' +
        (A.myText != null ? '<p class="muted" style="margin:0">Senin tahminin: <b>' + esc(A.myText) + '</b></p>' : '') + '</div>' +
        hostSkip('Böyle onayla'));
    }
  },
};

Views['ayna:reveal'] = {
  mount(s) {
    const A = s.ayna;
    const R = A.result;
    const ids = Object.keys(R.guesses).sort((x, y) => R.accepted.includes(y) - R.accepted.includes(x));
    const rows = ids.map((id, i) => {
      const ok = R.accepted.includes(id);
      return '<div class="krow ' + (ok ? 'top' : '') + '" style="--d:' + (1.2 + i * 0.4).toFixed(2) + 's">' + avatarHTML(nameOf(id)) +
        '<div class="body"><div class="top2"><span class="nm">' + esc(nameOf(id).name) + '</span>' + (ok ? '<span class="dl">+' + AYNA_RIGHT_POINTS + '</span>' : '') + '</div>' +
        '<div class="kdiff">' + (ok ? '✅ ' : '❌ ') + esc(R.guesses[id]) + '</div></div></div>';
    }).join('');
    const after = 1.2 + ids.length * 0.4 + 0.3;
    const last = A.ti >= A.tn - 1;
    const verdict = R.own == null ? 'Ayna cevap vermedi 🤐'
      : !ids.length ? 'Kimse tahmin etmedi 🤷'
      : R.accepted.length === ids.length ? '🤩 Herkes bildi!'
      : R.accepted.length ? '👏 ' + R.accepted.length + ' kişi bildi'
      : '🙈 Kimse bilemedi! Gizemli biri…';
    mount(aynaHead(s, revealTimer(s)) +
      '<div class="card center"><div class="muted" style="font-weight:700">Aynanın cevabı</div><div class="kanswer aword">' + (R.own != null ? esc(R.own) : '🤐') + '</div>' +
        '<div class="kreveal" style="text-align:left">' + rows + '</div>' +
        '<div class="ktotal" style="--d:' + after.toFixed(2) + 's">' + esc(verdict) + '</div></div>' +
      '<div class="card kafter" style="--d:' + (after + 0.4).toFixed(2) + 's"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sıradaki ayna ▶'));
    setTimeout(() => Sound.beep(880, 0.2, 'triangle', 0.09), 700);
  },
};

function aynaFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.right[id] + ' doğru tahmin · ' + F.known[id] + ' kişi onu bildi</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const mostKnown = Math.max(0, ...Object.values(F.known));
  const stats = [];
  if (mostKnown > 0) stats.push(['🪞', nameList(Object.keys(F.known).filter((id) => F.known[id] === mostKnown)), 'en iyi tanınan (' + mostKnown + ' kişi bildi)']);
  const mostRight = Math.max(0, ...Object.values(F.right));
  if (mostRight > 0) stats.push(['🕵️', nameList(Object.keys(F.right).filter((id) => F.right[id] === mostRight)), 'herkesi en iyi tanıyan (' + mostRight + ' doğru)']);
  const recap = F.history.map((h) => '<div><span class="q"><b>' + esc(nameOf(h.mirror).name) + ':</b> ' + esc(h.q) + '</span><span class="w">' +
    (h.own != null ? esc(h.own) : '—') + ' <span class="muted">(' + h.accepted.length + '/' + h.total + ' bildi)</span></span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'arkadaşlarını en iyi tanıyan 🪞') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Aynanın onayladığı her doğru tahmin: +' + AYNA_RIGHT_POINTS + '</p></div>' +
    (stats.length ? '<div class="card"><h2>Bu turda</h2>' + statsHTML(stats) + '</div>' : '') +
    '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Emojiyle Anlat ---------- */

function emoTop(s, timer) {
  return header() + timer + stepDots(s.emo.ti, s.emo.tn);
}

function emoCountPaint() {
  const inp = $('#emoClue');
  const el = $('#emoCount');
  if (!inp || !el) return;
  const n = emojiCount(inp.value);
  el.textContent = n + ' / ' + EMO_MAX_CLUE;
  el.classList.toggle('full', n >= EMO_MAX_CLUE);
}

function emoPickerHTML() {
  const i = App.emoTab || 0;
  return '<div class="emopick"><div class="emotabs">' + EMOJI_CATS.map((c, k) => '<button class="emotab ' + (k === i ? 'on' : '') + '" data-act="emoTab" data-i="' + k + '" title="' + esc(c.n) + '">' + c.e + '</button>').join('') +
    '</div><div class="emogrid" id="emoGrid">' + emoGridHTML(i) + '</div></div>';
}

function emoGridHTML(i) {
  EMOJI_CATS[i].list = EMOJI_CATS[i].list || graphemes(EMOJI_CATS[i].s).filter(isEmojiOnly);
  return EMOJI_CATS[i].list.map((e) => '<button class="emob" data-act="emoPick" data-e="' + e + '">' + e + '</button>').join('');
}

Views['emo:write'] = {
  mount(s) {
    const E = s.emo;
    const n = nameOf(E.narr);
    const body = E.amNarr
      ? '<div class="card myturn center"><h2>Sıra sende! 🎬</h2><div class="muted">Bunu sadece emojiyle anlat:</div>' +
        '<div class="emotitle" id="emoTitle"></div><div class="muted" id="emoCat"></div><div id="emoReroll"></div>' +
        '<div class="row" style="margin-top:10px"><input id="emoClue" class="field grow emoin" maxlength="400" placeholder="Aşağıdan emoji seç 👇" autocomplete="off" inputmode="none">' +
        '<button class="btn small ghost" data-act="emoBack" title="Sil">⌫</button></div>' +
        '<div class="emocount" id="emoCount">0 / ' + EMO_MAX_CLUE + '</div>' +
        emoPickerHTML() +
        '<button class="btn green big block" data-act="eclue" style="margin-top:10px">Gönder 🚀</button>' +
        '<p class="muted" style="margin:8px 0 0;font-size:14px">Sadece emoji! Harf, rakam ve bayrak yok 🙅 <button class="linkbtn" data-act="emoKbd">⌨️ Telefon klavyesiyle yaz</button></p></div>'
      : '<div class="card center turnwait">' + avatarHTML(n, 'lg') + '<h2 style="margin:8px 0 0">' + esc(n.name) + ' emoji hazırlıyor… 🤔</h2>' +
        '<p class="muted" style="margin:4px 0 0">Kategori: <b>' + esc(E.cat) + '</b></p></div>';
    mount(emoTop(s, timerHTML('Emoji yazma süresi')) + body + OFFLINE_NOTE + hostSkip('Sırayı geç'));
    if (E.amNarr) { Sound.join(); emoCountPaint(); }
  },
  update(s) {
    const E = s.emo;
    if (E.amNarr) {
      $('#emoTitle').textContent = E.title || '';
      $('#emoCat').textContent = '(' + E.cat + ')';
      $('#emoReroll').innerHTML = E.rerollsLeft > 0
        ? '<div class="ctrl" style="margin:8px 0 0"><button class="btn small ghost" data-act="ereroll">🎲 Başka ver (' + E.rerollsLeft + ')</button></div>' : '';
    }
    updateOffline(s, [E.narr]);
  },
};

Views['emo:guess'] = {
  mount(s) {
    App.emoHintSeen = '';
    const E = s.emo;
    const n = nameOf(E.narr);
    mount(emoTop(s, timerHTML('Tahmin süresi')) +
      '<div class="card center"><div class="kasker">' + avatarHTML(n) + '<b>' + esc(n.name) + '</b> anlatıyor · ' + esc(E.cat) + '</div>' +
      '<div class="emoclue">' + esc(E.clue) + '</div><div id="emoHint"></div></div>' +
      '<div id="emoArea"></div>' +
      '<div class="card"><h2>Tahminler</h2><div class="emofeed" id="emoFeed"></div></div>' +
      hostSkip('Cevabı aç'));
  },
  update(s) {
    const E = s.emo;
    const hintKey = E.hint ? E.hint.join('|') : '';
    if (hintKey !== App.emoHintSeen) {
      App.emoHintSeen = hintKey;
      $('#emoHint').innerHTML = E.hint ? '<div class="emohint"><div class="muted">💡 Harf ipucu</div><div class="amask">' + adamMaskHTML(E.hint) + '</div></div>' : '';
      if (E.hint) Sound.beep(1175, 0.12, 'triangle', 0.06);
    }
    const area = $('#emoArea');
    const state = E.amNarr ? 'narr' : E.iGot ? 'got' : 'guess';
    if (state === 'narr') {
      area.innerHTML = '<div class="waiting-pill" style="margin-bottom:16px">👀 Arkadaşların tahmin ediyor… ' + E.correct.length + ' kişi bildi</div>';
    } else if (area.dataset.state !== state) {
      area.innerHTML = state === 'got'
        ? '<div class="waiting-pill" style="margin-bottom:16px">✅ Bildin! Diğerleri bekleniyor…</div>'
        : '<div class="card">' + wordInput('emoGuess', 'eguess', 'Tahminin…') + '<p class="muted" style="margin:8px 0 0;font-size:14px">İstediğin kadar tahmin yapabilirsin</p></div>';
      if (state === 'guess') focusFine('#emoGuess');
    }
    area.dataset.state = state;
    const feed = $('#emoFeed');
    feed.innerHTML = E.feed.length
      ? E.feed.map((f) => f.ok
        ? '<div class="fitem ok">✅ <b>' + esc(nameOf(f.id).name) + '</b> bildi!</div>'
        : '<div class="fitem"><b>' + esc(nameOf(f.id).name) + ':</b> ' + esc(f.text) + '</div>').join('')
      : '<p class="muted" style="margin:0">Henüz tahmin yok…</p>';
    feed.scrollTop = feed.scrollHeight;
  },
};

Views['emo:reveal'] = {
  mount(s) {
    const E = s.emo;
    const R = E.result;
    const n = nameOf(R.narr);
    const last = E.ti >= E.tn - 1;
    const verdict = !R.clue ? '🤐 Anlatıcı pas geçti' : !R.correct.length ? '😅 Kimse bilemedi!' : '🎉 ' + R.correct.length + ' kişi bildi!';
    const rows = R.correct.map((id, i) => '<div class="srow"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id), 'sm') +
      '<span class="nm">' + esc(nameOf(id).name) + '</span><span class="dl">+' + (i < EMO_POINTS.length ? EMO_POINTS[i] : EMO_POINTS_REST) + '</span></div>').join('');
    mount(emoTop(s, revealTimer(s)) +
      '<div class="card center"><div class="kasker">' + avatarHTML(n) + '<b>' + esc(n.name) + '</b> anlattı</div>' +
        '<div class="emoclue">' + (R.clue ? esc(R.clue) : '🤐') + '</div>' +
        '<div class="muted" style="font-weight:700">Cevap</div><div class="kanswer aword">' + esc(R.title) + '</div>' +
        '<div style="font-weight:800;font-size:20px">' + esc(verdict) + '</div></div>' +
      (rows ? '<div class="card"><h2>Bilenler</h2><div class="board">' + rows + '</div>' +
        '<p class="muted" style="margin:10px 0 0;font-size:14px">' + esc(n.name) + ' bilen her kişi için +' + EMO_NARRATOR_POINTS + ' aldı</p></div>' : '') +
      '<div class="card"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sıradaki ▶'));
    Sound.beep(R.correct.length ? 988 : 330, 0.2, 'triangle', 0.08);
  },
};

function emoFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.got[id] + ' doğru tahmin · anlattığını ' + F.narrated[id] + ' kişi bildi</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.history.map((h) => '<div><span class="q"><b>' + esc(nameOf(h.narr).name) + ':</b> ' + (h.clue ? esc(h.clue) : '🤐') + '</span><span class="w">' +
    esc(h.title) + ' <span class="muted">(' + h.correct.length + ' bildi)</span></span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'emoji ustası 🎬') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">İlk bilen +' + EMO_POINTS[0] + ', ikinci +' + EMO_POINTS[1] + ', sonrakiler +' + EMO_POINTS_REST + ' · Anlatıcı, bilen her kişi için +' + EMO_NARRATOR_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün anlatımlar</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Çoğunluğu Bil ---------- */

function cogPaint() {
  const yn = $('.yn');
  if (yn) yn.classList.toggle('choosing', App.cogYes != null);
  $$('[data-act=cyes]').forEach((b) => b.classList.toggle('picked', App.cogYes === (b.dataset.v === '1')));
  const el = $('#cogPred');
  if (el) el.textContent = App.cogPred;
}

Views['cog:answer'] = {
  mount(s) {
    const C = s.cog;
    App.cogYes = C.mine ? C.mine.yes : null;
    App.cogPred = C.mine ? C.mine.pred : Math.ceil(C.n / 2);
    mount(header() + timerHTML('Cevap süresi') + stepDots(C.qi, C.qn) +
      '<div class="card qcard"><div class="meta">Soru ' + (C.qi + 1) + ' / ' + C.qn + '</div><div class="qtext">' + esc(C.q) + '</div></div>' +
      '<div class="card"><div class="lbl">1) Senin cevabın</div>' +
        '<div class="yn"><button class="ynb no" data-act="cyes" data-v="1"><span>👍</span>Evet</button>' +
        '<button class="ynb yes" data-act="cyes" data-v="0"><span>👎</span>Hayır</button></div>' +
        '<div class="lbl" style="margin-top:16px">2) Sence ' + C.n + ' kişiden kaçı "Evet" der? <span class="muted">(sen dahil)</span></div>' +
        '<div class="cogpred"><button class="btn ghost" data-act="cpred" data-d="-1">−</button><span id="cogPred"></span>' +
        '<button class="btn ghost" data-act="cpred" data-d="1">+</button></div>' +
        '<div style="height:14px"></div><button class="btn yellow big block" data-act="csend">Gönder</button>' +
        '<p class="muted center" id="cogMine" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Kim cevapladı?</h2><div class="chips" id="cogChips"></div></div>' +
      hostSkip('Sonuçları aç'));
    cogPaint();
  },
  update(s) {
    const C = s.cog;
    $('#cogChips').innerHTML = doneChips(s, C.done);
    $('#cogMine').textContent = C.mine ? '✅ Gönderdin: ' + (C.mine.yes ? 'Evet' : 'Hayır') + ', tahminin ' + C.mine.pred + ' (değiştirebilirsin)' : '';
  },
};

Views['cog:reveal'] = {
  mount(s) {
    const C = s.cog;
    const R = C.result;
    const pct = R.total ? Math.round(R.yesCount / R.total * 100) : 0;
    const people = (ids) => ids.length ? ids.map((id) => '<span class="chip">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</span>').join('') : '<span class="muted">Kimse</span>';
    const lists = R.yes ? '<div class="ynlists"><div><h3>👍 Evet diyenler</h3><div class="chips">' + people(R.yes) + '</div></div>' +
      '<div><h3>👎 Hayır diyenler</h3><div class="chips">' + people(R.no) + '</div></div></div>' : '';
    const rows = Object.keys(R.preds).sort((a, b) => R.preds[a].diff - R.preds[b].diff).map((id) => {
      const pr = R.preds[id];
      return '<div class="srow ' + (pr.diff === 0 ? 'win' : '') + '">' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) +
        '<small>tahmin: ' + pr.pred + (pr.diff === 0 ? ' · 🎯 tam isabet' : pr.diff === 1 ? ' · 👌 1 fark' : ' · ' + pr.diff + ' fark') + '</small></span>' +
        (R.delta[id] ? '<span class="dl">+' + R.delta[id] + '</span>' : '') + '</div>';
    }).join('');
    const last = C.qi >= C.qn - 1;
    mount(header() + revealTimer(s) + stepDots(C.qi, C.qn) +
      '<div class="card qcard"><div class="meta">Soru ' + (C.qi + 1) + ' / ' + C.qn + '</div><div class="qtext">' + esc(R.q) + '</div></div>' +
      '<div class="card center"><div class="ynpct cogn">' + R.yesCount + ' / ' + R.total + '</div><div class="muted">kişi "Evet" dedi</div>' +
        '<div class="ynbar cog"><i class="y" data-w="' + pct + '"></i></div>' + lists + '</div>' +
      '<div class="card"><h2>Tahminler</h2><div class="board">' + (rows || '<p class="muted" style="margin:0">Kimse cevap vermedi.</p>') + '</div></div>' +
      '<div class="card"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sonraki soru ▶'));
    setTimeout(() => $$('.ynbar i').forEach((el) => { el.style.width = el.dataset.w + '%'; }), 60);
    Sound.beep(880, 0.2, 'triangle', 0.08);
  },
};

function cogFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.exact[id] + ' tam isabet</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.recap.map((r) => '<div><span class="q">' + esc(r.q) + '</span><span class="w">' + (r.total ? r.yesCount + '/' + r.total + ' evet' : '—') + '</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'grubu en iyi okuyan 📊') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Tam isabet +' + COG_EXACT_POINTS + ' · 1 fark +' + COG_CLOSE_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- İki Doğru Bir Yalan ---------- */

function ikyPaint() {
  $$('.liebtn').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === App.ikyLie));
}

Views['iky:write'] = {
  mount(s) {
    const I = s.iky;
    const a = nameOf(I.author);
    App.ikyLie = null;
    const ph = ['Örn: Hiç uçağa binmedim', 'Örn: 3 kardeşim var', 'Örn: Çocukken bir yarışma kazandım'];
    const rows = [0, 1, 2].map((i) => '<div class="ikyrow"><span class="num">' + (i + 1) + '</span>' +
      '<input class="field grow iky-in" data-i="' + i + '" maxlength="' + MAX_Q_LEN + '" placeholder="' + esc(ph[i]) + '" autocomplete="off">' +
      '<button class="liebtn" data-act="ilie" data-i="' + i + '" title="Bu yalan">🤥</button></div>').join('');
    const body = I.amAuthor
      ? '<div class="card myturn"><h2>Sıra sende! 🎭</h2><p class="muted" style="margin:0 0 12px">Kendin hakkında 3 şey yaz. Birini yalan yap ve yanındaki 🤥 ile işaretle!</p>' +
        '<div class="qlist">' + rows + '</div><div style="height:14px"></div>' +
        '<button class="btn green big block" data-act="iwrite">✅ Gönder</button></div>'
      : '<div class="card center turnwait">' + avatarHTML(a, 'lg') + '<h2 style="margin:8px 0 0">' + esc(a.name) + ' yalanını hazırlıyor… 🤫</h2>' +
        '<p class="muted" style="margin:4px 0 0">Birazdan hangisinin yalan olduğunu bulacaksın</p></div>';
    mount(header() + timerHTML('Yazma süresi') + stepDots(I.ti, I.tn) + body + OFFLINE_NOTE + hostSkip('Sırayı geç'));
    if (I.amAuthor) {
      Sound.join();
      ikyPaint();
      focusFine('.iky-in', true);
    }
  },
  update(s) { updateOffline(s, [s.iky.author]); },
};

Views['iky:guess'] = {
  mount(s) {
    const I = s.iky;
    const a = nameOf(I.author);
    const opts = I.list.map((t, i) => I.amAuthor
      ? '<div class="ansb mine">' + esc(t) + '</div>'
      : '<button class="ansb" data-act="ipick" data-i="' + i + '">' + esc(t) + '</button>').join('');
    mount(header() + timerHTML('Tahmin süresi') + stepDots(I.ti, I.tn) +
      '<div class="card qcard"><div class="kasker">' + avatarHTML(a) + '<b>' + esc(a.name) + '</b></div><div class="qtext">Hangisi yalan? 🤥</div></div>' +
      (I.amAuthor ? '<div class="waiting-pill" style="margin-bottom:12px">😏 Arkadaşların senin yalanını arıyor…</div>' : '') +
      '<div class="answers">' + opts + '</div>' +
      '<div class="card" style="margin-top:16px"><h2>Kim seçti?</h2><div class="chips" id="ikyChips"></div></div>' +
      hostSkip('Cevabı aç'));
    if (I.amAuthor) Sound.join();
  },
  update(s) {
    const I = s.iky;
    $('#ikyChips').innerHTML = doneChips(s, I.done, Object.keys(I.done));
    $$('[data-act=ipick]').forEach((b) => b.classList.toggle('picked', Number(b.dataset.i) === I.myPick));
  },
};

Views['iky:reveal'] = {
  mount(s) {
    const I = s.iky;
    const R = I.result;
    const a = nameOf(R.author);
    const total = Object.keys(R.picks).length;
    const items = R.list.map((t, i) => {
      const pickers = Object.keys(R.picks).filter((pp) => R.picks[pp] === i);
      return '<div class="ikyres ' + (i === R.lie ? 'lie' : '') + '"><div class="t"><span class="mark">' + (i === R.lie ? '🤥' : '✅') + '</span> ' + esc(t) + '</div>' +
        '<div class="voters">' + (pickers.length ? esc(nameList(pickers)) + ' seçti' : 'kimse seçmedi') + '</div></div>';
    }).join('');
    const verdict = !total ? 'Kimse seçim yapmadı 🤷'
      : !R.correct.length ? '😎 Kimse bulamadı! ' + a.name + ' herkesi kandırdı'
      : !R.fooled ? '🕵️ Herkes buldu! Çok belli etmişsin'
      : '🔍 ' + R.correct.length + ' kişi buldu';
    const last = I.ti >= I.tn - 1;
    mount(header() + revealTimer(s) + stepDots(I.ti, I.tn) +
      '<div class="card rescard" id="rescard"><div class="kasker">' + avatarHTML(a) + '<b>' + esc(a.name) + '</b></div>' +
        '<div class="ikyress">' + items + '</div><div class="winline">' + esc(verdict) + '</div></div>' +
      '<div class="card late"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sıradaki ▶'));
    setTimeout(() => $$('#rescard, .card.late').forEach((el) => el.classList.add('revealed')), 60);
    setTimeout(() => Sound.beep(988, 0.15, 'triangle', 0.08), 1100);
  },
};

function ikyFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.found[id] + ' yalan buldu · ' + F.fooled[id] + ' kişiyi kandırdı</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.history.map((h) => '<div><span class="q"><b>' + esc(nameOf(h.author).name) + ':</b> 🤥 ' + esc(h.lieText) + '</span><span class="w">' +
    h.correct + '/' + h.total + ' buldu</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'turun şampiyonu 🎭') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Yalanı bulan +' + IKY_FOUND_POINTS + ' · Kandırdığın her kişi +' + IKY_FOOL_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün yalanlar</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Sıralama ---------- */

function sirPaint() {
  const Q = App.state.sir;
  const list = $('#sirList');
  if (!list || !Q.rankIds) return;
  // Picked people move to the top in their chosen order, the rest wait below.
  const ids = App.sirOrder.concat(Q.rankIds.filter((id) => !App.sirOrder.includes(id)));
  list.innerHTML = ids.map((id) => {
    const pos = App.sirOrder.indexOf(id);
    return '<button class="sirbtn ' + (pos >= 0 ? 'on' : '') + '" data-act="spick" data-id="' + esc(id) + '"><span class="sirpos">' + (pos >= 0 ? pos + 1 : '') + '</span>' +
      avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + '</span></button>';
  }).join('');
  $('#sirSend').disabled = App.sirOrder.length !== Q.rankIds.length;
}

function sirAskCard(s, q) {
  const a = nameOf(s.sir.asker);
  return '<div class="card qcard"><div class="kasker">' + avatarHTML(a) + '<b>' + esc(a.name) + '</b> soruyor:</div><div class="qtext">' + esc(q) + '</div></div>';
}

Views['sir:ask'] = {
  mount(s) {
    const Q = s.sir;
    const a = nameOf(Q.asker);
    const body = Q.amAsker
      ? '<div class="card myturn"><h2>Sıra sende! 🎤</h2><p class="muted" style="margin:0 0 10px">Grubu sıralatacak bir soru sor. Örn: "Burada en çok kim uyur?"</p>' +
        '<div class="row"><input id="sirQ" class="field grow" maxlength="' + MAX_Q_LEN + '" placeholder="En çok kim…?" autocomplete="off">' +
        '<button class="dice" data-act="sidea" title="Fikir ver">🎲</button></div>' +
        '<div style="height:12px"></div><button class="btn yellow big block" data-act="sask">Soruyu sor 🚀</button></div>'
      : '<div class="card center turnwait">' + avatarHTML(a, 'lg') + '<h2 style="margin:8px 0 0">' + esc(a.name) + ' soru hazırlıyor…</h2>' +
        '<p class="muted" style="margin:4px 0 0">Birazdan herkesi sıralayacaksın 📏</p></div>';
    mount(header() + timerHTML('Soru yazma süresi') + stepDots(Q.ti, Q.tn) + body + OFFLINE_NOTE + hostSkip('Sırayı geç'));
    if (Q.amAsker) { Sound.join(); focusFine('#sirQ', true); }
  },
  update(s) { updateOffline(s, [s.sir.asker]); },
};

Views['sir:rank'] = {
  mount(s) {
    const Q = s.sir;
    App.sirOrder = Q.myRank ? Q.myRank.slice() : [];
    mount(header() + timerHTML('Sıralama süresi') + stepDots(Q.ti, Q.tn) + sirAskCard(s, Q.q) +
      '<div class="card"><h2>Sırala! <small>En çoktan en aza, sırayla dokun</small></h2><div class="sirlist" id="sirList"></div>' +
        '<div class="ctrl" style="margin-top:12px"><button class="btn small ghost" data-act="sreset">↺ Sıfırla</button></div>' +
        '<div style="height:10px"></div><button class="btn yellow big block" data-act="srank" id="sirSend">Gönder</button>' +
        '<p class="muted center" id="sirMine" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Kim sıraladı?</h2><div class="chips" id="sirChips"></div></div>' +
      hostSkip('Sonuçları aç'));
    sirPaint();
  },
  update(s) {
    $('#sirChips').innerHTML = doneChips(s, s.sir.done);
    $('#sirMine').textContent = s.sir.myRank ? '✅ Gönderdin (istersen değiştirip tekrar gönderebilirsin)' : '';
  },
};

Views['sir:reveal'] = {
  mount(s) {
    const Q = s.sir;
    const R = Q.result;
    const n = R.group.length;
    // Bottom of the list first, the "winner" last.
    const rows = R.group.map((g, i) => '<div class="krow ' + (i === 0 ? 'top' : '') + '" style="--d:' + ((n - 1 - i) * 0.5 + 0.4).toFixed(2) + 's">' +
      '<span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(g.id)) + '<div class="body"><div class="top2"><span class="nm">' + (i === 0 ? '👑 ' : '') +
      esc(nameOf(g.id).name) + '</span></div><div class="kdiff">ortalama sıra: ' + (g.avg + 1).toFixed(1).replace('.', ',') + '</div></div></div>').join('');
    const after = (n - 1) * 0.5 + 0.9;
    const guesses = Object.keys(R.guesses).sort((a, b) => R.guesses[b].right - R.guesses[a].right).map((id) => {
      const gg = R.guesses[id];
      return '<div class="srow ' + (gg.right === n ? 'win' : '') + '">' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) +
        '<small>' + gg.right + ' / ' + n + ' kişi doğru yerde' + (gg.right === n ? ' · 🎯 birebir!' : '') + '</small></span>' +
        (R.delta[id] ? '<span class="dl">+' + R.delta[id] + '</span>' : '') + '</div>';
    }).join('');
    const last = Q.ti >= Q.tn - 1;
    mount(header() + revealTimer(s) + stepDots(Q.ti, Q.tn) + sirAskCard(s, R.q) +
      '<div class="card"><h2>Grubun sıralaması</h2><div class="kreveal">' + (rows || '<p class="muted" style="margin:0">Kimse sıralama yapmadı.</p>') + '</div></div>' +
      '<div class="card kafter" style="--d:' + after.toFixed(2) + 's"><h2>Grubu kim en iyi bildi?</h2><div class="board">' + (guesses || '<p class="muted" style="margin:0">—</p>') + '</div></div>' +
      '<div class="card kafter" style="--d:' + (after + 0.4).toFixed(2) + 's"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sıradaki ▶'));
    setTimeout(() => Sound.fanfare(), after * 1000 - 400);
  },
};

function sirFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.perfect[id] + ' kez birebir bildi</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.recap.map((r) => '<div><span class="q"><b>' + esc(nameOf(r.asker).name) + ':</b> ' + esc(r.q) + '</span><span class="w">' +
    (r.top ? '👑 ' + esc(nameOf(r.top).name) : '—') + '</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'grubu en iyi tanıyan 📏') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Grubun sıralamasıyla aynı yere koyduğun her kişi +' + SIR_POS_POINTS + ' · Birebir aynıysa +' + SIR_PERFECT_BONUS + ' bonus</p></div>' +
    '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Kafe Savaşları ---------- */

const tl = (n) => Math.round(n).toLocaleString('tr-TR') + '₺';

function kafeStars(n) {
  return '⭐'.repeat(n) + '<span class="dim">' + '⭐'.repeat(5 - n) + '</span>';
}

function kafeBoard(s) {
  const K = s.kafe;
  return '<div class="board">' + s.roster.slice().sort((a, b) => K.cafes[b].money - K.cafes[a].money).map((id, i) => {
    const c = K.cafes[id];
    return '<div class="srow"><span class="rk">' + (i + 1) + '</span><span class="kfe">' + c.e + '</span><span class="nm">' + esc(c.name) +
      '<small>' + kafeStars(c.stars) + (c.amb ? ' · 🪴×' + c.amb : '') + (c.barista ? ' · 🧑‍🍳×' + (c.barista * 2) : '') + '</small></span><b>' + tl(c.money) + '</b></div>';
  }).join('') + '</div>';
}

function kafePaint() {
  const K = App.state.kafe;
  const box = $('#kafePlan');
  if (!box) return;
  const me = K.cafes[App.state.you];
  const others = App.state.roster.filter((id) => id !== App.state.you);
  box.innerHTML =
    '<div class="lbl">💲 Bugünkü kahve fiyatın</div><div class="cogpred"><button class="btn ghost" data-act="kPrice" data-d="-5">−</button><span>' + App.kPrice + '₺</span>' +
      '<button class="btn ghost" data-act="kPrice" data-d="5">+</button></div>' +
    '<p class="muted center" style="margin:4px 0 12px;font-size:13px">Bir fincanın maliyeti ' + (K.ev.unit || KAFE_UNIT) + '₺ · Günlük kira ' + KAFE_RENT + '₺</p>' +
    '<div class="lbl">🏗️ Bugünkü yatırımın</div><div class="kinv">' + Object.entries(KAFE_INV).map(([k, v]) => '<button class="kopt ' + (App.kInv === k ? 'on' : '') + '" data-act="kInv" data-k="' + k + '"' +
      (v.cost > me.money ? ' disabled' : '') + '><span class="e">' + v.e + '</span><b>' + esc(v.n) + '</b><small>' + esc(v.d) + '</small><span class="c">' + (v.cost ? tl(v.cost) : 'Bedava') + '</span></button>').join('') + '</div>' +
    '<div class="lbl" style="margin-top:12px">😈 Sabotaj <span class="muted">(oyunda ' + K.sabLeft + ' hakkın kaldı)</span></div>' +
    (K.sabLeft > 0 ? '<div class="kinv two">' + Object.entries(KAFE_SAB).map(([k, v]) => '<button class="kopt ' + (App.kSab === k ? 'on bad' : '') + '" data-act="kSabType" data-k="' + k + '"><span class="e">' + v.e + '</span><b>' + esc(v.n) + '</b><small>' + esc(v.d) + '</small></button>').join('') + '</div>' +
      (App.kSab ? '<select id="kSabTarget" class="field" style="margin-top:8px"><option value="">Hangi kafeye?</option>' + others.map((id) => '<option value="' + esc(id) + '"' + (App.kSabT === id ? ' selected' : '') + '>' + esc(K.cafes[id].e + ' ' + K.cafes[id].name) + '</option>').join('') + '</select>' : '')
      : '<p class="muted" style="margin:0">Sabotaj hakların bitti 😇</p>') +
    '<button class="btn yellow big block" data-act="kSend" style="margin-top:14px">✅ Kararlarımı gönder</button>' +
    '<p class="muted center" id="kSent" style="margin:8px 0 0"></p>';
  const sel = $('#kSabTarget');
  if (sel) sel.addEventListener('change', () => { App.kSabT = sel.value; });
}

Views['kafe:plan'] = {
  mount(s) {
    const K = s.kafe;
    const me = K.cafes[s.you];
    const mine = K.myPlan;
    App.kPrice = mine ? mine.price : me ? me.price : 40;
    App.kInv = mine ? mine.inv : 'none';
    App.kSab = mine && mine.sab ? mine.sab.type : null;
    App.kSabT = mine && mine.sab ? mine.sab.target : '';
    mount(header() + timerHTML('Karar süresi') +
      '<div class="vbar day kafebar"><b>☕ Gün ' + K.day + ' / ' + K.days + '</b><span>' + (me ? me.e + ' ' + esc(me.name) + ' · ' + tl(me.money) : '') + '</span></div>' +
      '<div class="card center kev"><div class="cinbig">' + K.ev.e + '</div><b>' + esc(K.ev.t) + '</b></div>' +
      (me ? '<div class="card"><div id="kafePlan"></div></div>' : '') +
      '<div class="card"><h2>Kafeler</h2>' + kafeBoard(s) + '</div>' +
      '<div class="card"><h2>Kim karar verdi?</h2><div class="chips" id="kChips"></div></div>' + hostSkip('Günü bitir'));
    kafePaint();
  },
  update(s) {
    $('#kChips').innerHTML = doneChips(s, s.kafe.done);
    if ($('#kSent')) $('#kSent').textContent = s.kafe.myPlan ? '✅ Gönderildi (gün bitene kadar değiştirebilirsin)' : '';
  },
};

Views['kafe:result'] = {
  mount(s) {
    const K = s.kafe;
    const R = K.result;
    const ids = s.roster.slice().sort((a, b) => R.rows[b].profit - R.rows[a].profit);
    const maxC = Math.max(1, ...ids.map((id) => R.rows[id].cust));
    const rows = ids.map((id) => {
      const x = R.rows[id];
      const c = K.cafes[id];
      return '<div class="kres ' + (id === s.you ? 'me' : '') + '"><div class="top"><span class="kfe">' + c.e + '</span><b>' + esc(c.name) + '</b>' +
        '<span class="kprofit ' + (x.profit >= 0 ? 'up' : 'down') + '">' + (x.profit >= 0 ? '+' : '') + tl(x.profit) + '</span></div>' +
        '<div class="kbar"><i style="width:' + Math.round(x.cust / maxC * 100) + '%"></i><span>👥 ' + x.cust + ' müşteri · ' + x.price + '₺ · ' + KAFE_INV[x.inv].e + ' ' + esc(KAFE_INV[x.inv].n) + '</span></div>' +
        (x.rat ? '<div class="ksab">🐀 Biri fare ihbarı yaptı!</div>' : '') + (x.reviews ? '<div class="ksab">👎 Biri kötü yorum yazdı!</div>' : '') +
        '<div class="ksays">' + x.says.map((t) => '<span>💬 ' + esc(t) + '</span>').join('') + '</div>' +
        '<div class="muted" style="font-size:13px">Ciro ' + tl(x.revenue) + ' · Gider ' + tl(x.cost) + ' · Kasa ' + tl(x.money) + '</div></div>';
    }).join('');
    const last = K.day >= K.days;
    mount(header() + revealTimer(s) +
      '<div class="vbar day kafebar"><b>📊 Gün ' + K.day + ' sonu</b><span>' + R.ev.e + ' ' + esc(R.ev.t) + '</span></div>' +
      '<div class="card"><h2>Günün sonuçları</h2>' + rows + '</div>' +
      '<div class="card"><h2>Kasada ne var?</h2>' + kafeBoard(s) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : '☀️ Gün ' + (K.day + 1)));
    Sound.beep(R.rows[s.you] && R.rows[s.you].profit >= 0 ? 880 : 300, 0.2, 'triangle', 0.07);
  },
};

function kafeFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => {
    const c = F.cafes[id];
    return '<div class="srow big"><span class="rk">' + (i + 1) + '</span><span class="kfe big">' + c.e + '</span><span class="nm">' + esc(c.name) +
      '<small>' + F.customers[id] + ' müşteri · en iyi gün ' + tl(c.best) + ' · ' + kafeStars(Math.max(1, Math.min(5, Math.round(c.rep * 3.2)))) + '</small></span><b>' + tl(F.scores[id]) + '</b></div>';
  }).join('');
  const w = F.ranking[0];
  mount(
    header() +
    '<div class="phase-title"><h1>' + F.cafes[w].e + ' ' + esc(F.cafes[w].name) + ' kazandı!</h1><p>Kasada ' + tl(F.scores[w]) + ' ile semtin kahve kralı 💰</p></div>' +
    podiumHTML(F.ranking, (id) => tl(F.scores[id])) +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Son durum 🏅</h2><div class="board">' + board + '</div></div>' +
    '<div class="card"><h2>Günler</h2><div class="recap">' + F.history.map((h) => '<div><span class="q">Gün ' + h.day + ': ' + esc(h.ev) + '</span><span class="w">🏆 ' + esc(F.cafes[h.top].name) + '</span></div>').join('') + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Cinayet Gecesi ---------- */

function cinChar(C, id) {
  return CIN_CHARS[C.chars[id]];
}

function cinSuspects(s, showDeclared = true) {
  const C = s.cin;
  return '<div class="cinsus">' + s.roster.map((id) => {
    const ch = cinChar(C, id);
    const d = C.declared[id];
    const where = !showDeclared ? '' : d == null || d === -2 ? '<span class="muted">ifade bekleniyor…</span>' : d === -1 ? '<span class="muted">ifade vermedi 🤐</span>' : '📍 ' + esc(CIN_ROOMS[d].n);
    return '<div class="cinp"><div class="top">' + avatarHTML(nameOf(id), 'sm') + '<b>' + esc(nameOf(id).name) + '</b><span class="role">' + ch.e + ' ' + esc(ch.n) + '</span></div>' +
      '<div class="tr">' + C.traits[id].map((t) => '<span title="' + esc(CIN_TRAITS[t].n) + '">' + CIN_TRAITS[t].e + ' ' + esc(CIN_TRAITS[t].n) + '</span>').join('') + '</div>' +
      (where ? '<div class="where">' + where + '</div>' : '') + '</div>';
  }).join('') + '</div>';
}

function cinMyCard(s) {
  const C = s.cin;
  const me = C.me;
  if (!me) return '';
  const ch = cinChar(C, s.you);
  const fact = me.killer
    ? '<div class="cinsecret killer"><b>🔪 Katil sensin!</b><br>' + CIN_ROOMS[me.crime.room].de + ', ' + CIN_WEAPONS[me.crime.weapon].e + ' ' + esc(CIN_WEAPONS[me.crime.weapon].n) + ' ile.<br><small>Yakalanmamak için yalan söyle, şüpheyi başkasına çek.</small></div>'
    : '<div class="cinsecret"><b>😇 Masumsun.</b><br>Saat 23:00\'te buradaydın: <b>' + esc(CIN_ROOMS[me.truth].n) + '</b>. ' +
      (me.with.length ? 'Yanında: <b>' + me.with.map((id) => esc(nameOf(id).name)).join(', ') + '</b>' : 'Yalnızdın.') + '</div>';
  return '<div class="card cinme"><div class="cinrole">' + ch.e + '</div><div><div class="muted" style="font-size:13px;font-weight:700">Senin karakterin</div><h2 style="margin:0">' + esc(ch.n) + '</h2>' +
    '<p class="muted" style="margin:4px 0 0;font-size:14px">Gizli sebebin: ' + esc(ch.m) + '</p></div>' + fact + '</div>';
}

function cinClues(s) {
  const C = s.cin;
  const pub = C.events.map((e) => '<div class="cinclue ' + (e.pub ? 'pub' : 'event') + '"><span class="r">Tur ' + e.round + '</span>' + esc(e.text) + '</div>').join('');
  const mine = C.myClues.map((c) => '<div class="cinclue mine"><span class="r">Tur ' + c.round + '</span>' + esc(c.text) + '</div>').join('');
  return '<div class="card"><h2>📰 Herkesin bildiği</h2>' + (pub || '<p class="muted" style="margin:0">Henüz yok.</p>') + '</div>' +
    '<div class="card cinpriv"><h2>🤫 Sadece senin bildiğin</h2>' + (mine || '<p class="muted" style="margin:0">Henüz yok.</p>') +
    '<p class="muted" style="margin:8px 0 0;font-size:13px">İstersen anlat, istersen sakla. Ama dikkat: katil de yalan söyleyebilir!</p></div>';
}

Views['cin:intro'] = {
  mount(s) {
    const C = s.cin;
    App.cinRoom = null;
    const me = C.me;
    const story = '<div class="card cinstory"><div class="cinbig">🏚️</div><p>Fırtınalı bir gece, ' + esc(C.place) + ' herkes ' + esc(C.victim) + ' tarafından davet edilmişti. ' +
      'Saat 23:00 sularında bir çığlık duyuldu… <b>' + esc(C.victim) + ' öldürülmüştü.</b> Kapılar kilitli, kimse dışarı çıkamıyor. Katil aranızda!</p></div>';
    const pick = me ? '<div class="card"><h2>🗣️ İfaden: Saat 23:00\'te neredeydin?</h2>' +
      '<p class="muted" style="margin:0 0 10px;font-size:14px">' + (me.killer ? 'Yalan söylemen lazım! Ama dolu bir oda seçersen oradakiler yalanını anlar.' : 'Doğruyu söylemen herkesin işine yarar (ama istersen yalan da söyleyebilirsin).') + '</p>' +
      '<div class="cinrooms">' + CIN_ROOMS.map((rm, i) => '<button class="vt ' + (!me.killer && me.truth === i ? 'hint' : '') + '" data-act="cAlibi" data-r="' + i + '">' + esc(rm.n) + '</button>').join('') + '</div>' +
      '<button class="btn yellow big block" id="cinSay" data-act="cSay" style="margin-top:12px" disabled>Önce bir oda seç</button>' +
      '<p class="muted center" style="margin:6px 0 0;font-size:13px">İfaden kayda geçer, sonradan değiştirilemez.</p>' +
      '<p class="center" id="cinMine" style="margin:10px 0 0;font-weight:800"></p></div>' : '';
    mount(header() + timerHTML('İfade süresi') + story + cinMyCard(s) + pick +
      '<div class="card"><h2>Şüpheliler</h2>' + cinSuspects(s, false) + '</div>' +
      '<div class="card"><h2>Kim ifade verdi?</h2><div class="chips" id="cinChips"></div></div>' + hostSkip('Soruşturmayı başlat'));
    Sound.beep(196, 0.5, 'sawtooth', 0.04);
  },
  update(s) {
    const C = s.cin;
    $('#cinChips').innerHTML = doneChips(s, C.done);
    const d = C.declared[s.you];
    if ($('#cinMine')) $('#cinMine').textContent = d != null && d >= 0 ? '✅ İfaden kayda geçti: ' + CIN_ROOMS[d].n : '';
    if (d != null && d >= 0) {
      $$('[data-act=cAlibi]').forEach((b) => { b.disabled = true; b.classList.toggle('on', Number(b.dataset.r) === d); });
      if ($('#cinSay')) $('#cinSay').hidden = true;
    }
  },
};

Views['cin:round'] = {
  mount(s) {
    const C = s.cin;
    App.cinEvents = C.events.length;
    const me = C.me;
    const frame = me && me.killer ? '<div class="card cinkill"><h2>🧣 İftira at (oyunda 1 kez)</h2>' +
      (me.canFrame ? '<p class="muted" style="margin:0 0 8px;font-size:14px">Olay yerine birinin baş harfi işli bir mendil bırak. Herkes bunu ipucu sanacak!</p><div class="row"><select id="cinFrame" class="field grow"><option value="">Kimin üzerine?</option>' +
        s.roster.filter((id) => id !== s.you).map((id) => '<option value="' + esc(id) + '">' + esc(nameOf(id).name) + '</option>').join('') + '</select><button class="btn" data-act="cFrame">Mendili bırak (tek hakkın)</button></div>'
        : '<p class="muted" style="margin:0">İftira hakkını kullandın 😈</p>') + '</div>' : '';
    mount(header() + timerHTML('Konuşma süresi') +
      '<div class="vbar night cinbar"><b>🕵️ Soruşturma · Tur ' + C.round + ' / ' + C.rounds + '</b><span>' + (C.round < C.rounds ? 'Sonra yeni ipuçları gelecek' : 'Son tur! Sonra suçlama') + '</span></div>' +
      cinMyCard(s) + '<div id="cinClueBox">' + cinClues(s) + '</div>' + frame +
      '<div class="card"><h2>Şüpheliler ve ifadeleri</h2>' + cinSuspects(s) + '</div>' +
      '<div class="card center"><p class="muted" style="margin:0 0 10px">Konuşun, sorgulayın, çelişkileri yakalayın. Herkes hazır olunca sonraki tura geçilir.</p>' +
        '<button class="btn yellow big block" data-act="cReady" id="cinReady"></button><div class="chips" id="cinChips" style="margin-top:10px;justify-content:center"></div></div>' +
      hostSkip(C.round < C.rounds ? 'Sonraki tura geç' : 'Suçlamaya geç'));
    Sound.beep(523, 0.15, 'triangle', 0.06);
  },
  update(s) {
    const C = s.cin;
    $('#cinReady').textContent = C.ready ? '⏳ Hazırsın (geri al)' : C.round < C.rounds ? '✅ Hazırım, sonraki tur' : '✅ Hazırım, suçlamaya geçelim';
    $('#cinChips').innerHTML = doneChips(s, C.done);
    // A planted clue (the killer's handkerchief) shows up for everyone right away.
    const key = C.events.length;
    if (App.cinEvents != null && key > App.cinEvents) {
      $('#cinClueBox').innerHTML = cinClues(s);
      toast('🧣 Yeni bir delil bulundu!', 3000);
      Sound.beep(330, 0.3, 'sawtooth', 0.05);
    }
    App.cinEvents = key;
  },
};

function cinVotePaint() {
  $$('[data-act=cSus]').forEach((b) => b.classList.toggle('on', b.dataset.id === App.cinSus));
  $$('[data-act=cWeapon]').forEach((b) => b.classList.toggle('on', Number(b.dataset.w) === App.cinW));
}

Views['cin:accuse'] = {
  mount(s) {
    const C = s.cin;
    App.cinSus = C.myVote ? C.myVote.s : null;
    App.cinW = C.myVote ? C.myVote.w : null;
    mount(header() + timerHTML('Suçlama süresi') +
      '<div class="phase-title"><h1>⚖️ Suçlama zamanı!</h1><p>Katil kim, cinayet hangi silahla işlendi? En çok oyu alan tutuklanır.</p></div>' +
      cinClues(s) +
      '<div class="card"><h2>🔎 Katil kim?</h2><div class="vtargets">' + s.roster.filter((id) => id !== s.you).map((id) => '<button class="vt" data-act="cSus" data-id="' + esc(id) + '">' +
        avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + ' <small class="muted">' + cinChar(C, id).e + '</small></button>').join('') + '</div>' +
        '<h2 style="margin-top:16px">🗡️ Hangi silah?</h2><div class="vtargets">' + CIN_WEAPONS.map((w, i) => '<button class="vt" data-act="cWeapon" data-w="' + i + '">' + w.e + ' ' + esc(w.n) + '</button>').join('') + '</div>' +
        '<button class="btn yellow big block" data-act="cVote" style="margin-top:14px">⚖️ Suçla!</button><p class="center muted" id="cinVoted" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Şüpheliler ve ifadeleri</h2>' + cinSuspects(s) + '</div>' +
      '<div class="card"><h2>Kim oy verdi?</h2><div class="chips" id="cinChips"></div></div>' + hostSkip('Sonucu aç'));
    cinVotePaint();
    Sound.join();
  },
  update(s) {
    $('#cinChips').innerHTML = doneChips(s, s.cin.done);
    $('#cinVoted').textContent = s.cin.myVote ? '✅ Oyun kaydedildi (değiştirebilirsin)' : '';
  },
};

function cinFinalMount(s) {
  const F = s.final;
  const k = F.killer;
  const kc = CIN_CHARS[F.chars[k]];
  const w = CIN_WEAPONS[F.weapon];
  const rows = s.roster.map((id) => {
    const lied = F.declared[id] !== F.truth[id];
    const d = F.declared[id];
    return '<div class="srow ' + (id === k ? 'killer' : '') + '">' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + ' · ' + CIN_CHARS[F.chars[id]].e + ' ' + esc(CIN_CHARS[F.chars[id]].n) +
      '<small>Gerçekte: ' + esc(CIN_ROOMS[F.truth[id]].n) + ' · Dediği: ' + (d >= 0 ? esc(CIN_ROOMS[d].n) : 'ifade yok') + (lied && d >= 0 ? ' 🤥' : '') +
      ' · Oyu: ' + (F.votes[id] ? esc(nameOf(F.votes[id].s).name) + ', ' + CIN_WEAPONS[F.votes[id].w].e : '—') + '</small></span><b>' + F.scores[id] + '</b></div>';
  }).join('');
  const story = F.events.map((e) => '<div><span class="q">Tur ' + e.round + '</span><span class="w">' + esc(e.text) + '</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title"><h1>' + (F.caught ? '🕵️ Katil yakalandı!' : '🔪 Katil kaçtı!') + '</h1><p>' +
      (F.caught ? 'Dedektifler işini yaptı.' : 'Masumlardan biri tutuklandı, gerçek katil gecenin karanlığında kayboldu…') + '</p></div>' +
    '<div class="card center cinsolve"><div class="muted" style="font-weight:700">Gerçek</div>' +
      '<div class="cinbig">' + kc.e + '</div><h2 style="margin:0">' + esc(nameOf(k).name) + ' · ' + esc(kc.n) + '</h2>' +
      '<p style="margin:8px 0 0">' + esc(F.victim) + ', ' + CIN_ROOMS[F.room].de + ', ' + w.e + ' ' + esc(w.n) + ' ile öldürüldü.</p>' +
      '<p class="muted" style="margin:6px 0 0;font-size:14px">Sebebi: ' + esc(kc.m) + '</p></div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Herkes nerede, ne dedi?</h2><div class="board">' + rows + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Katil yakalanırsa her masum +' + CIN_WIN_POINTS + ' · Katili doğru gösteren +' + CIN_VOTE_POINTS + ' · Silahı da bilen +' + CIN_WEAPON_POINTS +
      ' · Kaçan katil +' + CIN_ESCAPE_POINTS + ' ve kandırdığı her oy için +' + CIN_DODGE_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün deliller</h2><div class="recap">' + story + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Bilgi Yarışması ---------- */

const QUIZ_SHAPES = ['▲', '◆', '●', '■'];

// Leaflet (the map library) is only loaded when the first map question shows up.
function loadLeaflet() {
  if (window.L) return Promise.resolve();
  if (!App.leafletP) {
    App.leafletP = new Promise((ok, fail) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css';
      document.head.appendChild(css);
      const js = document.createElement('script');
      js.src = 'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js';
      js.onload = ok;
      js.onerror = () => { App.leafletP = null; fail(); };
      document.head.appendChild(js);
    });
  }
  return App.leafletP;
}

function quizMakeMap(el, tr) {
  if (App.qmap && !App.qmap.getContainer().isConnected) { try { App.qmap.remove(); } catch { /* old map */ } }
  const m = L.map(el, { worldCopyJump: true, minZoom: 1, attributionControl: true }).setView(tr ? [39, 35] : [25, 10], tr ? 5 : 1);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 18, attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
  }).addTo(m);
  App.qmap = m;
  return m;
}

function quizPin(id, cls = '') {
  return L.divIcon({ className: 'qpin ' + cls, html: avatarHTML(nameOf(id), 'sm'), iconSize: [30, 30], iconAnchor: [15, 15] });
}

function quizTop(s, timer) {
  const Q = s.quiz;
  return header() + timer + stepDots(Q.qi, Q.qn) +
    '<div class="card qcard quizq"><div class="meta">' + esc(Q.q.cat) + ' · Soru ' + (Q.qi + 1) + ' / ' + Q.qn + '</div><div class="qtext">' + esc(Q.q.text) + '</div>' +
    (Q.q.img ? '<div class="qimg"><img src="' + esc(Q.q.img) + '" alt="" referrerpolicy="no-referrer"></div><div class="qcredit">📷 Wikimedia Commons</div>' : '') + '</div>';
}

Views['quiz:q'] = {
  mount(s) {
    const Q = s.quiz;
    App.qPin = null;
    let body;
    if (Q.q.type === 'map') {
      body = '<div class="card"><div class="qmap" id="qmap"><div class="muted center" style="padding-top:40%">Harita yükleniyor…</div></div>' +
        '<button class="btn yellow big block" id="qmapSend" data-act="qMapSend" style="margin-top:10px" disabled>📍 Haritaya dokun, sonra burayı seç</button></div>';
    } else {
      body = '<div class="qopts">' + Q.q.opts.map((o, i) => '<button class="qopt c' + i + '" data-act="qPick" data-i="' + i + '"><span class="sh">' + QUIZ_SHAPES[i] + '</span>' + esc(o) + '</button>').join('') + '</div>';
    }
    mount(quizTop(s, timerHTML(Q.q.type === 'map' ? 'İşaretleme süresi' : 'Cevap süresi')) + body +
      '<p class="muted center" id="qWait" style="margin:10px 0"></p><div class="card"><h2>Kim cevapladı?</h2><div class="chips" id="qChips"></div></div>' + hostSkip('Cevabı aç'));
    if (Q.q.type === 'map') {
      const el = $('#qmap');
      loadLeaflet().then(() => {
        if (!el.isConnected || el._map || App.state.quiz.qi !== Q.qi || App.state.quiz.step !== 'q') return;
        el.innerHTML = '';
        const m = quizMakeMap(el, Q.q.tr);
        el._map = m;
        if (window.ResizeObserver) new ResizeObserver(() => m.invalidateSize()).observe(el); else setTimeout(() => m.invalidateSize(), 300);
        let marker = null;
        const mine = App.state.quiz.myAns;
        if (mine) marker = L.marker([mine.lat, mine.lng], { icon: quizPin(s.you, 'me') }).addTo(m);
        m.on('click', (e) => {
          if (App.state.quiz.myAns) return;
          App.qPin = e.latlng.wrap();
          if (marker) marker.setLatLng(e.latlng); else marker = L.marker(e.latlng, { icon: quizPin(s.you, 'me') }).addTo(m);
          const b = $('#qmapSend');
          b.disabled = false;
          b.textContent = '📍 Burayı seç';
        });
      }).catch(() => { const el = $('#qmap'); if (el) el.innerHTML = '<p class="muted center">Harita yüklenemedi 😕 İnternet bağlantını kontrol et.</p>'; });
    }
    Sound.beep(740, 0.1, 'triangle', 0.05);
  },
  update(s) {
    const Q = s.quiz;
    $('#qChips').innerHTML = doneChips(s, Q.done);
    const a = Q.myAns;
    if (a && Q.q.type !== 'map') $$('.qopt').forEach((b) => { b.disabled = true; b.classList.toggle('picked', Number(b.dataset.i) === a.i); });
    if (a && $('#qmapSend')) { $('#qmapSend').disabled = true; $('#qmapSend').textContent = '✅ Seçimin gönderildi'; }
    $('#qWait').textContent = a ? '✅ Cevabın alındı! Diğerleri bekleniyor…' : '';
  },
};

Views['quiz:reveal'] = {
  mount(s) {
    const Q = s.quiz;
    const R = Q.result;
    const last = Q.qi >= Q.qn - 1;
    let body;
    if (Q.q.type === 'map') {
      const rows = Object.keys(R.pins).sort((a, b) => R.pins[a].km - R.pins[b].km).map((id) => '<div class="srow">' + avatarHTML(nameOf(id), 'sm') +
        '<span class="nm">' + esc(nameOf(id).name) + '<small>' + R.pins[id].km.toLocaleString('tr-TR') + ' km uzakta</small></span>' + (R.pins[id].pts ? '<span class="dl">+' + R.pins[id].pts + '</span>' : '') + '</div>').join('');
      body = '<div class="card"><div class="qanswer">📍 ' + esc(R.place) + '</div><div class="qmap" id="qmapR"></div>' +
        '<div class="board" style="margin-top:10px">' + (rows || '<p class="muted" style="margin:0">Kimse işaretlemedi.</p>') + '</div></div>';
    } else {
      body = (Q.q.type === 'photo' ? '<div class="qanswer">📍 ' + esc(R.place) + '</div>' : '') + '<div class="qopts reveal">' + Q.q.opts.map((o, i) => {
        const who = Object.keys(R.picks).filter((id) => R.picks[id] === i);
        return '<div class="qopt c' + i + (i === R.ans ? ' right' : ' wrong') + '"><span class="sh">' + (i === R.ans ? '✅' : QUIZ_SHAPES[i]) + '</span><span class="tx">' + esc(o) + '</span>' +
          '<span class="qwho">' + who.map((id) => avatarHTML(nameOf(id), 'sm')).join('') + '</span></div>';
      }).join('') + '</div>';
    }
    const me = R.delta[s.you];
    mount(quizTop(s, revealTimer(s)) + body +
      (s.roster.includes(s.you) ? '<div class="qme ' + (me ? 'ok' : 'no') + '">' + (me ? '🎉 +' + me + ' puan!' : Q.q.type === 'map' ? '😅 Bu sefer çok uzaktın' : '😅 Bu sefer olmadı') + '</div>' : '') +
      '<div class="card"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sonraki soru ▶'));
    if (Q.nextImg) { const im = new Image(); im.src = Q.nextImg; }
    if (Q.q.type === 'map') {
      const el = $('#qmapR');
      loadLeaflet().then(() => {
        if (!el.isConnected || el._map) return;
        const m = quizMakeMap(el, Q.q.tr);
        el._map = m;
        const truth = [R.lat, R.lng];
        L.marker(truth, { icon: L.divIcon({ className: 'qpin truth', html: '⭐', iconSize: [34, 34], iconAnchor: [17, 17] }) }).addTo(m);
        const pts = [truth];
        for (const [id, p] of Object.entries(R.pins)) {
          L.polyline([truth, [p.lat, p.lng]], { color: '#6c3cf0', weight: 2, dashArray: '6 6' }).addTo(m);
          L.marker([p.lat, p.lng], { icon: quizPin(id, id === s.you ? 'me' : '') }).addTo(m);
          pts.push([p.lat, p.lng]);
        }
        // Let the box settle first, otherwise Leaflet measures a zero-size map and zooms to the wrong spot.
        const frame = () => {
          m.invalidateSize();
          if (pts.length > 1) m.fitBounds(L.latLngBounds(pts), { padding: [30, 30], maxZoom: 7, animate: false }); else m.setView(truth, Q.q.tr ? 6 : 4, { animate: false });
        };
        // Fit again whenever the box gets its real size (it can be 0×0 for a moment while the page settles).
        if (window.ResizeObserver) new ResizeObserver(() => { if (el.clientWidth) frame(); }).observe(el);
        else { frame(); setTimeout(frame, 300); }
      }).catch(() => {});
    }
    Sound.beep(me ? 988 : 330, 0.2, 'triangle', 0.08);
  },
};

function quizFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.right[id] + ' doğru cevap' + (F.mapPts[id] ? ' · haritadan ' + F.mapPts[id] + ' puan' : '') + '</small></span><b>' + F.scores[id] + '</b></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'yarışmanın birincisi 🧠') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Doğru cevap +' + QUIZ_BASE + ' ve hızına göre +' + QUIZ_SPEED + "'e kadar · Haritada ne kadar yakınsan o kadar puan (en fazla 1000)</p></div>" +
    finalFooter(),
    true
  );
}

/* ---------- Taklitçi ---------- */

function takRoleCard(T) {
  if (!T.myTarget) return '';
  const t = nameOf(T.myTarget);
  return '<div class="card takrole"><div class="takmask">🥸</div><div><div class="muted" style="font-weight:700;font-size:14px">Gizli rolün</div>' +
    '<div class="takwho">' + avatarHTML(t) + '<b>' + esc(t.name) + '</b> rolündesin</div>' +
    '<small class="muted">Kimse bilmiyor 🤫 Seni kimin oynadığını da sen bilmiyorsun!</small></div></div>';
}

function takQuestion(T) {
  return '<div class="card qcard"><div class="meta">Soru ' + (Math.min(T.ri, T.rn - 1) + 1) + ' / ' + T.rn + '</div><div class="qtext">' + esc(T.q) + '</div></div>';
}

Views['tak:write'] = {
  mount(s) {
    const T = s.tak;
    if (!T.myTarget) { mount(header() + takQuestion(T) + '<div class="waiting-pill">Oyuncular yazıyor…</div>'); return; }
    const t = nameOf(T.myTarget);
    mount(header() + timerHTML('Yazma süresi') + stepDots(T.ri, T.rn) + takRoleCard(T) + takQuestion(T) +
      '<div class="card"><label class="lbl" for="takReal">1) Senin gerçek cevabın</label>' +
        '<textarea id="takReal" class="field tarea" maxlength="' + TAK_MAX + '" rows="2" placeholder="Sen ne dersin?"></textarea>' +
        '<label class="lbl" for="takFake" style="margin-top:14px">2) 🥸 Taklit: ' + esc(t.name) + ' olsa ne derdi?</label>' +
        '<textarea id="takFake" class="field tarea fake" maxlength="' + TAK_MAX + '" rows="2" placeholder="Onun ağzından, onun gibi yaz…"></textarea>' +
        '<p class="muted" style="margin:8px 0 0;font-size:13px">💡 Kendi yazı tarzını belli etme! Taklit cevap, gerçek cevabın yanında gösterilecek.</p>' +
        '<button class="btn green big block" data-act="takSend" style="margin-top:12px">✅ Gönder</button>' +
        '<p class="muted center" id="takMine" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Kim bitirdi?</h2><div class="chips" id="takChips"></div></div>' + hostSkip('Oylamaya geç'));
    if (T.mine) { $('#takReal').value = T.mine.real; $('#takFake').value = T.mine.fake; } else focusFine('#takReal');
    if (T.ri === 0) Sound.join();
  },
  update(s) {
    if (!$('#takChips')) return;
    $('#takChips').innerHTML = doneChips(s, s.tak.done);
    $('#takMine').textContent = s.tak.mine ? '✅ Gönderildi (istersen değiştirip tekrar gönderebilirsin)' : '';
  },
};

Views['tak:vote'] = {
  mount(s) {
    const T = s.tak;
    const cards = T.cards.map((c) => {
      const p = nameOf(c.subject);
      const own = c.subject === s.you;
      return '<div class="card takcard"><div class="takwho">' + avatarHTML(p) + (own ? '<b>Senin kartın</b>' : '<span>Hangisi gerçek <b>' + esc(p.name) + '</b>?</span>') + '</div>' +
        '<div class="takopts">' + c.opts.map((o, i) => (own ? '<div class="ansb mine">' + esc(o) + '</div>'
          : '<button class="ansb" data-act="takVote" data-s="' + esc(c.subject) + '" data-i="' + i + '">' + esc(o) + '</button>')).join('') + '</div>' +
        (own ? '<p class="muted center" style="margin:8px 0 0;font-size:14px">👀 Biri senin taklidin! Bakalım seni tanıyorlar mı?</p>' : '') + '</div>';
    }).join('');
    mount(header() + timerHTML('Oylama süresi') + stepDots(T.ri, T.rn) + takQuestion(T) +
      '<p class="muted center" style="margin:0 0 12px">Her kartta biri gerçek cevap, biri taklit. Gerçeği bul! 🔍</p>' + cards +
      '<div class="card"><h2>Kim oyladı?</h2><div class="chips" id="takChips"></div></div>' + hostSkip('Sonuçları aç'));
    Sound.beep(660, 0.12, 'triangle', 0.06);
  },
  update(s) {
    const T = s.tak;
    $$('[data-act=takVote]').forEach((b) => b.classList.toggle('picked', T.myVotes[b.dataset.s] === Number(b.dataset.i)));
    $('#takChips').innerHTML = doneChips(s, T.done);
  },
};

Views['tak:reveal'] = {
  mount(s) {
    const T = s.tak;
    const R = T.result;
    const last = T.ri >= T.rn - 1;
    const cards = R.cards.map((c, k) => {
      const p = nameOf(c.subject);
      const opt = (i) => {
        const real = i === c.realIdx;
        const vs = Object.keys(c.picks).filter((v) => c.picks[v] === i);
        return '<div class="takres ' + (real ? 'real' : 'fake') + '"><div class="tag">' + (real ? '✅ Gerçek' : '🥸 Taklit') + '</div><div class="t">' + esc(c.opts[i]) + '</div>' +
          '<div class="voters">' + (vs.length ? vs.map((v) => '<span class="chip">' + avatarHTML(nameOf(v), 'sm') + esc(nameOf(v).name) + '</span>').join('') : '<span class="muted">kimse seçmedi</span>') + '</div></div>';
      };
      const total = Object.keys(c.picks).length;
      const line = !total ? 'Kimse oy vermedi' : c.fooled ? '🥸 Taklitçi ' + c.fooled + ' kişiyi kandırdı!' : '🔍 Herkes gerçeği buldu';
      return '<div class="card takcard takpop" style="--d:' + (0.2 + k * 0.45).toFixed(2) + 's"><div class="takwho">' + avatarHTML(p) + '<b>' + esc(p.name) + '</b></div>' +
        opt(0) + opt(1) + '<div class="takline">' + line + '</div></div>';
    }).join('');
    mount(header() + revealTimer(s) + stepDots(T.ri, T.rn) +
      '<div class="card qcard"><div class="meta">Soru ' + (T.ri + 1) + ' / ' + T.rn + '</div><div class="qtext">' + esc(R.q) + '</div></div>' + cards +
      (T.myTarget ? '<div class="card center takme"><b>Bu tur: +' + T.myDelta + '</b> · Toplam puanın: <b>' + T.myScore + '</b>' +
        '<p class="muted" style="margin:6px 0 0;font-size:14px">🤫 Herkesin puanı maskeler düşünce açıklanacak (yoksa taklitçiler belli olurdu!)</p></div>' : '') +
      hostNext(s, last ? '🥸 Son tahmine geç' : 'Sonraki soru ▶'));
    Sound.beep(880, 0.15, 'triangle', 0.07);
  },
};

Views['tak:guess'] = {
  mount(s) {
    const T = s.tak;
    const clues = (T.aboutMe || []).map((c) => '<div class="takclue"><div class="muted" style="font-size:14px">' + esc(c.q) + '</div><div><b>🥸 "' + esc(c.text) + '"</b></div>' +
      (c.fooled ? '<small>' + c.fooled + ' kişi bunu senin cevabın sandı</small>' : '') + '</div>').join('');
    const others = s.roster.filter((id) => id !== s.you);
    mount(header() + timerHTML('Tahmin süresi') +
      '<div class="phase-title"><h1>Seni kim oynadı? 🥸</h1><p>Bütün oyun boyunca biri senin kılığındaydı. Bulursan +' + TAK_GUESS_POINTS + '!</p></div>' +
      (clues ? '<div class="card"><h2>Senin ağzından yazılanlar</h2>' + clues + '</div>' : '') +
      (T.myTarget ? '<div class="card"><h2>Tahminin</h2><div class="vtargets">' + others.map((id) => '<button class="vt" data-act="takGuess" data-id="' + esc(id) + '">' +
        avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</button>').join('') + '</div></div>' : '') +
      '<div class="card"><h2>Kim tahmin etti?</h2><div class="chips" id="takChips"></div></div>' + hostSkip('Maskeleri düşür'));
    Sound.join();
  },
  update(s) {
    $$('[data-act=takGuess]').forEach((b) => b.classList.toggle('on', s.tak.myGuess === b.dataset.id));
    $('#takChips').innerHTML = doneChips(s, s.tak.done);
  },
};

Views['tak:unmask'] = {
  mount(s) {
    const U = s.tak.unmask;
    const STEP = 1.1;
    const rows = U.rows.map((u, k) => '<div class="takun" style="--d:' + (0.6 + k * STEP).toFixed(2) + 's">' +
      '<div class="who">' + avatarHTML(nameOf(u.subject), 'sm') + '<span><b>' + esc(nameOf(u.subject).name) + '</b> rolünde…</span></div>' +
      '<div class="imp">🥸 ' + avatarHTML(nameOf(u.imp), 'sm') + '<b>' + esc(nameOf(u.imp).name) + '</b></div>' +
      '<div class="res">' + (u.right ? '✅ ' + esc(nameOf(u.subject).name) + ' buldu! +' + TAK_GUESS_POINTS
        : (u.guess ? '❌ Tahmin: ' + esc(nameOf(u.guess).name) : '❌ Tahmin yok') + ' · ' + esc(nameOf(u.imp).name) + ' gizli kaldı +' + TAK_HIDDEN_POINTS) + '</div></div>').join('');
    const after = 0.6 + U.rows.length * STEP;
    mount(header() + revealTimer(s) +
      '<div class="phase-title"><h1>Maskeler düşüyor! 🥸</h1><p>Kim kimin kılığındaydı?</p></div><div class="card">' + rows + '</div>' +
      '<div class="card kafter" style="--d:' + after.toFixed(2) + 's"><h2>Puanlar açıklandı!</h2>' + scoreBoard(s, U.scores, U.delta) + '</div>' +
      hostNext(s, '🏆 Sonuçlar'));
    U.rows.forEach((u, k) => setTimeout(() => Sound.beep(u.right ? 988 : 330, 0.15, 'triangle', 0.07), (0.6 + k * STEP) * 1000 + 300));
  },
};

function takFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.found[id] + ' kez gerçeği buldu · taklidiyle ' + F.fooled[id] + ' kişiyi kandırdı' +
    (F.caught[id] ? ' · maskesi düştü' : ' · hiç yakalanmadı 🥸') + '</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const pairs = s.roster.filter((id) => F.target[id]).map((id) => '<div><span class="q"><b>' + esc(nameOf(id).name) + '</b></span><span class="w">🥸 ' +
    esc(nameOf(F.target[id]).name) + ' rolündeydi</span></div>').join('');
  const best = F.best ? '<div class="card center takbest"><h2>🏆 En inandırıcı taklit</h2><div class="muted">' + esc(F.best.q) + '</div>' +
    '<div class="qtext" style="margin:8px 0">"' + esc(F.best.text) + '"</div><div>' + esc(nameOf(F.best.imp).name) + ', ' + esc(nameOf(F.best.subject).name) +
    ' rolünde · ' + F.best.fooled + ' kişi gerçek sandı</div></div>' : '';
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'usta taklitçi 🥸') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Gerçeği bulmak +' + TAK_REAL_POINTS + ' · Taklidinle kandırdığın her kişi +' + TAK_FOOL_POINTS +
      ' · Seni oynayanı bulmak +' + TAK_GUESS_POINTS + ' · Hiç yakalanmamak +' + TAK_HIDDEN_POINTS + '</p></div>' +
    best + '<div class="card"><h2>Kim kimi oynadı?</h2><div class="recap">' + pairs + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Yalan Zar ---------- */

const DIE_PIPS = { 1: [4], 2: [0, 8], 3: [0, 4, 8], 4: [0, 2, 6, 8], 5: [0, 2, 4, 6, 8], 6: [0, 2, 3, 5, 6, 8] };

// A real-looking die drawn with pips (the ⚀ characters are tiny in most fonts).
function dieHTML(f, cls = '', joker = true) {
  let pips = '';
  for (let i = 0; i < 9; i++) pips += '<i' + (DIE_PIPS[f].includes(i) ? ' class="p"' : '') + '></i>';
  return '<span class="die ' + cls + (f === 1 && joker ? ' joker' : '') + '">' + pips + '</span>';
}

function zarBidText(b) {
  return '<b>' + b.q + '</b> tane ' + dieHTML(b.f, 'sm');
}

function zarTable(s, showTurn) {
  const Z = s.zar;
  return '<div class="ztable">' + Z.seats.map((id) => '<span class="zp ' + (Z.counts[id] ? '' : 'out') + (showTurn && Z.turn === id ? ' turn' : '') + '">' +
    avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + ' <b>' + (Z.counts[id] ? '🎲×' + Z.counts[id] : '💀') + '</b></span>').join('') + '</div>';
}

function zarPaint() {
  const Z = App.state.zar;
  const box = $('#zarBox');
  if (!box) return;
  const minF = Z.jokers ? 2 : 1;
  const ok = (q, f) => !Z.bid || q > Z.bid.q || (q === Z.bid.q && f > Z.bid.f);
  if (!ok(App.zarQ, App.zarF) && !Z.bid) App.zarQ = 1;
  const mine = Z.myDice.filter((d) => d === App.zarF || (Z.jokers && d === 1)).length;
  box.innerHTML = '<div class="lbl">Senin iddian: masada en az…</div>' +
    '<div class="cogpred"><button class="btn ghost" data-act="zQ" data-d="-1">−</button><span>' + App.zarQ + '</span><button class="btn ghost" data-act="zQ" data-d="1">+</button></div>' +
    '<div class="zfaces">' + [1, 2, 3, 4, 5, 6].filter((f) => f >= minF).map((f) => '<button class="zface ' + (App.zarF === f ? 'on' : '') + '" data-act="zF" data-f="' + f + '">' + dieHTML(f, 'md', Z.jokers) + '</button>').join('') + '</div>' +
    '<p class="muted center" style="margin:6px 0 0;font-size:14px">Senin elinde bundan ' + mine + ' tane var' + (Z.jokers ? ' (1\'ler dahil)' : '') + '</p>' +
    '<button class="btn yellow big block" data-act="zBid" style="margin-top:10px"' + (ok(App.zarQ, App.zarF) ? '' : ' disabled') + '>📢 ' + App.zarQ + ' tane ' + dieHTML(App.zarF, 'sm', false) + ' var!</button>' +
    (Z.bid ? '<button class="btn big block zcall" data-act="zCall" style="margin-top:10px">🤥 Yalan!</button>' : '') +
    (!ok(App.zarQ, App.zarF) ? '<p class="muted center" style="margin:6px 0 0;font-size:13px">Önceki iddiadan yüksek olmalı: ya daha çok sayı ya da aynı sayıda daha büyük zar.</p>' : '');
}

Views['zar:bid'] = {
  mount(s) {
    const Z = s.zar;
    App.zarSeen = '';
    mount(header() + timerHTML('Hamle süresi') +
      '<div class="vbar night zbar"><b>🎲 El ' + Z.round + '</b><span>Masada toplam ' + Z.total + ' zar</span></div>' +
      '<div class="card center"><h2 style="margin:0 0 6px">Senin zarların 🤫</h2><div class="zmine">' +
        (Z.myDice.length ? Z.myDice.map((d) => dieHTML(d)).join('') : '<span class="muted">Zarın kalmadı, izliyorsun 👀</span>') + '</div>' +
        (Z.jokers ? '<p class="muted" style="margin:6px 0 0;font-size:13px">' + dieHTML(1, 'xs') + ' joker: her sayı yerine geçer</p>' : '') + '</div>' +
      '<div class="card"><div class="zbid" id="zarBid"></div><div id="zarBox"></div><div class="zhist" id="zarHist"></div></div>' +
      '<div class="card"><h2>Masa</h2><div id="zarTable"></div></div>' + OFFLINE_NOTE + hostSkip('Sırayı geç (en küçük artış)'));
  },
  update(s) {
    const Z = s.zar;
    const key = JSON.stringify([Z.bid, Z.turn]);
    if (key !== App.zarSeen) {
      App.zarSeen = key;
      $('#zarBid').innerHTML = Z.bid ? '<div class="muted">Son iddia · ' + esc(nameOf(Z.bid.id).name) + '</div><div class="zbig">' + zarBidText(Z.bid) + ' var!</div>'
        : '<div class="muted">Henüz iddia yok</div>';
      $('#zarHist').innerHTML = Z.bids.length > 1 ? Z.bids.slice(0, -1).reverse().map((b) => '<div>' + esc(nameOf(b.id).name) + ': ' + zarBidText(b) + '</div>').join('') : '';
      if (Z.myTurn) {
        App.zarQ = Z.bid ? Z.bid.q : 1;
        App.zarF = Z.bid ? Math.min(6, Z.bid.f + (Z.bid.f < 6 ? 1 : 0)) : (Z.jokers ? 2 : 1);
        if (Z.bid && Z.bid.f === 6) { App.zarQ = Z.bid.q + 1; App.zarF = Z.jokers ? 2 : 1; }
        App.zarQ = Math.min(App.zarQ, Z.total);
        zarPaint();
        Sound.join();
        if (App.chatOpen) toast('🎤 Sıra sende!', 2500);
      } else {
        $('#zarBox').innerHTML = '<div class="waiting-pill">⏳ Sıra: ' + esc(nameOf(Z.turn).name) + '</div>';
      }
      if (Z.bid) Sound.beep(660, 0.08, 'triangle', 0.05);
    }
    $('#zarTable').innerHTML = zarTable(s, true);
    updateOffline(s, [Z.turn]);
  },
};

Views['zar:reveal'] = {
  mount(s) {
    const Z = s.zar;
    const R = Z.result;
    const hits = (d) => d === R.bid.f || (Z.jokers && d === 1);
    const rows = Z.seats.filter((id) => R.dice[id]).map((id) => '<div class="zrow"><span class="nm">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</span><span class="zd">' +
      R.dice[id].map((d) => dieHTML(d, hits(d) ? 'hit' : 'miss')).join('') + '</span></div>').join('');
    const verdict = R.truth ? '✅ İddia doğru çıktı! "Yalan" diyen yanıldı.' : '🤥 Yalanmış! İddia tutmadı.';
    mount(header() + revealTimer(s) +
      '<div class="card center"><div class="muted">' + esc(nameOf(R.caller).name) + ' "Yalan!" dedi</div>' +
        '<div class="zbig">İddia: ' + zarBidText(R.bid) + '</div><div class="zbig">Masada: <b>' + R.count + '</b> tane</div>' +
        '<div class="winline adamwin">' + verdict + '</div>' +
        '<p style="margin:8px 0 0">🎲 Zar kaybeden: <b>' + esc(nameOf(R.loser).name) + '</b>' + (R.gone ? ' · zarı bitti, oyundan çıktı 💀' : '') + '</p></div>' +
      '<div class="card"><h2>Herkesin zarları</h2>' + rows + '</div>' +
      '<div class="card"><h2>Masa</h2>' + zarTable(s, false) + '</div>' +
      hostNext(s, Z.pendingEnd ? '🏆 Sonuçlar' : '🎲 Sonraki el'));
    Sound.beep(R.truth ? 523 : 196, 0.3, 'sawtooth', 0.05);
  },
};

function zarFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.caught[id] + ' yalan yakaladı</small></span></div>').join('');
  const w = F.ranking[0];
  mount(
    header() +
    '<div class="phase-title"><h1>' + esc(nameOf(w).av) + ' ' + esc(nameOf(w).name) + ' kazandı!</h1><p>Masada son kalan o oldu 🎲 (' + F.rounds + ' el)</p></div>' +
    podiumHTML(F.ranking, (id) => (F.ranking.indexOf(id) + 1) + '.') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Sıralama 🏅</h2><div class="board">' + board + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Sıcak Patates ---------- */

function patHearts(P, id) {
  return P.alive[id] ? '❤️'.repeat(P.hearts[id]) + '🖤'.repeat(P.maxH - P.hearts[id]) : '💀';
}

function patTable(s) {
  const P = s.pat;
  return '<div class="ztable">' + P.seats.map((id) => '<span class="zp ' + (P.alive[id] ? '' : 'out') + (P.step === 'play' && P.holder === id ? ' turn' : '') + '">' +
    avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + (P.step === 'play' && P.holder === id ? ' 💣' : '') + ' <b>' + patHearts(P, id) + '</b></span>').join('') + '</div>';
}

function patFeedHTML(feed) {
  return feed.length ? feed.slice().reverse().map((f) => '<div class="fitem ' + (f.ok ? 'ok' : '') + '">' + (f.text == null ? '⏭ ' + esc(nameOf(f.id).name) + ' pas geçti'
    : '<b>' + esc(nameOf(f.id).name) + ':</b> ' + (f.ok ? '' : '❌ ') + '<span class="' + (f.ok ? '' : 'strike') + '">' + esc(f.text) + '</span>')).join('') : '<p class="muted" style="margin:0">Henüz cevap yok…</p>';
}

// The holder's phone ticks; everyone else just sees the bomb move.
function patTicker() {
  if (App.patTicker) return;
  App.patTicker = setInterval(() => {
    const s = App.state;
    if (s && s.phase === 'pat' && s.pat && s.pat.step === 'play' && s.pat.amHolder && Prefs.get('bombTick')) Sound.tick();
  }, 700);
}

Views['pat:play'] = {
  mount(s) {
    const P = s.pat;
    App.patSeen = '';
    patTicker();
    mount(header() +
      '<div class="vbar day patbar"><b>💣 Tur ' + P.round + '</b><span>Ne zaman patlayacağı belli değil…</span></div>' +
      '<div class="card qcard"><div class="meta">Kategori</div><div class="qtext">' + esc(P.prompt) + '</div></div>' +
      '<div id="patMain"></div>' +
      '<div class="card"><h2>Cevaplar</h2><div class="emofeed" id="patFeed"></div></div>' +
      '<div class="card"><h2>Oyuncular</h2><div id="patTable"></div></div>' + hostSkip('Bombayı sonrakine geçir'));
  },
  update(s) {
    const P = s.pat;
    const key = JSON.stringify([P.holder, P.amHolder, P.last && P.last.id, P.last && P.last.text]);
    if (key !== App.patSeen) {
      App.patSeen = key;
      const h = nameOf(P.holder);
      $('#patMain').innerHTML = P.amHolder
        ? '<div class="card myturn center patbomb"><div class="bomb">💣</div><h2 style="margin:0">Bomba sende! Çabuk!</h2>' +
          '<div class="row" style="margin-top:10px"><input id="patIn" class="field grow" maxlength="40" placeholder="' + esc(P.letter ? P.letter + '…' : 'Cevabın…') + '" autocomplete="off">' +
          '<button class="btn green" data-act="pSend">Gönder 🚀</button></div></div>'
        : '<div class="card center patbomb"><div class="bomb other">💣</div><div class="kasker">Bomba şu an: ' + avatarHTML(h) + '<b>' + esc(h.name) + '</b></div></div>';
      if (P.amHolder) { Sound.join(); buzz(150); focusFine('#patIn', true); }
    }
    const L = P.last;
    $('#patFeed').innerHTML = (L && L.id !== s.you ? '<div class="patveto">Son cevap: <b>' + esc(L.text) + '</b> · ' +
      (L.mine ? '👎 itiraz ettin' : '<button class="btn small ghost" data-act="pDown">👎 Olmaz bu!</button>') +
      ' <span class="muted">(' + L.downs + ' / ' + P.need + ')</span></div>' : '') + patFeedHTML(P.feed);
    $('#patTable').innerHTML = patTable(s);
  },
};

Views['pat:reveal'] = {
  mount(s) {
    const P = s.pat;
    const R = P.result;
    mount(header() + revealTimer(s) +
      '<div class="card center patboom"><div class="bomb">💥</div><h1 style="margin:0">BOOM!</h1>' +
        '<div class="kasker" style="margin-top:8px">Elinde patlayan: ' + avatarHTML(nameOf(R.victim)) + '<b>' + esc(nameOf(R.victim).name) + '</b></div>' +
        '<p style="margin:8px 0 0">' + (R.gone ? '💀 Canı bitti, oyundan çıktı!' : 'Kalan can: ' + patHearts(P, R.victim)) + '</p></div>' +
      '<div class="card"><h2>' + esc(R.prompt) + '</h2><div class="emofeed">' + patFeedHTML(R.feed) + '</div></div>' +
      '<div class="card"><h2>Oyuncular</h2>' + patTable(s) + '</div>' +
      hostNext(s, P.pendingEnd ? '🏆 Sonuçlar' : '💣 Sonraki tur'));
    Sound.beep(90, 0.6, 'sawtooth', 0.09);
    if (R.victim === s.you) buzz([200, 80, 400]);
  },
};

function patFinalMount(s) {
  const F = s.final;
  const w = F.ranking[0];
  const recap = F.history.map((h) => '<div><span class="q">' + esc(h.prompt) + '</span><span class="w">💥 ' + esc(nameOf(h.victim).name) + '</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title"><h1>' + esc(nameOf(w).av) + ' ' + esc(nameOf(w).name) + ' kazandı!</h1><p>Bombadan en son kaçan o oldu 🧊 (' + F.rounds + ' tur)</p></div>' +
    podiumHTML(F.ranking, (id) => (F.ranking.indexOf(id) + 1) + '.') +
    '<div class="card"><h2>Bütün turlar</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Vampir Köyü ---------- */

const VAMP_END_TEXT = {
  koy: '🏡 Köy kazandı! Bütün vampirler yok edildi.',
  vamp: '🧛 Vampirler kazandı! Köyde onlara karşı koyacak kimse kalmadı.',
  moon: '🌕 Kan Ayı doğdu! Vampirler yakalanmadan sona ulaştı.',
  soytari: '🃏 Soytarı kazandı! Köy onu sürgün etti, tam da istediği gibi.',
};

function vRoleTag(role) {
  const R = VAMP_ROLES[role];
  return '<span class="vrole t-' + R.team + '">' + R.e + ' ' + esc(R.n) + '</span>';
}

function vTeamTag(team) {
  return '<span class="vrole t-' + team + '">' + VAMP_TEAMS[team].e + ' ' + esc(VAMP_TEAMS[team].n) + '</span>';
}

// What a dead player is publicly known as.
function vShownTag(sh) {
  if (!sh) return '<span class="vrole">❔ Gizli</span>';
  return sh.startsWith('team:') ? vTeamTag(sh.slice(5)) : vRoleTag(sh);
}

function vHearts(h, max) {
  return '<span class="vhearts">' + '❤️'.repeat(Math.max(0, h)) + '🖤'.repeat(Math.max(0, max - h)) + '</span>';
}

function vName(id) {
  return '<b>' + esc(nameOf(id).name) + '</b>';
}

function vampCtxClient(s) {
  const V = s.vamp;
  return { self: s.you, role: V.me.role, alive: V.alive, roster: s.roster, mates: V.mates ? V.mates.map((m) => m.id) : [], used: V.me.used, lastHeal: V.me.lastHeal };
}

// A private night result as a sentence (no Turkish suffixes after names: they depend on the name).
function vInfoText(x) {
  const T = (team) => VAMP_TEAMS[team].e + ' ' + VAMP_TEAMS[team].n;
  switch (x.k) {
    case 'pass': return '💤 Bu gece dinlendin.';
    case 'blocked': return '😴 Biri seni oyaladı, bu gece hiçbir şey yapamadın!';
    case 'blockDone': return '🧟 Oyaladığın kişi: ' + vName(x.t);
    case 'bellRang': return '📣 Düdüğü çaldın! Köy uyandı, bu gece kimse ısırılamadı.';
    case 'biteOk': return '🩸 Isırdığın kişi: ' + vName(x.t);
    case 'biteFail': return '🚪 Hedef: ' + vName(x.t) + ' · ' + (x.why === 'bell' ? 'bekçi düdük çaldı, köy uyandı, ısıramadın!' : x.why === 'hide' ? 'evde kimse yoktu!' : 'kapıda sarımsak vardı, geri döndün!');
    case 'bitten': return '🩸 Gece biri seni ısırdı! Boynunda iki diş izi var.';
    case 'garlicHit': return '🧄 Sarımsak işe yaradı! Bir vampir şu kapıdan geri döndü: ' + vName(x.t);
    case 'garlicQuiet': return '🧄 Sarımsak astığın kapı: ' + vName(x.t) + ' · bu gece vampir gelmedi.';
    case 'stakeVamp': return '🏹 Gümüş ok tam isabet! ' + vName(x.t) + ' bir vampirdi ve artık yok.';
    case 'stakeMiss': return '🏹 Okun hedefi: ' + vName(x.t) + ' · vampir değildi, onu yaraladın 😬';
    case 'stakeLost': return '🏹 Okun hedefi: ' + vName(x.t) + ' · evde kimse yoktu, ok boşa gitti.';
    case 'staked': return '🏹 Biri sana gümüş ok attı! Yaralandın.';
    case 'healDone': return '🩺 Yarasını sardığın kişi: ' + vName(x.t);
    case 'healLost': return '🩺 Gittiğin ev: ' + vName(x.t) + ' · evde kimse yoktu.';
    case 'healed': return '🩺 Biri gece gelip yaralarını sardı (+1 can).';
    case 'died': return '💀 Bu gece öldün…';
    case 'jailInfo': return '🔍 Sorguladığın: ' + vName(x.t) + ' · bu gece ' + VAMP_PLANS[x.plan] + ' hazırlanıyormuş.';
    case 'jailed': return '👮 Polis seni gece sorguya aldı! Geceyi karakolda geçirdin: hiçbir şey yapamadın ama kimse de sana ulaşamadı.';
    case 'shotHit': return '🔫 Tam isabet! ' + vName(x.t) + ' vampir tarafındaydı.';
    case 'shotMiss': return '🔫 Vurduğun kişi: ' + vName(x.t) + ' · masumdu! Vicdan azabına dayanamadın…';
    case 'shotLost': return '🔫 Hedef: ' + vName(x.t) + ' · evde kimse yoktu, mermi boşa gitti.';
    case 'shot': return '🔫 Polis seni vurdu!';
    case 'seer': return '🔮 ' + vName(x.t) + ' → ' + T(x.team);
    case 'watch': return '👀 İzlediğin ev: ' + vName(x.t) + ' · gelen: ' + (x.n ? x.n + ' kişi' : 'kimse gelmedi');
    case 'track': return '🕵️ Takip ettiğin: ' + vName(x.t) + ' · ' + (x.to ? 'gittiği ev: ' + vName(x.to) : 'evinden hiç çıkmadı');
    case 'grave': return '⚰️ Mezar: ' + vName(x.t) + ' · rolü: ' + vRoleTag(x.role);
    case 'roam': return '🃏 Kapısını çalıp kaçtığın ev: ' + vName(x.t);
    case 'hid': return '🎒 Saklandın.' + (x.knocked ? ' Biri kapını çaldı ama seni bulamadı!' : '');
  }
  return '';
}

function vampTop(s, timerLabel) {
  const V = s.vamp;
  const isDay = V.step === 'day' || V.step === 'reveal';
  const left = V.nights - V.night;
  const me = V.me;
  return header() + (timerLabel ? timerHTML(timerLabel) : '') +
    '<div class="vbar ' + (isDay ? 'day' : 'night') + '"><b>' + (V.step === 'roles' ? '🎭 Roller dağıtıldı' : (isDay ? '☀️ Gün ' : '🌙 Gece ') + V.night + ' / ' + V.nights) + '</b>' +
      '<span>' + (left > 0 ? '🌕 Kan Ayına ' + left + ' gece' : '🌕 Kan Ayı bu gece!') + '</span></div>' +
    (me ? '<div class="vme"><button class="vmebtn" data-act="vRole">' + vRoleTag(me.role) + ' ' + vHearts(me.hearts, me.maxH) + (me.alive ? '' : ' 👻') + ' <small>ⓘ</small></button>' +
      '<div class="card vrolecard" id="vRoleCard"' + (App.vRoleOpen ? '' : ' hidden') + '>' + vRoleCardBody(me.role, V) + '</div></div>' : '');
}

function vRoleCardBody(role, V) {
  const R = VAMP_ROLES[role];
  const mates = V.mates && V.mates.length > 1 ? '<p class="vmates">🦇 Takımın: ' + V.mates.map((m) => vName(m.id) + ' ' + vRoleTag(m.role)).join(' · ') + '</p>' : '';
  return '<div class="vbig">' + R.e + '</div><h2 style="margin:0">' + esc(R.n) + '</h2>' + vTeamTag(R.team) + '<p>' + esc(R.d) + '</p>' + mates;
}

function vPlayers(s) {
  const V = s.vamp;
  return '<div class="vlist">' + s.roster.map((id) => '<span class="vp ' + (V.alive[id] ? '' : 'dead') + '">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) +
    (V.alive[id] ? '' : ' 💀 ' + vShownTag(V.shown[id])) + '</span>').join('') + '</div>';
}

function vRoleListHTML(V) {
  return '<div class="vrolelist">' + V.roleList.map(vRoleTag).join('') + '</div>';
}

Views['vamp:roles'] = {
  mount(s) {
    const V = s.vamp;
    App.vRoleOpen = false;
    const me = V.me;
    mount(vampTop(s, 'Rolüne bak') +
      (me ? '<div class="card center vreveal t-' + VAMP_ROLES[me.role].team + '">' + vRoleCardBody(me.role, V) + '<div style="margin-top:8px">Canın: ' + vHearts(me.hearts, me.maxH) + '</div>' +
        '<p class="muted" style="font-size:14px">🤫 Rolünü kimseye gösterme!</p><button class="btn yellow big block" data-act="vReady">Anladım, hazırım ✅</button></div>' : '') +
      '<div class="card"><h2>Bu oyundaki roller</h2>' + vRoleListHTML(V) +
        '<p class="muted" style="margin:10px 0 0;font-size:14px">Kimin ne olduğunu bilmiyorsunuz ama oyunda bu roller var.</p></div>' +
      '<div class="card"><h2>Kim hazır?</h2><div class="chips" id="vChips"></div></div>' + hostSkip('Geceyi başlat'));
    Sound.join();
  },
  update(s) {
    $('#vChips').innerHTML = doneChips(s, s.vamp.done, Object.keys(s.vamp.done));
  },
};

function vampActPaint() {
  const s = App.state;
  const V = s.vamp;
  const box = $('#vAct');
  if (!box || !V.me || !V.me.alive) return;
  const ctx = vampCtxClient(s);
  const kinds = vampKindsFor(ctx);
  if (!App.vSel || (App.vSel.kind !== 'pass' && !kinds.includes(App.vSel.kind))) App.vSel = { kind: kinds[0], target: null };
  const sel = App.vSel;
  const K = VAMP_KINDS[sel.kind] || null;
  const sent = V.myAct;
  let html = kinds.length > 1 ? '<div class="vkinds">' + kinds.map((k) => '<button class="btn small ' + (sel.kind === k ? 'yellow' : 'ghost') + '" data-act="vKind" data-k="' + k + '">' + VAMP_KINDS[k].b + '</button>').join('') + '</div>' : '';
  if (K && sel.kind !== 'pass') {
    html += '<p class="vq">' + esc(K.q) + '</p>';
    if (K.t === 'use') {
      html += '<button class="btn big block ' + (sent && sent.kind === sel.kind ? 'green' : 'yellow') + '" data-act="vSend">' + K.b + '</button>';
    } else {
      const ts = vampTargets(sel.kind, ctx);
      html += ts.length ? '<div class="vtargets">' + ts.map((id) => '<button class="vt ' + (sel.target === id ? 'on' : '') + '" data-act="vPick" data-id="' + esc(id) + '">' +
        avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + (id === s.you ? ' (sen)' : '') + '</button>').join('') + '</div>' : '<p class="muted">Seçilebilecek kimse yok.</p>';
      html += '<button class="btn yellow big block" data-act="vSend" style="margin-top:12px"' + (sel.target ? '' : ' disabled') + '>Onayla ✅</button>';
    }
  }
  html += '<div class="ctrl" style="margin-top:10px"><button class="btn small ghost" data-act="vPass">💤 Bu gece bir şey yapma</button></div>';
  if (sent) {
    const what = sent.kind === 'pass' ? '💤 dinleneceksin' : VAMP_KINDS[sent.kind].b + (sent.target ? ' → ' + esc(nameOf(sent.target).name) : '');
    html += '<p class="vsent">✅ Seçimin: ' + what + ' <small>(gece bitene kadar değiştirebilirsin)</small></p>';
  }
  box.innerHTML = html;
}

Views['vamp:night'] = {
  mount(s) {
    const V = s.vamp;
    const me = V.me;
    App.vRoleOpen = false;
    App.vSel = V.myAct ? { ...V.myAct } : null;
    const fang = !!V.mates;
    const body = !me ? '' : me.alive
      ? '<div class="card vnight"><h2>🌙 Gece hamlen</h2><div id="vAct"></div></div>'
      : '<div class="card center"><div class="vbig">👻</div><h2 style="margin:0">Öldün</h2><p class="muted">Artık bir şey yapamaz ve konuşamazsın ama izleyebilirsin.</p></div>';
    const team = fang && me.alive ? '<div class="card vfang"><h2>🦇 Vampir takımı</h2><div id="vMates"></div>' +
      '<div class="vchat" id="vChatList"></div><div class="row"><input id="vchatIn" class="field grow" maxlength="120" placeholder="Takımına fısılda… (sadece onlar görür)" autocomplete="off">' +
      '<button class="btn small" data-act="vChat">Gönder</button></div></div>' : '';
    mount(vampTop(s, 'Gece süresi') + body + team +
      '<div class="card"><h2>Kim hamlesini yaptı?</h2><div class="chips" id="vChips"></div>' +
        '<p class="muted" style="margin:8px 0 0;font-size:14px">Herkes her gece bir şey yapar, kimse kimin ne olduğunu anlamasın diye 😉</p></div>' +
      '<div class="card"><h2>Köy</h2>' + vPlayers(s) + '</div>' + hostSkip('Geceyi bitir'));
    vampActPaint();
    if (me && me.alive) Sound.beep(330, 0.3, 'sine', 0.05);
  },
  update(s) {
    const V = s.vamp;
    $('#vChips').innerHTML = doneChips(s, V.done, Object.keys(V.done));
    if ($('#vAct') && JSON.stringify(V.myAct) !== App.vLastAct) { App.vLastAct = JSON.stringify(V.myAct); vampActPaint(); }
    if ($('#vMates')) {
      $('#vMates').innerHTML = V.mates.map((m) => {
        const a = V.mateActs[m.id];
        const what = !V.alive[m.id] ? '💀' : !a ? '⏳ düşünüyor' : a.kind === 'pass' ? '💤 pas' : VAMP_KINDS[a.kind].b + (a.target ? ' → ' + esc(nameOf(a.target).name) : '');
        return '<div class="vmate">' + avatarHTML(nameOf(m.id), 'sm') + vName(m.id) + ' ' + vRoleTag(m.role) + ' <span class="muted">' + what + '</span></div>';
      }).join('') + '<p class="muted" style="margin:6px 0 0;font-size:13px">Farklı kişiler seçerseniz en çok seçilen ısırılır.</p>';
      const list = $('#vChatList');
      const key = JSON.stringify(V.vchat);
      if (list.dataset.k !== key) {
        list.dataset.k = key;
        list.innerHTML = V.vchat.map((m) => '<div><b>' + esc(nameOf(m.id).name) + ':</b> ' + esc(m.text) + '</div>').join('') || '<span class="muted">Henüz fısıltı yok…</span>';
        list.scrollTop = list.scrollHeight;
      }
    }
  },
};

function vReportHTML(s) {
  const R = s.vamp.report;
  if (!R) return '';
  const lines = [];
  if (R.bell) lines.push('📣 Gece bekçinin düdüğü duyuldu! Bütün köy uyandı.');
  for (const id of R.deaths) lines.push('💀 ' + vName(id) + ' sabah ölü bulundu. ' + vShownTag(s.vamp.shown[id]));
  if (R.bites > 0) lines.push('🩸 Biri ısırıldı ama hayatta kaldı. Kim olduğunu sadece kendisi biliyor…');
  if (!R.deaths.length && !R.bites && !R.bell) lines.push('🌤️ Sakin bir gece geçti, kimse ölmedi.');
  return '<div class="card vreport"><h2>☀️ Sabah haberleri (Gece ' + R.night + ')</h2>' + lines.map((l) => '<p>' + l + '</p>').join('') + '</div>';
}

function vMyNightHTML(s) {
  const V = s.vamp;
  const last = V.myLog.length ? V.myLog[V.myLog.length - 1] : null;
  if (!last || last.night !== V.night) return '';
  return '<div class="card vprivate"><h2>🤫 Senin gecen</h2>' + last.items.map((x) => '<p>' + vInfoText(x) + '</p>').join('') +
    (V.myLog.length > 1 ? '<details><summary>Önceki geceler</summary>' + V.myLog.slice(0, -1).map((l) => '<p class="muted"><b>Gece ' + l.night + ':</b> ' + l.items.map(vInfoText).join(' · ') + '</p>').join('') + '</details>' : '') + '</div>';
}

Views['vamp:day'] = {
  mount(s) {
    const V = s.vamp;
    App.vRoleOpen = false;
    const me = V.me;
    const canVote = me && me.alive;
    mount(vampTop(s, 'Gündüz süresi') + vReportHTML(s) + vMyNightHTML(s) +
      '<div class="card"><h2>🚪 Kimi köyden sürelim?</h2>' +
        '<p class="muted" style="margin:0 0 10px;font-size:14px">Konuşun, tartışın, sonra oy verin. En çok oyu alan köyden sürülür (oyundan çıkar); eşitlik olursa kimse sürülmez.' + (V.roleList.includes('muhtar') ? ' Muhtarın oyu 2 sayılır!' : '') + '</p>' +
        '<div id="vVote"></div>' + (canVote ? '' : '<p class="muted">👻 Ölüler oy veremez.</p>') + '</div>' +
      '<div class="card"><h2>Köy</h2>' + vPlayers(s) + '</div>' + hostSkip('Oylamayı bitir'));
    Sound.beep(660, 0.2, 'triangle', 0.06);
  },
  update(s) {
    const V = s.vamp;
    const me = V.me;
    const canVote = me && me.alive;
    const living = s.roster.filter((id) => V.alive[id]);
    const voters = (t) => Object.keys(V.votes).filter((id) => V.votes[id] === t);
    const row = (t, label) => {
      const vs = voters(t);
      const mine = V.votes[s.you] === t;
      return '<button class="vvote ' + (mine ? 'on' : '') + '" data-act="vVote" data-id="' + esc(t) + '"' + (canVote && t !== s.you ? '' : ' disabled') + '>' +
        label + '<span class="vvoters">' + vs.map((id) => avatarHTML(nameOf(id), 'sm')).join('') + '</span></button>';
    };
    $('#vVote').innerHTML = '<div class="vvotes">' + living.map((id) => row(id, avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + (id === s.you ? ' (sen)' : '') + '</span>')).join('') +
      row('none', '<span class="nm">🤷 Bugün kimseyi sürmeyelim</span>') + '</div>';
  },
};

Views['vamp:reveal'] = {
  mount(s) {
    const V = s.vamp;
    const R = V.result;
    const tallyRows = Object.keys(R.tally).sort((a, b) => R.tally[b] - R.tally[a]).map((id) => '<div class="srow">' + avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) +
      '<small>' + Object.keys(R.votes).filter((v) => R.votes[v] === id).map((v) => esc(nameOf(v).name)).join(', ') + '</small></span><b>' + R.tally[id] + '</b></div>').join('') +
      (R.none ? '<div class="srow"><span class="nm">🤷 Kimse<small>' + Object.keys(R.votes).filter((v) => R.votes[v] === 'none').map((v) => esc(nameOf(v).name)).join(', ') + '</small></span><b>' + R.none + '</b></div>' : '');
    const head = R.staked
      ? '<div class="vbig">🚪</div><h2 style="margin:0">Köyden sürülen: ' + esc(nameOf(R.staked).name) + '</h2><div style="margin-top:8px">' + vShownTag(V.shown[R.staked]) + '</div>'
      : '<div class="vbig">🤷</div><h2 style="margin:0">' + (R.tie ? 'Oylar eşit çıktı, kimse sürülmedi!' : 'Köy bugün kimseyi sürmedi.') + '</h2>';
    const next = V.pendingEnd ? '🏆 Sonuçlar' : '🌙 Gece ' + (V.night + 1);
    mount(vampTop(s, '') + revealTimer(s) +
      '<div class="card center vverdict">' + head + (V.pendingEnd ? '<p class="vendline">Oyun bitti!</p>' : '') + '</div>' +
      '<div class="card"><h2>Oylar</h2><div class="board">' + (tallyRows || '<p class="muted" style="margin:0">Kimse oy vermedi.</p>') + '</div></div>' +
      '<div class="card"><h2>Köy</h2>' + vPlayers(s) + '</div>' + hostNext(s, next));
    Sound.beep(R.staked ? 196 : 523, 0.35, 'sawtooth', 0.04);
  },
};

function vampFinalMount(s) {
  const F = s.final;
  const sideOf = (id) => VAMP_ROLES[F.roles[id]].team;
  const rows = s.roster.slice().sort((a, b) => (F.winners.includes(b) - F.winners.includes(a)) || sideOf(a).localeCompare(sideOf(b))).map((id) => '<div class="srow ' + (F.winners.includes(id) ? 'win' : '') + '">' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + (F.alive[id] ? 'hayatta' : '💀 öldü') + '</small></span>' + vRoleTag(F.roles[id]) + (F.winners.includes(id) ? ' 🏆' : '') + '</div>').join('');
  const story = F.history.map((h) => '<div><span class="q"><b>Gece ' + h.night + ':</b> ' + (h.bell ? '📣 düdük çalındı · ' : '') +
    (h.deaths.length ? h.deaths.map((id) => '💀 ' + esc(nameOf(id).name) + ' (' + VAMP_ROLES[F.roles[id]].e + ')').join(', ') : 'kimse ölmedi') + '</span><span class="w">' +
    (h.votes ? (h.staked ? '🚪 ' + esc(nameOf(h.staked).name) + ' (' + VAMP_ROLES[F.roles[h.staked]].e + ')' : '🤷 sürgün yok') : '') + '</span></div>').join('');
  const [winTitle, why] = VAMP_END_TEXT[F.end].split('! ');
  mount(
    header() +
    '<div class="phase-title"><h1>' + esc(winTitle) + '!</h1><p>' + esc(why) + '</p></div>' +
    '<div class="card"><h2>Kazananlar 🏆</h2><div class="chips">' + F.winners.map((id) => '<span class="chip done">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + '</span>').join('') + '</div></div>' +
    '<div class="card"><h2>Herkesin rolü</h2><div class="board vfinal">' + rows + '</div></div>' +
    '<div class="card"><h2>Neler oldu?</h2><div class="recap">' + story + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Adam Asmaca ---------- */

// Gallows first (base, pole, beam, rope), then the stick man.
const ADAM_SVG_PARTS = [
  '<line x1="8" y1="132" x2="84" y2="132"/>', '<line x1="28" y1="132" x2="28" y2="8"/>', '<line x1="26" y1="8" x2="88" y2="8"/>',
  '<line x1="86" y1="8" x2="86" y2="26"/>', '<circle cx="86" cy="38" r="12"/>', '<line x1="86" y1="50" x2="86" y2="88"/>',
  '<line x1="86" y1="60" x2="70" y2="76"/>', '<line x1="86" y1="60" x2="102" y2="76"/>',
  '<line x1="86" y1="88" x2="72" y2="112"/>', '<line x1="86" y1="88" x2="100" y2="112"/>',
];

function adamSVG(lives, wrong, dead) {
  const shown = ADAM_PARTS - lives + wrong;
  const face = dead ? '<path class="face" d="M79 34l5 5M84 34l-5 5M88 34l5 5M93 34l-5 5"/>' : '';
  return '<svg class="hangsvg" viewBox="0 0 112 140">' +
    ADAM_SVG_PARTS.map((part, i) => part.replace('/>', ' class="' + (i < shown ? 'on' : 'off') + (i === shown - 1 && wrong && !dead ? ' new' : '') + '"/>')).join('') +
    (shown >= 5 ? face : '') + '</svg>';
}

// The word as letter boxes, one group per word so long phrases wrap nicely.
function adamMaskHTML(chars, missing = []) {
  const groups = [];
  let cur = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] === ' ') { groups.push(cur); cur = []; continue; }
    cur.push('<span class="abox ' + (chars[i] ? 'on' : '') + (missing.includes(i) ? ' miss' : '') + '">' + esc(chars[i] || '') + '</span>');
  }
  groups.push(cur);
  return groups.map((g) => '<span class="agrp">' + g.join('') + '</span>').join('');
}

function adamLastText(last) {
  if (!last) return '';
  const nm = esc(nameOf(last.id).name);
  if (last.pass) return '⏭ ' + nm + ' pas geçti';
  if (last.text) return last.ok ? '🎉 ' + nm + ' kelimeyi bildi!' : '❌ ' + nm + ' "' + esc(last.text) + '" dedi, yanlış!';
  return last.n ? '✅ ' + nm + ' <b>' + esc(last.l) + '</b> dedi, ' + last.n + ' tane var! +' + last.pts : '❌ ' + nm + ' <b>' + esc(last.l) + '</b> dedi, yok!';
}

// Physical keyboard: on your turn, typing a letter outside any input picks it.
function adamTypedLetter(e) {
  const s = App.state;
  if (!s || s.phase !== 'adam' || !s.adam || s.adam.step !== 'play' || !s.adam.myTurn) return false;
  if (e.ctrlKey || e.metaKey || e.altKey || e.key.length !== 1 || /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return false;
  const l = e.key.toLocaleUpperCase('tr');
  if (!ADAM_ALPHABET.includes(l) || s.adam.used[l] !== undefined) return false;
  e.preventDefault();
  send({ t: 'hletter', l });
  return true;
}

function adamHintHTML(A) {
  return A.hint ? '<div class="muted" style="font-weight:700">İpucu: <b style="color:var(--ink)">' + esc(A.hint) + '</b></div>' : '';
}

Views['adam:write'] = {
  mount(s) {
    const A = s.adam;
    const a = nameOf(A.setter);
    const body = A.amSetter
      ? '<div class="card myturn"><h2>Sıra sende! 🪢</h2><p class="muted" style="margin:0 0 10px">Gizli bir kelime ya da kısa bir söz yaz. Diğerleri harf harf bulmaya çalışacak!</p>' +
        '<div class="row"><input id="adamWord" class="field grow" maxlength="' + ADAM_MAX_LEN + '" placeholder="Örn: Kapadokya" autocomplete="off">' +
        '<button class="dice" data-act="hmDice" title="Rastgele kelime">🎲</button></div>' +
        '<div style="height:8px"></div><input id="adamHint" class="field" maxlength="30" placeholder="İpucu (isteğe bağlı): Şehir" autocomplete="off">' +
        '<div style="height:12px"></div><button class="btn yellow big block" data-act="hmWord">Kelimeyi gönder 🚀</button></div>'
      : '<div class="card center turnwait">' + avatarHTML(a, 'lg') + '<h2 style="margin:8px 0 0">' + esc(a.name) + ' gizli kelimeyi seçiyor… 🤫</h2>' +
        '<p class="muted" style="margin:4px 0 0">Birazdan sırayla harf tahmin edeceksiniz</p></div>';
    mount(header() + timerHTML('Kelime yazma süresi') + stepDots(A.ti, A.tn) + body + OFFLINE_NOTE + hostSkip('Sırayı geç'));
    if (A.amSetter) { Sound.join(); focusFine('#adamWord', true); }
  },
  update(s) { updateOffline(s, [s.adam.setter]); },
};

Views['adam:play'] = {
  mount(s) {
    const A = s.adam;
    App.adamWasTurn = false;
    App.adamLastSeen = JSON.stringify(A.last);
    App.adamWrongSeen = App.adamMaskSeen = null;
    const owner = A.setter ? '<div class="kasker">Kelimeyi seçen: ' + avatarHTML(nameOf(A.setter)) + '<b>' + esc(nameOf(A.setter).name) + '</b></div>' : '<div class="kasker">🎲 Hazır kelime</div>';
    const keys = [...ADAM_ALPHABET].map((l) => '<button class="akey" data-act="hmKey" data-l="' + l + '">' + l + '</button>').join('');
    mount(header() + timerHTML('Hamle süresi') + stepDots(A.ti, A.tn) +
      '<div class="card center">' + owner + adamHintHTML(A) +
        (A.amSetter ? '<div class="mybanner">🤫 Senin kelimen: <b>' + esc(A.word) + '</b></div>' : '') +
        '<div class="hang" id="adamHang"></div><div class="amask" id="adamMask"></div>' +
        '<div class="awrong" id="adamWrong"></div></div>' +
      '<div class="card"><div class="aturn" id="adamTurn"></div><div class="alast" id="adamLast"></div>' +
        '<div class="akeys" id="adamKeys">' + keys + '</div>' +
        (A.amSetter ? '' : '<div class="row" id="adamSolveRow" style="margin-top:12px"><input id="adamSolve" class="field grow" maxlength="' + ADAM_MAX_LEN + '" placeholder="Kelimeyi biliyorsan yaz…" autocomplete="off">' +
          '<button class="btn green" data-act="hmSolve">Tahmin</button></div><p class="muted" id="adamSolveNote" style="margin:6px 0 0;font-size:13px">Yanlış tahmin de bir hak götürür!</p>') +
        '<div class="chips" id="adamOrder" style="margin-top:12px"></div></div>' +
      OFFLINE_NOTE + hostSkip('Sırayı geç'));
  },
  update(s) {
    const A = s.adam;
    // Only redraw what changed, so the little animations don't replay on every update.
    if (App.adamWrongSeen !== A.wrong) { App.adamWrongSeen = A.wrong; $('#adamHang').innerHTML = adamSVG(A.lives, A.wrong, false); }
    const maskKey = A.mask.join('|');
    if (App.adamMaskSeen !== maskKey) { App.adamMaskSeen = maskKey; $('#adamMask').innerHTML = adamMaskHTML(A.mask); }
    const wrongs = Object.keys(A.used).filter((l) => !A.used[l]);
    $('#adamWrong').innerHTML = 'Kalan hak: <b>' + (A.lives - A.wrong) + '</b>' + (wrongs.length ? ' · Olmayanlar: <span class="bad">' + wrongs.map(esc).join(' ') + '</span>' : '');
    const t = nameOf(A.turn);
    $('#adamTurn').innerHTML = A.myTurn ? '🎯 <b>Sıra sende!</b> Bir harf seç ya da kelimeyi tahmin et' : '⏳ Sıra: <b>' + esc(t.name) + '</b>';
    $('#adamTurn').classList.toggle('me', A.myTurn);
    $('#adamLast').innerHTML = adamLastText(A.last);
    for (const b of $$('.akey')) {
      const u = A.used[b.dataset.l];
      b.classList.toggle('hit', u === true);
      b.classList.toggle('miss', u === false);
      b.disabled = !A.myTurn || u !== undefined;
    }
    const row = $('#adamSolveRow');
    if (row) { row.hidden = !A.myTurn; $('#adamSolveNote').hidden = !A.myTurn; }
    $('#adamOrder').innerHTML = A.guessers.map((id) => '<span class="chip ' + (id === A.turn ? 'done' : '') + '">' + avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) +
      (A.rd[id] ? ' <span class="cnt">+' + A.rd[id] + '</span>' : '') + '</span>').join('');
    updateOffline(s, [A.turn]);
    // Little sounds for each move, and a nudge when the turn comes to you.
    const lastKey = JSON.stringify(A.last);
    if (lastKey !== App.adamLastSeen) {
      App.adamLastSeen = lastKey;
      if (A.last && !A.last.pass) Sound.beep(A.last.n || A.last.ok ? 880 : 220, 0.15, A.last.n || A.last.ok ? 'triangle' : 'square', 0.06);
    }
    if (A.myTurn && !App.adamWasTurn) {
      Sound.join();
      if (App.chatOpen) toast('🎤 Sıra sende! Harf seçmek için sohbeti kapat.', 3000);
    }
    App.adamWasTurn = A.myTurn;
  },
};

Views['adam:reveal'] = {
  mount(s) {
    const A = s.adam;
    const R = A.result;
    const chars = [...R.word];
    const missing = chars.map((c, i) => (c !== ' ' && !R.used[c] ? i : -1)).filter((i) => i >= 0);
    const solverName = R.solver ? esc(nameOf(R.solver).name) : '';
    const verdict = R.outcome === 'hanged' ? '🪢 Adam asıldı! Kelimeyi kimse bulamadı'
      : R.outcome === 'solved' ? '🧩 ' + solverName + ' kelimeyi bildi!'
      : '🔤 Harfler tamamlandı! Son harfi ' + solverName + ' buldu';
    const last = A.ti >= A.tn - 1;
    const owner = R.setter ? '<div class="kasker">Kelimeyi seçen: ' + avatarHTML(nameOf(R.setter)) + '<b>' + esc(nameOf(R.setter).name) + '</b></div>' : '';
    mount(header() + revealTimer(s) + stepDots(A.ti, A.tn) +
      '<div class="card center">' + owner + (R.hint ? '<div class="muted">İpucu: ' + esc(R.hint) + '</div>' : '') +
        '<div class="hang">' + adamSVG(R.lives, R.wrong, R.outcome === 'hanged') + '</div>' +
        '<div class="amask">' + adamMaskHTML(chars, missing) + '</div>' +
        '<div class="winline adamwin">' + verdict + '</div>' +
        '<p class="muted" style="margin:6px 0 0">' + R.wrong + ' yanlış tahmin · ' + R.lives + ' hak vardı</p></div>' +
      '<div class="card"><h2>Puan durumu</h2>' + scoreBoard(s, R.scores, R.delta) +
        (R.setter ? '<p class="muted" style="margin:10px 0 0;font-size:14px">Kelime sahibi her yanlış tahmin için +' + ADAM_MISS_POINTS + ', adam asılırsa +' + ADAM_HANG_POINTS + ' alır</p>' : '') + '</div>' +
      hostNext(s, last ? '🏆 Sonuçlar' : 'Sıradaki ▶'));
    if (R.outcome === 'hanged') Sound.beep(180, 0.4, 'sawtooth', 0.05); else Sound.fanfare();
  },
};

function adamFinalMount(s) {
  const F = s.final;
  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.solved[id] + ' kelime buldu' + (F.own ? ' · ' + F.hanged[id] + ' adam astı' : '') + '</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.history.map((h) => '<div><span class="q">' + (h.setter ? '<b>' + esc(nameOf(h.setter).name) + ':</b> ' : '') + esc(h.word) + '</span><span class="w">' +
    (h.outcome === 'hanged' ? '🪢 asıldı' : '🧩 ' + esc(nameOf(h.solver).name)) + '</span></div>').join('');
  mount(
    header() +
    '<div class="phase-title">' + finalHeadline(F, F.scores, 'kelime ustası 🪢') + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Bulduğun her harf +' + ADAM_LETTER_POINTS + ' · Kelimeyi bilmek +' + ADAM_SOLVE_POINTS + ' (+' + ADAM_HIDDEN_POINTS + ' her gizli harf için) · Son harf +' + ADAM_LAST_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün kelimeler</h2><div class="recap">' + (recap || '<p class="muted" style="margin:0">—</p>') + '</div></div>' +
    finalFooter(),
    true
  );
}

/* ---------- Kaç Kaç? ---------- */

const fmtNum = (n) => Number(n).toLocaleString('tr-TR');

function kacTop(s, timerLabel) {
  const K = s.kac;
  return header() + (timerLabel ? timerHTML(timerLabel) : '') +
    '<div class="dots">' + Array.from({ length: K.tn }, (_, i) => '<i class="' + (i <= K.ti ? 'on' : '') + '"></i>').join('') + '</div>';
}

function kacQuestionCard(s, text) {
  const a = nameOf(s.kac.asker);
  return '<div class="card qcard"><div class="kasker">' + avatarHTML(a) + '<b>' + esc(a.name) + '</b> soruyor:</div><div class="qtext">' + esc(text) + '</div></div>';
}

Views['kac:ask'] = {
  mount(s) {
    const K = s.kac;
    const a = nameOf(K.asker);
    const mine = K.asker === s.you;
    const body = mine
      ? '<div class="card myturn"><h2>Sıra sende! 🎤</h2><p class="muted" style="margin:0 0 12px">Kendinle ilgili, cevabı sayı olan bir soru sor. Doğru cevabı sadece sen biliyorsun!</p>' +
        '<label class="lbl" for="kacQ">Sorun</label>' +
        '<div class="row"><input id="kacQ" class="field grow" maxlength="' + MAX_Q_LEN + '" placeholder="Örn: Bugün kaç saat uyumuşumdur?" autocomplete="off">' +
        '<button class="dice" data-act="kidea" title="Fikir ver">🎲</button></div>' +
        '<label class="lbl" for="kacAns" style="margin-top:12px">Doğru cevap (gizli 🤫)</label>' +
        '<input id="kacAns" class="field knum" type="text" inputmode="decimal" autocomplete="off" placeholder="Örn: 7">' +
        '<div style="height:14px"></div><button class="btn yellow big block" data-act="kask">Soruyu sor 🚀</button></div>'
      : '<div class="card center turnwait">' + avatarHTML(a, 'lg') + '<h2 style="margin:8px 0 0">' + esc(a.name) + ' soru hazırlıyor…</h2>' +
        '<p class="muted" style="margin:4px 0 0">Birazdan onun hakkında bir sayı tahmin edeceksin 🤔</p></div>';
    mount(kacTop(s, 'Soru yazma süresi') + body + OFFLINE_NOTE +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Bu kişiyi atla</button></div>' : ''));
    if (mine) {
      Sound.join();
      const el = $('#kacQ');
      if (el) autoFocus(el, true);
    }
  },
  update(s) { updateOffline(s, [s.kac.asker]); },
};

Views['kac:guess'] = {
  mount(s) {
    const K = s.kac;
    const mine = K.asker === s.you;
    mount(kacTop(s, 'Tahmin süresi') + kacQuestionCard(s, K.q) +
      '<div id="kacArea">' + (mine
        ? '<div class="card center"><div class="big-emoji">👀</div><h2>Arkadaşların tahmin ediyor</h2><p class="muted" style="margin:0">Senin cevabın: <b>' + fmtNum(K.myAnswer) + '</b></p></div>'
        : '<div class="card"><label class="lbl" for="kacGuess">Sence cevap kaç?</label>' +
          '<div class="row"><input id="kacGuess" class="field grow knum" type="text" inputmode="decimal" autocomplete="off" placeholder="Tahminin…">' +
          '<button class="btn green" data-act="kguess">Gönder</button></div>' +
          '<p class="muted" style="margin:8px 0 0">Tam bilirsen +' + KAC_EXACT_POINTS + ', kimse tam bilemezse en yakın olan +' + KAC_CLOSE_POINTS + '</p></div>') +
      '</div>' +
      '<div class="card"><h2>Kim tahmin etti?</h2><div class="chips" id="kacChips"></div></div>' +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Cevabı aç</button></div>' : ''));
    const el = $('#kacGuess');
    if (el) autoFocus(el, !!(App.state && App.state.kac && App.state.kac.asker === App.state.you));
  },
  update(s) {
    const K = s.kac;
    if (K.myGuess != null && K.asker !== s.you && !$('#kacSent')) {
      $('#kacArea').innerHTML = '<div class="waiting-pill" id="kacSent">Tahminin: <b>' + fmtNum(K.myGuess) + '</b> ✓ Diğerleri bekleniyor…</div>';
    }
    $('#kacChips').innerHTML = Object.keys(K.guessed).map((id) => '<span class="chip ' + (K.guessed[id] ? 'done' : '') + '">' +
      avatarHTML(nameOf(id), 'sm') + esc(nameOf(id).name) + ' <span class="cnt">' + (K.guessed[id] ? '✓' : '⏳') + '</span></span>').join('');
  },
};

Views['kac:reveal'] = {
  mount(s) {
    const K = s.kac;
    const R = K.result;
    const step = R.guesses.length > 6 ? 0.35 : 0.5;
    const start = 1.4;                                   // the answer pops first
    const rows = R.guesses.map((g, i) => {
      const p = nameOf(g.id);
      const exact = R.exact.includes(g.id);
      const close = R.closest.includes(g.id);
      return '<div class="krow ' + (exact || close ? 'top' : '') + '" style="--d:' + (start + i * step).toFixed(2) + 's">' + avatarHTML(p) +
        '<div class="body"><div class="top2"><span class="nm">' + esc(p.name) + '</span><b class="kv">' + fmtNum(g.v) + '</b></div>' +
        '<div class="kdiff">' + (exact ? '🎯 Tam isabet!' : close ? '👌 En yakın tahmin (fark ' + fmtNum(g.diff) + ')' : 'fark ' + fmtNum(g.diff)) + '</div></div>' +
        (R.delta[g.id] ? '<span class="dl">+' + R.delta[g.id] + '</span>' : '') + '</div>';
    }).join('');
    const after = start + R.guesses.length * step + 0.3;
    const board = s.roster.slice().sort((a, b) => R.scores[b] - R.scores[a]).map((id, i) => '<div class="srow"><span class="rk">' + (i + 1) + '</span>' +
      avatarHTML(nameOf(id), 'sm') + '<span class="nm">' + esc(nameOf(id).name) + '</span>' + (R.delta[id] ? '<span class="dl">+' + R.delta[id] + '</span>' : '') +
      '<b>' + R.scores[id] + '</b></div>').join('');
    const verdict = !R.guesses.length ? 'Kimse tahmin etmedi 🤷'
      : R.exact.length ? '🎯 ' + R.exact.map((id) => nameOf(id).name).join(' & ') + ' tam bildi!'
      : '👌 Kimse tam bilemedi, en yakın: ' + R.closest.map((id) => nameOf(id).name).join(' & ');
    const last = K.ti >= K.tn - 1;
    const auto = s.settings.revealMode === 'auto';
    const ctrl = isHost()
      ? '<div class="ctrl"><button class="btn yellow big" data-act="next">' + (last ? '🏆 Sonuçlar' : 'Sıradaki ▶') + '</button></div>'
      : (auto ? '' : '<div class="waiting-pill">Lider bir sonrakine geçecek…</div>');
    mount(kacTop(s, auto ? (last ? 'Sonuçlara geçiliyor' : 'Sıradakine geçiliyor') : null) + kacQuestionCard(s, R.q) +
      '<div class="card center"><div class="muted" style="font-weight:700">Doğru cevap</div><div class="kanswer">' + fmtNum(R.v) + '</div>' +
        '<div class="kreveal" style="text-align:left">' + rows + '</div>' +
        '<div class="ktotal" style="--d:' + after.toFixed(2) + 's">' + esc(verdict) + '</div></div>' +
      '<div class="card kafter" style="--d:' + (after + 0.4).toFixed(2) + 's"><h2>Puan durumu</h2><div class="board">' + board + '</div></div>' +
      ctrl);
    setTimeout(() => Sound.beep(880, 0.2, 'triangle', 0.09), 900);
    if (R.exact.length) setTimeout(() => Sound.fanfare(), after * 1000);
  },
};

function kacFinalMount(s) {
  const F = s.final;
  const lead = F.ranking[0];
  const champs = F.ranking.filter((id) => F.scores[id] === F.scores[lead]);
  let headline;
  if (!F.scores[lead]) headline = '<h1>Kimse puan alamadı 😅</h1><p>Hiç tahmin yapılmamış gibi görünüyor.</p>';
  else if (champs.length > 1) headline = '<h1>🤝 Berabere!</h1><p>' + esc(champs.map((id) => nameOf(id).name).join(' & ')) + ' eşit puan topladı.</p>';
  else headline = '<h1>' + esc(nameOf(lead).av) + ' ' + esc(nameOf(lead).name) + ' kazandı!</h1><p>' + F.scores[lead] + ' puanla arkadaşlarını en iyi tanıyan o 🔢</p>';

  const board = F.ranking.map((id, i) => '<div class="srow big"><span class="rk">' + (i + 1) + '</span>' + avatarHTML(nameOf(id)) +
    '<span class="nm">' + esc(nameOf(id).name) + '<small>' + F.exact[id] + ' tam isabet · ' + F.close[id] + ' en yakın</small></span><b>' + F.scores[id] + '</b></div>').join('');
  const recap = F.recap.map((r) => {
    const who = r.exact.length ? '🎯 ' + r.exact.map((id) => nameOf(id).name).join(' & ')
      : r.closest.length ? '👌 ' + r.closest.map((id) => nameOf(id).name).join(' & ') : '—';
    return '<div><span class="q"><b>' + esc(nameOf(r.asker).name) + ':</b> ' + esc(r.q) + '</span><span class="w">' + fmtNum(r.v) +
      ' <span class="muted">' + esc(who) + '</span></span></div>';
  }).join('');

  mount(
    header() +
    '<div class="phase-title">' + headline + '</div>' +
    podiumHTML(F.ranking, (id) => F.scores[id] + ' puan') +
    '<div class="card" style="border-top-left-radius:0;border-top-right-radius:0"><h2>Puan tablosu 🏅</h2><div class="board">' + board + '</div>' +
      '<p class="muted" style="margin:10px 0 0;font-size:14px">Tam isabet: +' + KAC_EXACT_POINTS + ' · Kimse tam bilemezse en yakın: +' + KAC_CLOSE_POINTS + '</p></div>' +
    '<div class="card"><h2>Bütün sorular</h2><div class="recap">' + recap + '</div></div>' +
    finalFooter(),
    true
  );
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
      : '<span class="tchip muted">' + (c.why === 'off' ? '🔌 yok' : c.why === 'skip' ? '⏭ geçildi' : '⏰ süre doldu') + '</span>').join('');
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
      turnBox + OFFLINE_NOTE +
      roleCardHTML(L, App.peek) +
      clueBoardHTML(s) +
      (isHost() ? '<div class="ctrl"><button class="btn small ghost" data-act="skip">⏭ Sırayı geç</button></div>' : ''));
    if (me) {
      Sound.join();
      const el = $('#clueInput');
      if (el) setTimeout(() => autoFocus(el, true), 50);
    }
  },
  update(s) { updateOffline(s, [s.lie.current]); },
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
    else if (s.game === 'kackac') kacFinalMount(s);
    else if (s.game === 'ikiz') ikizFinalMount(s);
    else if (s.game === 'tele') teleFinalMount(s);
    else if (s.game === 'ayna') aynaFinalMount(s);
    else if (s.game === 'emoji') emoFinalMount(s);
    else if (s.game === 'cogunluk') cogFinalMount(s);
    else if (s.game === 'ikidogru') ikyFinalMount(s);
    else if (s.game === 'sirala') sirFinalMount(s);
    else if (s.game === 'adam') adamFinalMount(s);
    else if (s.game === 'vampir') vampFinalMount(s);
    else if (s.game === 'zar') zarFinalMount(s);
    else if (s.game === 'patates') patFinalMount(s);
    else if (s.game === 'taklit') takFinalMount(s);
    else if (s.game === 'quiz') quizFinalMount(s);
    else if (s.game === 'cinayet') cinFinalMount(s);
    else if (s.game === 'kafe') kafeFinalMount(s);
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
  const share = awardsHTML() + '<div class="ctrl" style="margin-bottom:12px"><button class="btn ghost" data-act="shareCard">📸 Sonucu paylaş</button></div>';
  return share + (isHost()
    ? '<div class="startbar"><button class="btn yellow big block" data-act="lobby">🔁 Yeni tur (lobiye dön)</button></div>'
    : '<div class="waiting-pill">Lider yeni tur başlatabilir 🔁</div>');
}

/* ---------- shareable result card ---------- */

// A few lines that sum up the round, per game.
function shareLines(s) {
  const F = s.final;
  const n = (id) => (nameOf(id) || { name: '?' }).name;
  const names = (ids) => ids.map(n).join(' & ');
  const L = [];
  switch (s.game) {
    case 'hangimiz':
      for (const r of F.recap) if (r.winners.length) L.push(r.text + ' → ' + names(r.winners));
      break;
    case 'kimyazdi':
      if (F.detective.ids.length) L.push('🕵️ En iyi dedektif: ' + names(F.detective.ids));
      if (F.hider.ids.length) L.push('😎 En iyi saklanan: ' + names(F.hider.ids));
      for (const r of F.recap) L.push('“' + r.text + '” → ' + n(r.author));
      break;
    case 'asla':
      if (!F.anon) {
        L.push('✋ En maceracı: ' + n(F.ranking[0]));
        if (F.innocent.length) L.push('😇 En masum: ' + names(F.innocent));
      }
      for (const r of F.recap) L.push('“' + r.text + '” → ' + r.yes + '/' + r.total + ' yaptı');
      break;
    case 'komik':
      if (F.best) L.push('🏆 “' + F.best.text + '” — ' + n(F.best.author));
      for (const r of F.recap) if (r.answers.length) L.push(r.prompt.replace('___', '…') + ' → “' + r.answers[0].text + '”');
      break;
    case 'yalanci':
      L.push('🤥 Yalancı: ' + n(F.liar) + (F.caught ? ' — yakalandı!' : ' — kaçtı!'));
      L.push('🔑 Kelime: ' + F.word + (F.liarWord ? ' · yalancınınki: ' + F.liarWord : ''));
      break;
    case 'kackac':
      for (const r of F.recap) L.push(n(r.asker) + ': ' + r.q + ' → ' + fmtNum(r.v));
      break;
    case 'ikiz':
      for (const g of F.groups) L.push('💞 ' + names(g));
      break;
    case 'tele':
      for (const h of F.history) L.push((h.match ? '🧠 ' : '💥 ') + names(h.pair) + ': ' + h.pair.map((id) => h.words[id] ?? '—').join(' / '));
      break;
    case 'emoji':
      for (const h of F.history) if (h.clue) L.push('🎬 ' + n(h.narr) + ': ' + h.clue + ' → ' + h.title);
      break;
    case 'cogunluk':
      for (const r of F.recap) if (r.total) L.push(r.q + ' → ' + r.yesCount + '/' + r.total + ' evet');
      break;
    case 'ikidogru':
      for (const h of F.history) L.push('🤥 ' + n(h.author) + ': ' + h.lieText);
      break;
    case 'sirala':
      for (const r of F.recap) if (r.top) L.push(n(r.asker) + ': ' + r.q + ' → 👑 ' + n(r.top));
      break;
    case 'kafe':
      F.ranking.slice(0, 3).forEach((id, i) => L.push(['🥇', '🥈', '🥉'][i] + ' ' + F.cafes[id].e + ' ' + F.cafes[id].name + ' · ' + F.scores[id].toLocaleString('tr-TR') + '₺'));
      break;
    case 'cinayet':
      L.push((F.caught ? '🕵️ Katil yakalandı: ' : '🔪 Katil kaçtı: ') + n(F.killer) + ' (' + CIN_CHARS[F.chars[F.killer]].n + ')');
      L.push('📍 ' + CIN_ROOMS[F.room].n + ' · ' + CIN_WEAPONS[F.weapon].e + ' ' + CIN_WEAPONS[F.weapon].n);
      break;
    case 'quiz':
      F.ranking.slice(0, 3).forEach((id, i) => L.push(['🥇', '🥈', '🥉'][i] + ' ' + n(id) + ' · ' + F.scores[id] + ' puan (' + F.right[id] + ' doğru)'));
      break;
    case 'taklit':
      if (F.best) L.push('🏆 En inandırıcı taklit: "' + F.best.text + '" (' + n(F.best.imp) + ', ' + n(F.best.subject) + ' rolünde)');
      for (const id of Object.keys(F.target)) L.push('🥸 ' + n(id) + ' → ' + n(F.target[id]) + ' rolündeydi');
      break;
    case 'zar':
      F.ranking.slice(0, 3).forEach((id, i) => L.push(['🥇', '🥈', '🥉'][i] + ' ' + n(id)));
      L.push('🎲 ' + F.rounds + ' el oynandı');
      break;
    case 'patates':
      for (const h of F.history) L.push('💥 ' + h.prompt + ' → ' + n(h.victim));
      break;
    case 'vampir':
      L.push(VAMP_END_TEXT[F.end]);
      for (const id of F.winners) L.push('🏆 ' + n(id) + ' (' + VAMP_ROLES[F.roles[id]].e + ' ' + VAMP_ROLES[F.roles[id]].n + ')');
      break;
    case 'adam':
      for (const h of F.history) L.push((h.outcome === 'hanged' ? '🪢 ' : '🧩 ') + h.word + (h.solver ? ' → ' + n(h.solver) : ''));
      break;
    case 'ayna':
      for (const h of F.history) L.push('🪞 ' + n(h.mirror) + ': ' + h.q + ' → ' + (h.own ?? '—'));
      break;
  }
  return L.slice(0, 4);
}

function wrapText(g, text, x, y, maxW, lineH, maxLines) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const t = line ? line + ' ' + w : w;
    if (g.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  }
  if (line) lines.push(line);
  const shown = lines.slice(0, maxLines);
  if (lines.length > maxLines) shown[maxLines - 1] = shown[maxLines - 1].replace(/\s*\S*$/, '') + '…';
  shown.forEach((l, i) => g.fillText(l, x, y + i * lineH));
  return y + shown.length * lineH;
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

// Draws the final screen as a 1080×1350 picture (Instagram portrait size).
async function makeShareCard(s) {
  if (document.fonts && document.fonts.ready) await document.fonts.ready;
  const W = 1080;
  const H = 1350;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const font = (weight, size) => weight + ' ' + size + 'px "Baloo 2", system-ui, sans-serif';

  const grad = g.createLinearGradient(0, 0, W * 0.6, H);
  grad.addColorStop(0, '#5b2be0');
  grad.addColorStop(0.55, '#8a3ae8');
  grad.addColorStop(1, '#ff4f9a');
  g.fillStyle = grad;
  g.fillRect(0, 0, W, H);
  g.fillStyle = 'rgba(255,255,255,.08)';
  for (let y = 23; y < H; y += 46) for (let x = 23; x < W; x += 46) { g.beginPath(); g.arc(x, y, 3, 0, Math.PI * 2); g.fill(); }

  // Logo + game name
  g.font = font(800, 96);
  const logoW = g.measureText('Hangimiz?').width;
  g.textAlign = 'left';
  g.fillStyle = '#fff';
  g.fillText('Hangimiz', W / 2 - logoW / 2, 140);
  g.fillStyle = '#ffcc2e';
  g.fillText('?', W / 2 - logoW / 2 + g.measureText('Hangimiz').width, 140);
  g.textAlign = 'center';
  const game = GAMES[s.game];
  g.font = font(700, 44);
  g.fillStyle = 'rgba(255,255,255,.92)';
  g.fillText(game.emoji + ' ' + game.name, W / 2, 205);

  // Headline from the final screen
  const h1 = ($('.phase-title h1') || {}).textContent || '';
  const sub = ($('.phase-title p') || {}).textContent || '';
  g.fillStyle = '#fff';
  g.font = font(800, 68);
  let y = wrapText(g, h1, W / 2, 310, W - 120, 76, 2);
  g.font = font(600, 38);
  g.fillStyle = 'rgba(255,255,255,.9)';
  y = wrapText(g, sub, W / 2, y + 4, W - 160, 46, 2);

  // Podium (read from the screen so every game's own wording is kept)
  const pods = $$('.podium .pod').map((el) => ({
    place: el.classList.contains('p1') ? 1 : el.classList.contains('p2') ? 2 : el.classList.contains('p3') ? 3 : 0,
    av: (el.querySelector('.av') || {}).textContent || '',
    col: el.querySelector('.av') ? el.querySelector('.av').style.getPropertyValue('--c') : '#ddd',
    name: (el.querySelector('.name') || {}).textContent || '',
    sub: (el.querySelector('.sub') || {}).textContent || '',
  })).filter((p) => p.place && p.name);
  if (pods.length) {
    const base = y + 470;
    const heights = { 1: 170, 2: 120, 3: 85 };
    const xs = { 2: W / 2 - 310, 1: W / 2, 3: W / 2 + 310 };
    for (const p of pods) {
      const x = xs[p.place];
      const top = base - heights[p.place];
      g.fillStyle = p.place === 1 ? '#ffcc2e' : 'rgba(255,255,255,.25)';
      roundRect(g, x - 135, top, 270, heights[p.place] + 30, 26);
      g.fill();
      g.fillStyle = p.place === 1 ? '#4a3500' : '#fff';
      g.font = font(800, 64);
      g.fillText(String(p.place), x, top + 78);
      const cy = top - 200;
      g.fillStyle = p.col || '#ddd';
      g.beginPath();
      g.arc(x, cy, 72, 0, Math.PI * 2);
      g.fill();
      g.font = '84px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif';
      g.fillText(p.av, x, cy + 30);
      g.fillStyle = '#fff';
      g.font = font(800, 44);
      wrapText(g, p.name, x, cy + 125, 280, 46, 1);
      g.font = font(600, 30);
      g.fillStyle = 'rgba(255,255,255,.9)';
      wrapText(g, p.sub, x, cy + 165, 280, 34, 1);
    }
    y = base + 60;
  } else {
    y += 40;
  }

  // Highlights card
  const lines = shareLines(s);
  if (lines.length) {
    g.font = font(700, 36);
    const top = y + 10;
    const bottom = Math.min(H - 100, top + 50 + lines.length * 70);
    g.fillStyle = '#fff';
    roundRect(g, 60, top, W - 120, bottom - top, 34);
    g.fill();
    g.textAlign = 'left';
    g.fillStyle = '#23164a';
    let ly = top + 66;
    for (const line of lines) {
      if (ly > bottom - 20) break;
      ly = wrapText(g, line, 100, ly, W - 200, 44, 2) + 24;
    }
    g.textAlign = 'center';
  }

  g.font = font(700, 30);
  g.fillStyle = 'rgba(255,255,255,.85)';
  g.fillText('bugratekinsahin.github.io/hangimiz', W / 2, H - 50);

  return new Promise((resolve) => c.toBlob(resolve, 'image/png'));
}

function closeShare() {
  const m = $('#shareModal');
  if (m) m.remove();
  if (App.shareUrl) { URL.revokeObjectURL(App.shareUrl); App.shareUrl = null; }
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
    // No deadline: in "Süresiz" mode hide the timer, otherwise show it as unlimited.
    el.hidden = !end && !!(App.state && App.state.settings && App.state.settings.timeMode === 'untimed');
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
      if (sec !== App.lastSecond && sec <= 5 && sec > 0 && Prefs.get('countTick')) Sound.tick();
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
  async shareCard() {
    toast('Kart hazırlanıyor… 🎨', 1500);
    const blob = await makeShareCard(App.state);
    if (!blob) { toast('Kart oluşturulamadı 😕'); return; }
    closeShare();
    App.shareFile = new File([blob], 'hangimiz-sonuc.png', { type: 'image/png' });
    App.shareUrl = URL.createObjectURL(blob);
    const canShare = !!(navigator.canShare && navigator.canShare({ files: [App.shareFile] }));
    const m = document.createElement('div');
    m.id = 'shareModal';
    m.className = 'modal';
    m.innerHTML = '<div class="modalbox"><img src="' + App.shareUrl + '" alt="Sonuç kartı">' +
      '<div class="ctrl">' + (canShare ? '<button class="btn yellow" data-act="doShare">📤 Paylaş</button>' : '') +
      '<a class="btn" href="' + App.shareUrl + '" download="hangimiz-sonuc.png">⬇️ İndir</a>' +
      '<button class="btn ghost" data-act="closeShare">Kapat</button></div>' +
      '<p class="muted center" style="margin:8px 0 0;font-size:14px">Telefonda resme basılı tutarak da kaydedebilirsin.</p></div>';
    document.body.appendChild(m);
  },
  doShare() {
    navigator.share({ files: [App.shareFile], title: 'Hangimiz?', text: 'Hangimiz? sonuçlarımız 😂' }).catch(() => {});
  },
  closeShare() { closeShare(); },
  spinGame() { send({ t: 'spinGame' }); },
  voteGame() { send({ t: 'voteGame' }); },
  voteEnd() { send({ t: 'voteEnd' }); },
  voteCancel() { send({ t: 'voteCancel' }); },
  gvote(el) { Sound.click(); send({ t: 'gvote', id: el.dataset.id }); },
  theme() {
    const t = isDark() ? 'light' : 'dark';
    applyTheme(t);
    store.set('hz-theme', t);
    $$('[data-act=theme]').forEach((b) => { b.textContent = isDark() ? '☀️' : '🌙'; });
  },
  myBadges() {
    const col = store.get('hz-badges') || {};
    const got = Object.keys(BADGES).filter((k) => col[k]).length;
    const m = document.createElement('div');
    m.id = 'badgeModal';
    m.className = 'modal';
    m.innerHTML = '<div class="modalbox"><div class="chathead"><b>🏷️ Rozet koleksiyonum</b><button class="pill dark" data-act="closeBadges">✕</button></div>' +
      '<p class="muted" style="margin:0 0 10px">' + got + ' / ' + Object.keys(BADGES).length + ' rozet açıldı. Oyunların sonunda kazanılır.</p><div class="bgrid">' +
      Object.entries(BADGES).map(([k, b]) => '<div class="bcell ' + (col[k] ? '' : 'locked') + '"><div class="be">' + b.e + '</div><b>' + esc(b.n) + '</b>' +
        '<small>' + esc(b.d) + '</small>' + (col[k] ? '<span class="bcount">×' + col[k] + '</span>' : '') + '</div>').join('') + '</div></div>';
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  },
  settings() {
    const old = $('#prefModal');
    if (old) old.remove();
    const m = document.createElement('div');
    m.id = 'prefModal';
    m.className = 'modal';
    m.innerHTML = '<div class="modalbox">' + prefsHTML() + '</div>';
    m.addEventListener('click', (e) => { if (e.target === m) m.remove(); });
    document.body.appendChild(m);
  },
  closePrefs() { const m = $('#prefModal'); if (m) m.remove(); },
  prefToggle(el) {
    const k = el.dataset.k;
    if (k === 'sound') {
      Sound.toggle();
      $$('[data-act=mute]').forEach((b) => { b.textContent = Sound.muted ? '🔇' : '🔊'; });
    } else {
      Prefs.set(k, !Prefs.get(k));
      if (k === 'vibrate') buzz(80);
    }
    Sound.click();
    $('#prefModal .modalbox').innerHTML = prefsHTML();
  },
  prefTheme(el) {
    const v = el.dataset.v;
    if (v === 'auto') { delete document.documentElement.dataset.theme; store.del('hz-theme'); applyTheme(); }
    else { applyTheme(v); store.set('hz-theme', v); }
    $$('[data-act=theme]').forEach((b) => { b.textContent = isDark() ? '☀️' : '🌙'; });
    $('#prefModal .modalbox').innerHTML = prefsHTML();
  },
  closeBadges() { const m = $('#badgeModal'); if (m) m.remove(); },
  chat() {
    chatDom();
    App.chatOpen = !App.chatOpen;
    $('#chatPanel').hidden = !App.chatOpen;
    document.body.classList.toggle('chat-open', App.chatOpen);
    $('#chatPeek').hidden = true;
    if (App.chatOpen) {
      const s = App.state;
      App.chatSeen = s && s.chat && s.chat.length ? s.chat[s.chat.length - 1].id : 0;
      renderChatList(true);
      updateChatBadge();
      if (window.matchMedia('(pointer:fine)').matches) $('#chatInput').focus();
    }
  },
  chatSend() {
    const el = $('#chatInput');
    const text = el.value.trim();
    if (!text) return;
    el.value = '';
    send({ t: 'chat', text });
    // Your own message should always bring you back to the bottom.
    const list = $('#chatList');
    if (list) list.scrollTop = list.scrollHeight;
  },
  react(el) { send({ t: 'react', e: el.dataset.e }); },
  // The full emoji keyboard for chat messages (same palette as Emojiyle Anlat).
  chatEmo() {
    const box = $('#chatEmo');
    box.hidden = !box.hidden;
    if (!box.hidden && !box.innerHTML) chatEmoPaint(App.chatEmoTab || 0);
  },
  chatEmoTab(el) { App.chatEmoTab = Number(el.dataset.i); chatEmoPaint(App.chatEmoTab); },
  chatEmoPick(el) {
    const inp = $('#chatInput');
    if ((inp.value + el.dataset.e).length > CHAT_MAX) return;
    inp.value += el.dataset.e;
  },
  toggleLook() {
    App.lookOpen = !App.lookOpen;
    const box = $('#lookBox');
    if (box) box.innerHTML = lookBoxHTML(); else render();
  },
  pickav(el) { setLook({ av: el.dataset.v, pic: null }); if (!$('#lookBox')) render(); },
  pickpic() { const g = store.get('hz-google'); if (g && validPic(g.pic)) setLook({ pic: g.pic }); if (!$('#lookBox')) render(); },
  gOut() {
    store.del('hz-google');
    setLook({ pic: null });
    try { if (window.google) google.accounts.id.disableAutoSelect(); } catch { /* not loaded */ }
    googleMount();
  },
  pickcol(el) { setLook({ col: el.dataset.v }); if (!$('#lookBox')) render(); },
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
  iword() { sendWord('#ikizWord', 'iword'); },
  iguess(el) { Sound.click(); send({ t: 'iguess', target: el.dataset.id }); },
  tword() { sendWord('#teleWord', 'tword'); },
  tbet(el) { Sound.click(); send({ t: 'tbet', v: el.dataset.v }); },
  asend() { sendWord('#aynaText', 'asend'); },
  atoggle(el) {
    const id = el.dataset.id;
    if (App.aynaAcc.has(id)) App.aynaAcc.delete(id); else App.aynaAcc.add(id);
    const on = App.aynaAcc.has(id);
    el.classList.toggle('on', on);
    el.querySelector('.mark').textContent = on ? '✅' : '❌';
  },
  ajudge() { Sound.click(); send({ t: 'ajudge', accepted: [...(App.aynaAcc || [])] }); },
  ereroll() { Sound.click(); send({ t: 'ereroll' }); },
  emoTab(el) {
    App.emoTab = Number(el.dataset.i);
    $$('.emotab').forEach((b) => b.classList.toggle('on', b === el));
    $('#emoGrid').innerHTML = emoGridHTML(App.emoTab);
    $('#emoGrid').scrollTop = 0;
  },
  emoPick(el) {
    const inp = $('#emoClue');
    if (!inp) return;
    if (emojiCount(inp.value) >= EMO_MAX_CLUE) { toast('En fazla ' + EMO_MAX_CLUE + ' emoji 🙂'); return; }
    inp.value += el.dataset.e;
    emoCountPaint();
    Sound.beep(880, 0.03, 'triangle', 0.04);
  },
  emoBack() {
    const inp = $('#emoClue');
    if (inp) inp.value = graphemes(inp.value).slice(0, -1).join('');
    emoCountPaint();
  },
  // Phones: let people open their own emoji keyboard if they prefer.
  emoKbd() {
    const inp = $('#emoClue');
    if (!inp) return;
    inp.removeAttribute('inputmode');
    inp.focus();
  },
  eclue() {
    const el = $('#emoClue');
    const text = el ? el.value.trim() : '';
    if (!isEmojiOnly(text)) { toast('Sadece emoji kullanabilirsin 🙂 Harf ve rakam yok!'); if (el) el.focus(); return; }
    Sound.click();
    send({ t: 'eclue', text });
  },
  eguess() {
    const el = $('#emoGuess');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    el.focus();
    send({ t: 'eguess', text });
  },
  cyes(el) { App.cogYes = el.dataset.v === '1'; Sound.click(); cogPaint(); },
  cpred(el) {
    const n = App.state.cog.n;
    App.cogPred = Math.max(0, Math.min(n, App.cogPred + Number(el.dataset.d)));
    cogPaint();
  },
  csend() {
    if (App.cogYes == null) { toast('Önce Evet ya da Hayır seç 🙂'); return; }
    Sound.click();
    send({ t: 'cans', yes: App.cogYes, pred: App.cogPred });
  },
  ilie(el) { App.ikyLie = Number(el.dataset.i); Sound.click(); ikyPaint(); },
  iwrite() {
    const list = $$('.iky-in').map((x) => x.value.trim());
    if (list.some((x) => !x)) { toast('3 cümlenin hepsini yaz 🙂'); return; }
    if (App.ikyLie == null) { toast('Hangisi yalan? Yanındaki 🤥 ile işaretle'); return; }
    Sound.click();
    send({ t: 'iwrite', list, lie: App.ikyLie });
  },
  ipick(el) { Sound.click(); send({ t: 'ipick', idx: Number(el.dataset.i) }); },
  sidea() {
    const el = $('#sirQ');
    const pool = SIR_IDEAS.filter((x) => x !== el.value);
    el.value = pool[Math.floor(Math.random() * pool.length)];
    Sound.click();
  },
  sask() {
    const el = $('#sirQ');
    const q = el ? el.value.trim() : '';
    if (!q) { toast('Önce sorunu yaz 🙂'); if (el) el.focus(); return; }
    Sound.click();
    send({ t: 'sask', q });
  },
  spick(el) {
    const id = el.dataset.id;
    const i = App.sirOrder.indexOf(id);
    if (i >= 0) App.sirOrder.splice(i, 1); else App.sirOrder.push(id);
    Sound.click();
    sirPaint();
  },
  sreset() { App.sirOrder = []; sirPaint(); },
  srank() { Sound.click(); send({ t: 'srank', order: App.sirOrder }); },
  kPrice(el) {
    App.kPrice = Math.max(15, Math.min(150, App.kPrice + Number(el.dataset.d)));
    kafePaint();
  },
  kInv(el) { App.kInv = el.dataset.k; Sound.click(); kafePaint(); },
  kSabType(el) { App.kSab = App.kSab === el.dataset.k ? null : el.dataset.k; Sound.click(); kafePaint(); },
  kSend() {
    let sab = null;
    if (App.kSab) {
      const t = $('#kSabTarget').value;
      if (!t) { toast('Sabotaj için bir rakip seç'); return; }
      sab = { type: App.kSab, target: t };
    }
    Sound.click();
    send({ t: 'kplan', price: App.kPrice, inv: App.kInv, sab });
  },
  cAlibi(el) {
    if (App.state.cin.declared[App.state.you] >= 0) return;
    App.cinRoom = Number(el.dataset.r);
    $$('[data-act=cAlibi]').forEach((b) => b.classList.toggle('on', b === el));
    const btn = $('#cinSay');
    btn.disabled = false;
    btn.textContent = '🗣️ İfadem: ' + CIN_ROOMS[App.cinRoom].n;
    Sound.click();
  },
  cSay() {
    if (App.cinRoom == null) return;
    Sound.click();
    send({ t: 'calibi', room: App.cinRoom });
  },
  cReady() { Sound.click(); send({ t: 'cready' }); },
  cFrame() {
    const sel = $('#cinFrame');
    if (!sel || !sel.value) { toast('Önce birini seç'); return; }
    send({ t: 'cframe', target: sel.value });
  },
  cSus(el) { App.cinSus = el.dataset.id; Sound.click(); cinVotePaint(); },
  cWeapon(el) { App.cinW = Number(el.dataset.w); Sound.click(); cinVotePaint(); },
  cVote() {
    if (!App.cinSus || App.cinW == null) { toast('Bir şüpheli ve bir silah seç 🙂'); return; }
    Sound.click();
    send({ t: 'cvote', s: App.cinSus, w: App.cinW });
  },
  qPick(el) {
    if (App.state.quiz.myAns) return;
    Sound.click();
    $$('.qopt').forEach((b) => b.classList.toggle('picked', b === el));
    send({ t: 'qans', i: Number(el.dataset.i) });
  },
  qMapSend() {
    if (!App.qPin || App.state.quiz.myAns) return;
    Sound.click();
    send({ t: 'qans', lat: App.qPin.lat, lng: App.qPin.lng });
  },
  takSend() {
    const real = $('#takReal').value.trim();
    const fake = $('#takFake').value.trim();
    if (!real || !fake) { toast('İki cevabı da yaz 🙂'); (real ? $('#takFake') : $('#takReal')).focus(); return; }
    Sound.click();
    send({ t: 'tans', real, fake });
  },
  takVote(el) { Sound.click(); send({ t: 'tvote', subject: el.dataset.s, idx: Number(el.dataset.i) }); },
  takGuess(el) { Sound.click(); send({ t: 'tguess', target: el.dataset.id }); },
  zQ(el) {
    const Z = App.state.zar;
    App.zarQ = Math.max(1, Math.min(Z.total, App.zarQ + Number(el.dataset.d)));
    zarPaint();
  },
  zF(el) { App.zarF = Number(el.dataset.f); Sound.click(); zarPaint(); },
  zBid() { Sound.click(); send({ t: 'zbid', q: App.zarQ, f: App.zarF }); },
  zCall() { Sound.beep(220, 0.2, 'square', 0.05); send({ t: 'zcall' }); },
  pSend() {
    const el = $('#patIn');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    send({ t: 'pans', text });
  },
  pDown() { Sound.click(); send({ t: 'pdown' }); },
  vReady() { Sound.click(); send({ t: 'vready' }); },
  vKind(el) { App.vSel = { kind: el.dataset.k, target: null }; Sound.click(); vampActPaint(); },
  vPick(el) { App.vSel.target = el.dataset.id; Sound.click(); vampActPaint(); },
  vSend() {
    const sel = App.vSel;
    if (!sel || !sel.kind) return;
    if (VAMP_KINDS[sel.kind].t !== 'use' && !sel.target) { toast('Önce birini seç 🙂'); return; }
    Sound.click();
    send({ t: 'vact', kind: sel.kind, target: sel.target });
  },
  vPass() { App.vSel = { kind: 'pass', target: null }; Sound.click(); send({ t: 'vact', kind: 'pass' }); },
  vVote(el) { Sound.click(); send({ t: 'vvote', target: el.dataset.id }); },
  vRole() { App.vRoleOpen = !App.vRoleOpen; const el = $('#vRoleCard'); if (el) el.hidden = !App.vRoleOpen; },
  vChat() {
    const el = $('#vchatIn');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    send({ t: 'vchat', text });
  },
  hmDice() {
    const p = adamPick('mix', [adamClean($('#adamWord').value)]);
    $('#adamWord').value = p.word;
    $('#adamHint').value = p.hint;
    Sound.click();
  },
  hmWord() {
    const el = $('#adamWord');
    const word = adamClean(el ? el.value : '');
    if (adamLetterCount(word) < 2) { toast('En az 2 harflik bir kelime yaz 🙂 (rakam ve işaret olmaz)'); if (el) el.focus(); return; }
    Sound.click();
    send({ t: 'hword', word, hint: $('#adamHint').value });
  },
  hmKey(el) {
    if (!App.state.adam.myTurn) return;
    send({ t: 'hletter', l: el.dataset.l });
  },
  hmSolve() {
    const el = $('#adamSolve');
    const text = el ? el.value.trim() : '';
    if (!text) return;
    el.value = '';
    send({ t: 'hsolve', text });
  },
  kask() {
    const q = ($('#kacQ') || {}).value || '';
    const raw = ($('#kacAns') || {}).value || '';
    if (!q.trim()) { toast('Önce sorunu yaz 🙂'); $('#kacQ').focus(); return; }
    if (parseKacNumber(raw) == null) { toast('Doğru cevabı sayı olarak yaz 🔢'); $('#kacAns').focus(); return; }
    Sound.click();
    send({ t: 'kask', q, v: raw });
  },
  kidea() {
    const el = $('#kacQ');
    const pool = KAC_IDEAS.filter((x) => x !== el.value);
    el.value = pool[Math.floor(Math.random() * pool.length)];
    Sound.click();
    const a = $('#kacAns');
    if (a) a.focus();
  },
  kguess() {
    const raw = ($('#kacGuess') || {}).value || '';
    if (parseKacNumber(raw) == null) { toast('Tahminini sayı olarak yaz 🔢'); $('#kacGuess').focus(); return; }
    Sound.click();
    send({ t: 'kguess', v: raw });
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

document.addEventListener('compositionend', (e) => {
  if (e.target.id === 'emoClue') e.target.dispatchEvent(new Event('input', { bubbles: true }));
});

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('q-input')) queueDrafts();
  if (e.target.id === 'cd') e.target.value = cleanCode(e.target.value);
  if (e.target.id === 'emoClue' && !e.isComposing) {
    const v = emojiFilter(e.target.value);
    if (v !== e.target.value) { e.target.value = v; toast('Sadece emoji yazabilirsin 🙂 Aşağıdan seçebilirsin', 2200); }
    if (emojiCount(e.target.value) > EMO_MAX_CLUE) {
      const keep = [];
      for (const g of graphemes(e.target.value)) { if (g.trim() && keep.filter((x) => x.trim()).length >= EMO_MAX_CLUE) break; keep.push(g); }
      e.target.value = keep.join('');
      toast('En fazla ' + EMO_MAX_CLUE + ' emoji 🙂');
    }
    emoCountPaint();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.id === 'chatInput') { e.preventDefault(); doAction('chatSend'); return; }
  if (e.key === 'Enter' && e.target.id === 'clueInput') { e.preventDefault(); doAction('clue'); return; }
  if (e.key === 'Enter' && e.target.id === 'kacQ') { e.preventDefault(); const a = $('#kacAns'); if (a) a.focus(); return; }
  if (e.key === 'Enter' && e.target.id === 'kacAns') { e.preventDefault(); doAction('kask'); return; }
  if (e.key === 'Enter' && e.target.id === 'kacGuess') { e.preventDefault(); doAction('kguess'); return; }
  if (e.key === 'Enter' && e.target.id === 'ikizWord') { e.preventDefault(); doAction('iword'); return; }
  if (e.key === 'Enter' && e.target.id === 'teleWord') { e.preventDefault(); doAction('tword'); return; }
  if (e.key === 'Enter' && e.target.id === 'emoClue') { e.preventDefault(); doAction('eclue'); return; }
  if (e.key === 'Enter' && e.target.id === 'emoGuess') { e.preventDefault(); doAction('eguess'); return; }
  if (e.key === 'Enter' && (e.target.id === 'adamWord' || e.target.id === 'adamHint')) { e.preventDefault(); doAction('hmWord'); return; }
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'takReal') { e.preventDefault(); $('#takFake').focus(); return; }
  if (e.key === 'Enter' && !e.shiftKey && e.target.id === 'takFake') { e.preventDefault(); doAction('takSend'); return; }
  if (e.key === 'Enter' && e.target.id === 'patIn') { e.preventDefault(); doAction('pSend'); return; }
  if (e.key === 'Enter' && e.target.id === 'vchatIn') { e.preventDefault(); doAction('vChat'); return; }
  if (e.key === 'Enter' && e.target.id === 'adamSolve') { e.preventDefault(); doAction('hmSolve'); return; }
  if (adamTypedLetter(e)) return;
  if (e.key === 'Enter' && e.target.id === 'sirQ') { e.preventDefault(); doAction('sask'); return; }
  if (e.key === 'Enter' && e.target.id === 'aynaText') { e.preventDefault(); doAction('asend'); return; }
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

applyTheme(store.get('hz-theme'));

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
