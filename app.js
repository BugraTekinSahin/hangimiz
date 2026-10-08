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
    { key: 'category', label: 'Kategori', type: 'choice', def: 'mix', options: [['mix', 'Karışık'], ['film', 'Filmler'], ['dizi', 'Diziler'], ['cizgi', 'Çizgi filmler']] },
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
  desc: 'Herkes kendisi hakkında 3 cümle yazar, biri yalan! Sırayla herkesin yalanını bulmaya çalışırsınız.',
  minPlayers: 2,
  defs: [
    { key: 'writeTime', label: 'Yazma süresi', type: 'num', def: 90, min: 30, max: 240, step: 10, unit: 'sn' },
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
const GAME_ORDER = ['hangimiz', 'kimyazdi', 'asla', 'komik', 'yalanci', 'kackac', 'ikiz', 'tele', 'ayna', 'emoji', 'cogunluk', 'ikidogru', 'sirala'];
// Games with their own flow instead of write → answer → results.
const GAME_PHASE = { yalanci: 'lie', kackac: 'kac', ikiz: 'ikiz', tele: 'tele', ayna: 'ayna', emoji: 'emo', cogunluk: 'cog', ikidogru: 'iky', sirala: 'sir' };

const EMO_POINTS = [300, 200];      // 1st and 2nd correct guess; everyone after gets EMO_POINTS_REST
const EMO_POINTS_REST = 100;
const EMO_NARRATOR_POINTS = 50;      // narrator, per player who got it
const EMO_REROLLS = 2;
const COG_EXACT_POINTS = 200;
const COG_CLOSE_POINTS = 100;        // off by one
const IKY_FOUND_POINTS = 100;
const IKY_FOOL_POINTS = 50;          // author, per player who picked a true statement
const SIR_POS_POINTS = 50;           // per correctly placed person
const SIR_PERFECT_BONUS = 100;

// t = answer shown, a = other accepted spellings.
const EMO_ITEMS = {
  film: { name: 'Film', items: [
    { t: 'Titanik', a: ['titanic'] }, { t: 'Aslan Kral', a: ['lion king', 'the lion king'] }, { t: 'Harry Potter' },
    { t: 'Örümcek Adam', a: ['spiderman', 'spider man'] }, { t: 'Buz Devri', a: ['ice age'] }, { t: 'Shrek' },
    { t: 'Karayip Korsanları', a: ['pirates of the caribbean'] }, { t: 'Yüzüklerin Efendisi', a: ['lord of the rings'] },
    { t: 'Avatar' }, { t: 'Jurassic Park', a: ['jurassic world'] }, { t: 'Kayıp Balık Nemo', a: ['nemo', 'finding nemo'] },
    { t: 'Oyuncak Hikayesi', a: ['toy story'] }, { t: 'Karlar Ülkesi', a: ['frozen'] }, { t: 'Hızlı ve Öfkeli', a: ['fast and furious'] },
    { t: 'Matrix' }, { t: 'Batman' }, { t: 'Süpermen', a: ['superman'] }, { t: 'Yıldız Savaşları', a: ['star wars'] },
    { t: 'Recep İvedik' }, { t: 'Hababam Sınıfı' }, { t: 'Arabalar', a: ['cars'] }, { t: 'Minyonlar', a: ['minions'] },
    { t: 'Kung Fu Panda' }, { t: 'Madagaskar', a: ['madagascar'] }, { t: 'Alaaddin', a: ['aladdin'] }, { t: 'King Kong' },
    { t: 'Joker' }, { t: 'Barbie' }, { t: 'Ters Yüz', a: ['inside out'] }, { t: 'Terminatör', a: ['terminator'] },
    { t: 'Demir Adam', a: ['iron man'] }, { t: 'Yenilmezler', a: ['avengers'] }, { t: 'Jaws', a: ['denizkızı', 'jaws köpekbalığı'] },
  ] },
  dizi: { name: 'Dizi', items: [
    { t: 'Kurtlar Vadisi' }, { t: 'Leyla ile Mecnun' }, { t: 'Squid Game', a: ['kalamar oyunu'] }, { t: 'Stranger Things' },
    { t: 'Prison Break' }, { t: 'Game of Thrones', a: ['taht oyunları'] }, { t: 'Breaking Bad' }, { t: 'Avrupa Yakası' },
    { t: 'Ezel' }, { t: 'Muhteşem Yüzyıl' }, { t: 'Friends' }, { t: 'Sherlock' }, { t: 'La Casa de Papel', a: ['money heist', 'para soygunu'] },
    { t: 'Wednesday' }, { t: 'Peaky Blinders' }, { t: 'Diriliş Ertuğrul' }, { t: 'Behzat Ç' }, { t: 'The Walking Dead', a: ['walking dead'] },
  ] },
  cizgi: { name: 'Çizgi film', items: [
    { t: 'Sünger Bob', a: ['spongebob', 'sünger bob kare pantolon'] }, { t: 'Tom ve Jerry', a: ['tom and jerry', 'tom jerry'] },
    { t: 'Şirinler', a: ['smurfs'] }, { t: 'Pokemon', a: ['pokémon', 'pikachu'] }, { t: 'Ben 10' }, { t: 'Kral Şakir' },
    { t: 'Rafadan Tayfa' }, { t: 'Pepee' }, { t: 'Scooby Doo' }, { t: 'Simpsonlar', a: ['simpsons', 'the simpsons'] },
    { t: 'Sürekli Dizi', a: ['regular show'] }, { t: 'Kuzucuk Şon', a: ['shaun the sheep'] }, { t: 'Doraemon' }, { t: 'Naruto' },
    { t: 'Dragon Ball' }, { t: 'Ninja Kaplumbağalar', a: ['ninja turtles'] }, { t: 'Mickey Mouse', a: ['miki fare'] },
    { t: 'Pembe Panter', a: ['pink panther'] }, { t: 'Garfield' }, { t: 'Temel Reis', a: ['popeye'] }, { t: 'Red Kit', a: ['lucky luke'] },
  ] },
};

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
  hz_king: { e: '👑', n: 'Hangimiz Kralı', d: "Hangimiz?'de en çok unvanı kaptın" },
  hz_star: { e: '⭐', n: 'Herkesin Gözdesi', d: "Hangimiz?'de en çok oyu sen aldın" },
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
  ay_openbook: { e: '📖', n: 'Açık Kitap', d: "Ayna'da seni en çok kişi bildi" },
};

const CHAT_MAX = 200;           // characters per message
const CHAT_KEEP = 40;           // messages the room remembers
const CHAT_REACTIONS = ['😂', '😮', '👏', '🔥', '😍', '💀', '🤔', '👍'];

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
      if (validLook(msg.look)) { p.av = msg.look.av; p.col = msg.look.col; }
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
      id, name, av, col,
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
        const text = String(msg.text ?? '').trim().slice(0, 60);
        if (!isEmojiOnly(text)) { this.tell(pid, { t: 'toast', text: 'Sadece emoji kullanabilirsin 🙂 Harf ve rakam yok!' }); return; }
        r.clue = text;
        r.step = 'guess';
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
        if (S.phase !== 'iky' || r.step !== 'write' || !r.roster.includes(pid) || !Array.isArray(msg.list)) return;
        const list = msg.list.slice(0, 3).map((x) => String(x ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_Q_LEN));
        const lie = Math.round(Number(msg.lie));
        if (list.length !== 3 || list.some((x) => !x) || ![0, 1, 2].includes(lie)) return;
        r.stmts[pid] = { list, lie };
        this.changed();
        this.ikyCheck();
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
    S.chat = (S.chat || []).concat({ id: S.chatSeq, from: p.id, name: p.name, av: p.av, col: p.col, ...body }).slice(-CHAT_KEEP);
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
    if (S.game === 'kackac') this.setupKac(S.round, now);
    for (const id of S.order) S.players[id].ready = false;
    if (S.game === 'ikiz') this.setupIkiz(S.round);
    if (S.game === 'tele') this.setupTele(S.round);
    if (S.game === 'ayna') this.setupAyna(S.round);
    if (S.game === 'emoji') this.setupEmo(S.round);
    if (S.game === 'cogunluk') this.setupCog(S.round);
    if (S.game === 'ikidogru') this.setupIky(S.round);
    if (S.game === 'sirala') this.setupSir(S.round);
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
    if (r.step === 'guess' && this.emoAllGuessed()) this.emoReveal();
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

  setupIky(r) {
    Object.assign(r, { step: 'write', stmts: {}, history: [], scores: this.zeroScores(r) });
    this.setStepDeadline(r.cfg.writeTime);
  },

  ikyStartGuess() {
    const S = this.S;
    const r = S.round;
    r.turns = shuffle(r.roster.filter((id) => r.stmts[id]));
    if (!r.turns.length) {
      S.phase = 'lobby';
      S.round = null;
      S.notice = 'Kimse cümlelerini yazmadı 😅 Bir daha deneyin!';
      this.changed();
      return;
    }
    // Each author's three lines are shown in a fixed random order.
    r.order = {};
    for (const id of r.turns) r.order[id] = shuffle([0, 1, 2]);
    r.ti = 0;
    this.ikyBegin();
  },

  ikyBegin() {
    const r = this.S.round;
    if (r.ti >= r.turns.length) { this.ikyFinish(); return; }
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
    if (r.step === 'write') this.ikyStartGuess();
    else if (r.step === 'guess') this.ikyReveal();
    else this.ikyNext();
  },

  ikyCheck() {
    const r = this.S.round;
    const live = this.liveIds();
    if (!live.length) return;
    if (r.step === 'write' && live.every((id) => r.stmts[id])) this.ikyStartGuess();
    else if (r.step === 'guess') {
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
    }
    if (S.phase === 'ikiz' && r) this.ikizCheck();
    if (S.phase === 'tele' && r) this.teleCheck();
    if (S.phase === 'ayna' && r) this.aynaCheck();
    if (S.phase === 'emo' && r) this.emoCheck();
    if (S.phase === 'cog' && r) this.cogCheck();
    if (S.phase === 'iky' && r) this.ikyCheck();
    if (S.phase === 'sir' && r) this.sirCheck();
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
        return { id, name: p.name, av: p.av, col: p.col, connected: p.connected, ready: p.ready, inRound: !!(r && r.roster.includes(id)), badges: p.badges || null };
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
      const author = r.step === 'write' ? null : r.turns[r.ti];
      const done = {};
      for (const id of r.roster) done[id] = r.step === 'write' ? !!r.stmts[id] : id !== author && r.picks && r.picks[id] != null;
      pub.stepKey = r.step + (r.ti || 0);
      pub.iky = {
        step: r.step, done, mine: r.step === 'write' ? r.stmts[pid] || null : null,
        ti: r.ti || 0, tn: r.turns ? r.turns.length : 0, author, amAuthor: pid === author,
        list: author ? r.order[author].map((i) => r.stmts[author].list[i]) : null,
        myPick: r.picks && r.picks[pid] != null ? r.picks[pid] : null,
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
      return r.step !== 'reveal' && r.item && [r.item.t, ...(r.item.a || [])].some((x) => has(x)) ? SHADOW : null;
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

function isEmojiOnly(t) {
  return !!t && !/[\p{L}\p{N}]/u.test(t) && /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u.test(t);
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

function emoDistance(guess, item) {
  const g = normWord(guess);
  return Math.min(...[item.t, ...(item.a || [])].map(normWord).map((a) => levenshtein(a, g) - emoSlack(a.length)));
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

function header(extra = '') {
  const chat = App.state ? '<button class="pill" data-act="chat" title="Sohbet">💬<span class="badge" id="chatBadge" hidden></span></button>' : '';
  return '<div class="top"><div class="logo">Hangimiz<span>?</span></div><div class="row">' + extra + chat +
    themePill() + '<button class="pill" data-act="mute" title="Ses">' + (Sound.muted ? '🔇' : '🔊') + '</button></div></div>';
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
    '<div class="toprow">' + themePill() + '</div>' +
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div>' +
    '<p>Arkadaşlarınla telefondan oynanan parti oyunları.<br>Oda kur, linki at, gerisi kendiliğinden!</p>' +
    '<div class="bubbles"><span>En zekimiz kim? 🧠</span><span>En yakışıklımız? 😎</span><span>İlk kim evlenir? 💍</span></div></div>' +
    '<div class="card">' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Tekin" value="' + esc(myName) + '">' +
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
  $('#cd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doAction('joinCode'); });
  if (!myName) setTimeout(() => $('#nm') && $('#nm').focus(), 50);
}

/* ---------- character picker ---------- */

function lookPickerHTML() {
  return '<div class="lookpick"><div class="lbl">Karakterin</div><div class="avgrid">' +
    AVATARS.map((a) => '<button class="avopt ' + (a === App.look.av ? 'on' : '') + '" style="--c:' + App.look.col + '" data-act="pickav" data-v="' + a + '">' + a + '</button>').join('') +
    '</div><div class="lbl">Rengin</div><div class="colgrid">' +
    COLORS.map((c) => '<button class="colopt ' + (c === App.look.col ? 'on' : '') + '" style="--c:' + c + '" data-act="pickcol" data-v="' + c + '" aria-label="renk"></button>').join('') +
    '</div></div>';
}

function lookBoxHTML() {
  return '<div class="lookrow">' + avatarHTML(App.look, 'lg') +
    '<div class="grow"><b>Karakterin</b><div class="muted" style="font-size:14px">Hayvanını ve rengini seç</div></div>' +
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
    '<div class="toprow">' + themePill() + '</div>' +
    '<div class="hero"><div class="big">Hangimiz<span>?</span></div><p>Seni bir odaya çağırdılar! 🎈</p></div>' +
    '<div class="card">' +
      '<div class="center muted" style="font-weight:700">Oda kodu</div>' +
      '<div class="center" style="font-size:44px;font-weight:800;letter-spacing:8px;color:var(--purple);line-height:1.1">' + esc(code) + '</div>' +
      '<div style="height:12px"></div>' +
      '<label class="lbl" for="nm">Adın ne?</label>' +
      '<input id="nm" class="field" maxlength="' + MAX_NAME + '" autocomplete="nickname" placeholder="Örn: Naz" value="' + esc(myName) + '">' +
      '<div id="lookBox">' + lookBoxHTML() + '</div>' +
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
  if (['writing', 'answering', 'lie', 'kac', 'ikiz', 'tele', 'ayna', 'emo', 'cog', 'iky', 'sir'].includes(s.phase) && !inRound) screen = 'spectate';
  if (screen === 'lie') screen = 'lie:' + s.lie.step;
  if (screen === 'kac') screen = 'kac:' + s.kac.step;
  if (['ikiz', 'tele', 'ayna', 'emo', 'cog', 'iky', 'sir'].includes(screen)) screen += ':' + s[screen].step;
  let key = screen + ':' + (s.roundId || '');
  if (screen === 'results') key += ':' + s.reveal.index;
  if (screen === 'lie:clues') key += ':' + s.lie.turn;
  if (screen.startsWith('kac:')) key += ':' + s.kac.ti;
  if (/^(ikiz|tele|ayna|emo|cog|iky|sir):/.test(screen)) key += ':' + s.stepKey;
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
      '<div class="row chatrow"><input id="chatInput" class="field grow" maxlength="' + CHAT_MAX + '" placeholder="Mesaj yaz…" autocomplete="off">' +
      '<button class="btn small" data-act="chatSend">Gönder</button></div>' +
    '</div>' +
    '<div id="chatPeek" class="chatpeek" data-act="chat" hidden></div>' +
    '<div id="reactLayer" class="reactlayer"></div>';
  document.body.append(...box.children);
}

function chatMsgHTML(m, you) {
  const who = { av: m.av, col: m.col };
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
      id: last + 0.001 * ((App.chatShadows || []).length + 1), from: s.you, name: mine.name, av: mine.av, col: mine.col, text: msg.text,
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
    return '<button class="gcard ' + (on ? 'on' : '') + (mine ? ' myvote' : '') + '"' + attrs + '><span class="ge">' + g.emoji + '</span><span class="gb"><b>' + esc(g.name) + '</b>' +
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

Views['emo:write'] = {
  mount(s) {
    const E = s.emo;
    const n = nameOf(E.narr);
    const body = E.amNarr
      ? '<div class="card myturn center"><h2>Sıra sende! 🎬</h2><div class="muted">Bunu sadece emojiyle anlat:</div>' +
        '<div class="emotitle" id="emoTitle"></div><div class="muted" id="emoCat"></div><div id="emoReroll"></div>' +
        '<div class="row" style="margin-top:10px"><input id="emoClue" class="field grow emoin" maxlength="60" placeholder="🦁👑…" autocomplete="off">' +
        '<button class="btn green" data-act="eclue">Gönder</button></div>' +
        '<p class="muted" style="margin:8px 0 0;font-size:14px">Sadece emoji! Harf ve rakam yok 🙅</p></div>'
      : '<div class="card center turnwait">' + avatarHTML(n, 'lg') + '<h2 style="margin:8px 0 0">' + esc(n.name) + ' emoji hazırlıyor… 🤔</h2>' +
        '<p class="muted" style="margin:4px 0 0">Kategori: <b>' + esc(E.cat) + '</b></p></div>';
    mount(emoTop(s, timerHTML('Emoji yazma süresi')) + body + OFFLINE_NOTE + hostSkip('Sırayı geç'));
    if (E.amNarr) { Sound.join(); focusFine('#emoClue', true); }
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
    const E = s.emo;
    const n = nameOf(E.narr);
    mount(emoTop(s, timerHTML('Tahmin süresi')) +
      '<div class="card center"><div class="kasker">' + avatarHTML(n) + '<b>' + esc(n.name) + '</b> anlatıyor · ' + esc(E.cat) + '</div>' +
      '<div class="emoclue">' + esc(E.clue) + '</div></div>' +
      '<div id="emoArea"></div>' +
      '<div class="card"><h2>Tahminler</h2><div class="emofeed" id="emoFeed"></div></div>' +
      hostSkip('Cevabı aç'));
  },
  update(s) {
    const E = s.emo;
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
    const mine = I.mine;
    App.ikyLie = mine ? mine.lie : null;
    const ph = ['Örn: Hiç uçağa binmedim', 'Örn: 3 kardeşim var', 'Örn: Çocukken bir yarışma kazandım'];
    const rows = [0, 1, 2].map((i) => '<div class="ikyrow"><span class="num">' + (i + 1) + '</span>' +
      '<input class="field grow iky-in" data-i="' + i + '" maxlength="' + MAX_Q_LEN + '" placeholder="' + esc(ph[i]) + '" value="' + esc(mine ? mine.list[i] : '') + '" autocomplete="off">' +
      '<button class="liebtn" data-act="ilie" data-i="' + i + '" title="Bu yalan">🤥</button></div>').join('');
    mount(header() + timerHTML('Yazma süresi') +
      '<div class="phase-title"><h1>İki doğru, bir yalan 🎭</h1><p>Kendin hakkında 3 şey yaz. Birini yalan yap ve yanındaki 🤥 ile işaretle!</p></div>' +
      '<div class="card"><div class="qlist">' + rows + '</div><div style="height:14px"></div>' +
        '<button class="btn green big block" data-act="iwrite">✅ Gönder</button><p class="muted center" id="ikyMine" style="margin:8px 0 0"></p></div>' +
      '<div class="card"><h2>Kim bitirdi?</h2><div class="chips" id="ikyChips"></div></div>' +
      hostSkip('Tahminlere geç'));
    ikyPaint();
    const first = $$('.iky-in').find((x) => !x.value);
    if (first) autoFocus(first);
  },
  update(s) {
    $('#ikyChips').innerHTML = doneChips(s, s.iky.done);
    $('#ikyMine').textContent = s.iky.mine ? '✅ Gönderildi (istersen değiştirip tekrar gönderebilirsin)' : '';
  },
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
    $('#ikyChips').innerHTML = doneChips(s, I.done, s.roster.filter((id) => id !== I.author));
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
  toggleLook() {
    App.lookOpen = !App.lookOpen;
    const box = $('#lookBox');
    if (box) box.innerHTML = lookBoxHTML(); else render();
  },
  pickav(el) { setLook({ av: el.dataset.v }); if (!$('#lookBox')) render(); },
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

document.addEventListener('input', (e) => {
  if (e.target.classList.contains('q-input')) queueDrafts();
  if (e.target.id === 'cd') e.target.value = cleanCode(e.target.value);
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
