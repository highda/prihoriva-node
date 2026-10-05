#!/usr/bin/env node
import readline from 'readline';
import { randomBytes } from 'crypto';
import { parseArgs } from 'util';

const API = 'https://backend-dot-prihoriva.ew.r.appspot.com';
const FIREBASE_KEY = 'AIzaSyAastCJ-3Kvrdu1E29lxYW2wEIy3o38zMM'; // public web key from the site's bundle

const { values: opts } = parseArgs({
  options: {
    'browser-parity': { type: 'boolean', default: false },
    mega:             { type: 'boolean', default: false },
    email:            { type: 'string' },
    help:             { type: 'boolean', short: 'h', default: false },
  },
});

if (opts.help) {
  console.log(`Použití: node play.mjs [--browser-parity] [--mega] [--email <e-mail>]

  --browser-parity  vynucuje i omezení, která hlídá jen web (prodleva mezi
                    pokusy, lokální validace, opakovaná slova se neposílají,
                    megaslovo až po slovu dne, nic po uhádnutí, zamčené dny
                    archivu podle kalendáře)
  --mega            začne rovnou megaslovem
  --email           přihlásí se při startu (heslo z PRIHORIVA_PASSWORD nebo z výzvy)

Proměnné prostředí: PRIHORIVA_EMAIL, PRIHORIVA_PASSWORD`);
  process.exit(0);
}

const PARITY = opts['browser-parity'];
const USER_ID = 'cli_' + randomBytes(4).toString('hex') + '_' + Date.now().toString(36);

// Mirrors Mu() — similarity is 0–100
function label(s) {
  if (s >= 100) return 'HOŘÍ! 🔥🔥🔥';
  if (s >= 95)  return 'Pálí! 🔥🔥';
  if (s >= 85)  return 'Přihořívá! 🔥';
  if (s >= 75)  return 'Horko ♨️';
  if (s >= 65)  return 'Teplo 🌡️';
  if (s >= 55)  return 'Vlažno 🌊';
  if (s >= 45)  return 'Chladno 💧';
  if (s >= 35)  return 'Voda 💧';
  if (s >= 25)  return 'Samá voda 🌊';
  if (s >= 15)  return 'Voda, voda 🌊';
  if (s >= 5)   return 'Moře vody 🌊';
  return 'Led, všude led 🧊';
}

function bar(s) {
  const filled = Math.round(s / 5);
  return '[' + '█'.repeat(filled) + '░'.repeat(20 - filled) + ']';
}

function color(s) {
  if (s >= 85) return '\x1b[91m';
  if (s >= 65) return '\x1b[33m';
  if (s >= 45) return '\x1b[36m';
  return '\x1b[34m';
}

const R = '\x1b[0m', B = '\x1b[1m', D = '\x1b[2m', G = '\x1b[32m', Y = '\x1b[33m';

// ── Server config ────────────────────────────────────────────────

let features = {};
let wordRules = null; // { minLength, charRegex } — like the site's Ro state; null if /word_rules failed

async function loadConfig() {
  const [health, rules] = await Promise.all([
    apiGet('/health').catch(() => null),
    apiGet('/word_rules').catch(() => null),
  ]);
  if (health?.features) features = health.features;
  if (rules) {
    let charRegex = null;
    if (rules.char_pattern) try { charRegex = new RegExp(rules.char_pattern, 'u'); } catch {}
    wordRules = { minLength: rules.min_length ?? 2, charRegex };
  }
}

// Mirrors Ou() from the live site — same order of checks and messages.
// Only used with --browser-parity; otherwise the backend validates.
function validateWord(word) {
  if (!word || typeof word !== 'string') return { valid: false, error: 'Slovo není platné' };
  const t = word.trim();
  if (t.length > 20) return { valid: false, error: 'Slovo je příliš dlouhé (max 20 znaků)' };
  if (t.length < (wordRules?.minLength ?? 2)) return { valid: false, error: 'Slovo je příliš krátké (min 2 znaky)' };
  if (/\s/.test(t)) return { valid: false, error: 'Lze zadat pouze jedno slovo' };
  if (wordRules?.charRegex && !wordRules.charRegex.test(t)) return { valid: false, error: 'Slovo obsahuje nepovolené znaky' };
  return { valid: true, word: t };
}

// ── Auth (Firebase email/password, same project as the site) ─────

let auth = null; // { email, idToken, refreshToken, expiresAt }

const FIREBASE_ERRORS = {
  INVALID_LOGIN_CREDENTIALS: 'Nesprávný e-mail nebo heslo',
  INVALID_PASSWORD: 'Nesprávný e-mail nebo heslo',
  EMAIL_NOT_FOUND: 'Nesprávný e-mail nebo heslo',
  INVALID_EMAIL: 'Neplatný e-mail',
  USER_DISABLED: 'Účet je zablokovaný',
  TOO_MANY_ATTEMPTS_TRY_LATER: 'Příliš mnoho pokusů, zkus to později',
};

async function firebase(url, init) {
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const code = String(data?.error?.message || `HTTP ${res.status}`).split(' ')[0];
    throw new Error(FIREBASE_ERRORS[code] || code);
  }
  return data;
}

async function signIn(email, password) {
  const d = await firebase(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${FIREBASE_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, returnSecureToken: true }),
  });
  auth = { email: d.email, idToken: d.idToken, refreshToken: d.refreshToken, expiresAt: Date.now() + Number(d.expiresIn) * 1000 };
}

async function getToken() {
  if (!auth) return null;
  if (Date.now() > auth.expiresAt - 60_000) {
    const d = await firebase(`https://securetoken.googleapis.com/v1/token?key=${FIREBASE_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: auth.refreshToken }),
    });
    auth.idToken = d.id_token;
    auth.refreshToken = d.refresh_token;
    auth.expiresAt = Date.now() + Number(d.expires_in) * 1000;
  }
  return auth.idToken;
}

// ── Backend API ──────────────────────────────────────────────────

class ApiError extends Error {
  constructor(status, data) {
    super(data?.error || `HTTP ${status}`);
    this.status = status;
    this.data = data;
  }
}

async function headers(extra = {}) {
  // Same headers as the site's Dp() + similarity callers
  const h = { 'Content-Type': 'application/json', 'X-User-ID': USER_ID, 'X-Lang': 'cs', ...extra };
  if (auth) {
    h['X-Auth-Expected'] = '1';
    const token = await getToken().catch(() => null);
    if (token) h.Authorization = `Bearer ${token}`;
  }
  return h;
}

async function request(method, endpoint, body) {
  const res = await fetch(`${API}${endpoint}`, {
    method,
    headers: await headers(),
    body: body != null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text.slice(0, 200) }; }
  if (!res.ok) throw new ApiError(res.status, data);
  return data;
}

const apiGet  = endpoint => request('GET', endpoint);
const apiPost = (endpoint, body) => request('POST', endpoint, body);

async function reportWin() {
  try {
    const res = await fetch(`${API}/increment_correct_guesses`, { method: 'POST', headers: { 'X-Lang': 'cs' } });
    const d = await res.json();
    console.log(`${D}  ↳ /increment_correct_guesses: ${d.status}${R}`);
  } catch (e) {
    console.log(`${D}  ↳ /increment_correct_guesses selhalo: ${e.message}${R}`);
  }
}

// ── Game modes ───────────────────────────────────────────────────
//
// Every round (daily, mega, archive day, group word) is a "mode": where to
// send guesses, what the site checks locally before sending, and the progress.

function newMode(kind, extra = {}) {
  return {
    kind,
    title: '',
    path: '',
    history: [],        // { word, sim } in order of sending (unique words)
    attempts: 0,        // guesses the server accepted
    guessed: false,
    solvedWord: null,
    cooldown: 2000,     // site default, updated from recommended_cooldown
    lastTime: 0,
    attemptsLeft: null, // mega only: free tips left today (null = unlimited/unknown)
    dailyLimit: null,
    restored: false,    // progress was just loaded from the server
    // How the site's submit handler for this kind behaves:
    validate: false,      // runs Ou() word validation
    stampEarly: false,    // restarts the cooldown before validation/duplicate check
    duplicate: 'cache',   // 'cache' = show stored result, 'reject' = "already tried"
    ...extra,
  };
}

const modes = {
  daily: newMode('daily', { title: 'SLOVO DNE', path: '/similarity', validate: true, stampEarly: true }),
  mega:  newMode('mega',  { title: 'MEGASLOVO TÝDNE', path: '/weekly/similarity', validate: true, stampEarly: true }),
};

function guessBody(mode, word) {
  // The daily endpoint takes the client's attempt counter; the server ignores it
  // for counting (it keeps its own), but the site still sends it.
  return mode.kind === 'daily' ? { word1: word, guesses: mode.history.length + 1 } : { word1: word };
}

const toPct = s => Math.round(100 * (s || 0) * 100) / 100;

// Mirrors Jp(): keep the best similarity per word, in order of first guess
function applyGuesses(mode, guesses, { status, attempts, word } = {}) {
  const best = new Map();
  const ordered = (Array.isArray(guesses) ? guesses : [])
    .filter(g => g && typeof g.word === 'string')
    .map((g, i) => ({ ...g, ord: typeof g.order === 'number' ? g.order : i }))
    .sort((a, b) => a.ord - b.ord);
  for (const g of ordered) {
    const sim = toPct(g.similarity);
    if (!best.has(g.word) || sim > best.get(g.word)) best.set(g.word, sim);
  }
  if (best.size && best.size <= mode.history.length) return;
  if (best.size) {
    mode.history = [...best].map(([w, sim]) => ({ word: w, sim }));
    mode.attempts = Math.max(mode.history.length, attempts || 0);
    mode.restored = true;
  }
  if (status === 'guessed') {
    mode.guessed = true;
    mode.solvedWord = word || mode.solvedWord;
  }
}

function applyGameState(mode, payload) {
  if (mode.kind === 'mega' && payload && payload.mega_attempts_left !== undefined) {
    mode.attemptsLeft = payload.mega_attempts_left;
    mode.dailyLimit = payload.mega_daily_limit ?? null;
  }
  const st = payload?.state;
  if (!st || !st.status || st.status === 'not_started') return;
  applyGuesses(mode, st.guesses, st);
}

async function loadServerState() {
  const [daily, mega] = await Promise.all([
    apiGet('/user/game_state?type=daily').catch(() => null),
    apiGet('/user/game_state?type=mega').catch(() => null),
  ]);
  applyGameState(modes.daily, daily);
  applyGameState(modes.mega, mega);
}

// ── Terminal I/O ─────────────────────────────────────────────────

const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
let stdinClosed = false;
rl.once('close', () => { stdinClosed = true; });

const ask = q => new Promise((resolve, reject) => {
  if (stdinClosed) return reject(new Error('stdin closed'));
  rl.question(q, resolve);
});

function askHidden(q) {
  const write = rl._writeToOutput;
  rl._writeToOutput = s => { if (s.startsWith(q)) write.call(rl, q); };
  return ask(q).finally(() => { rl._writeToOutput = write; rl.output.write('\n'); });
}

async function login(email) {
  try {
    email = email || (await ask(`${B}E-mail: ${R}`)).trim();
    if (!email) return false;
    const password = process.env.PRIHORIVA_PASSWORD || await askHidden(`${B}Heslo: ${R}`);
    await signIn(email, password);
    console.log(`${G}  ✔ Přihlášen jako ${auth.email}${R}`);
    await loadServerState();
    return true;
  } catch (e) {
    if (e.message === 'stdin closed') throw e;
    console.log(`  ❌ Přihlášení selhalo: ${e.message}\n`);
    return false;
  }
}

// Offers a login when an account is needed; returns whether we are signed in.
async function requireAccount(what) {
  if (auth) return true;
  console.log(`\n${Y}🔑 ${what} vyžaduje účet.${R} ${D}(Registrace zdarma na prihorivahori.cz)${R}`);
  const ans = (await ask(`${B}Přihlásit se teď? (ano/ne): ${R}`)).trim().toLowerCase();
  if (!ans.startsWith('a')) { console.log(); return false; }
  return login(process.env.PRIHORIVA_EMAIL || opts.email);
}

function row(i, word, sim) {
  const c = color(sim);
  return `  ${D}${String(i).padStart(3)}.${R} ${B}${word.padEnd(20)}${R} ${c}${sim.toFixed(1).padStart(5)} % ${bar(sim)} ${label(sim)}${R}`;
}

function showTop(history, n = 10) {
  if (history.length === 0) { console.log(`${D}  Zatím žádné pokusy.${R}\n`); return; }
  const top = [...history].sort((a, b) => b.sim - a.sim).slice(0, n);
  console.log(`\n${D}── Nejlepší pokusy ─────────────────────────────${R}`);
  top.forEach((h, i) => console.log(row(i + 1, h.word, h.sim)));
  console.log();
}

function showAll(history) {
  if (history.length === 0) { console.log(`${D}  Zatím žádné pokusy.${R}\n`); return; }
  console.log(`\n${D}── Všechny pokusy (v pořadí odeslání) ─────────${R}`);
  history.forEach((h, i) => console.log(row(i + 1, h.word, h.sim)));
  console.log(`${D}  Celkem: ${history.length} pokusů${R}\n`);
}

function showResult(sim) {
  const c = color(sim);
  return `${c}${B}${sim.toFixed(1)} %${R}  ${c}${bar(sim)}  ${label(sim)}${R}`;
}

function showHelp(mode) {
  const rules = PARITY
    ? `  Režim --browser-parity: po každém hádání počkej ${mode.cooldown / 1000} s (dle serveru),
  stejné slovo se neposílá znovu.`
    : `  Bez --browser-parity se hlídají jen limity serveru (žádná prodleva,
  opakované slovo se pošle znovu a počítá se jako pokus).`;
  console.log(`
${B}── Nápověda (${mode.title.toLowerCase()}) ──────────────────────────${R}
  Hádej české slovo (2–20 znaků, bez mezer, bez číslic).
${rules}
  Megaslovo vyžaduje účet; bez Premia má ${features.mega_free_daily_attempts || 50} tipů denně.
  Archiv a zakládání skupin jsou jen s Premium, hádat ve skupině jde zdarma.

${B}Příkazy:${R}
  ${Y}/pomoc${R}             — tato nápověda
  ${Y}/seznam${R}            — vypíše všechny pokusy s přesností
  ${Y}/top${R}               — zobrazí 10 nejlepších pokusů
  ${Y}/denni${R}             — přepne na slovo dne
  ${Y}/mega${R}              — přepne na megaslovo týdne
  ${Y}/archiv${R} [datum]    — kalendář archivu, s datem (RRRR-MM-DD) hraje ten den
  ${Y}/skupiny${R}           — tvoje skupiny a jejich slova
  ${Y}/skupina${R} <č.|id>   — hádá slovo skupiny
  ${Y}/kamaradi${R}          — jak dnes hrají kamarádi
  ${Y}/prihlasit${R}         — přihlášení e-mailem a heslem
  ${Y}/konec${R}, ${Y}/vzdej${R}     — vzdá a ukončí program
  ${Y}/exit${R}              — ukončí program
`);
}

function apiErrorMessage(err) {
  const { status, data } = err;
  if (status === 402) return '💳 Tohle je součást Premium (prihorivahori.cz).';
  if (status === 401) return `🔑 ${data.error === 'sign_in_required' ? 'Je potřeba se přihlásit (/prihlasit).' : data.error}`;
  if (status === 403) return '🚫 K tomu nemáš přístup (nejsi členem skupiny?).';
  return `⚠️  ${err.message}`;
}

// ── Mega ─────────────────────────────────────────────────────────

function spentMessage(mode) {
  return `Dnešních ${mode.dailyLimit || 0} tipů na megaslovo máš vyčerpaných. Zítra dostaneš další, s Premium hádáš bez omezení.`;
}

async function openMega() {
  if (features.mega_requires_account && !(await requireAccount('Megaslovo'))) return null;
  if (PARITY && !modes.daily.guessed) {
    console.log(`  🔒 Nejdřív uhádni slovo dne — pak se odemkne megaslovo týdne.\n`);
    return null;
  }
  return modes.mega;
}

// ── Archive (Premium) ────────────────────────────────────────────

const archiveModes = new Map();
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function gameDay() {
  // The game day starts at 03:00 Prague time, like the site's Yh()
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Prague' }));
  d.setHours(d.getHours() - 3);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const STATUS = { guessed: `${G}uhádnuto${R}`, in_progress: `${Y}rozehráno${R}`, not_started: `${D}nehráno${R}` };

async function listArchive() {
  if (!(await requireAccount('Archiv'))) return;
  let days;
  try { days = (await apiGet('/archive')).days || []; }
  catch (e) { console.log(`  ${apiErrorMessage(e)}\n`); return; }
  console.log(`\n${D}── Archiv (posledních 14 dní) ──────────────────${R}`);
  for (const d of days.slice(0, 14)) {
    const lock = d.locked ? '🔒' : '  ';
    const mine = d.attempts ? `${d.attempts} pokusů, nejlépe ${toPct(d.best_similarity).toFixed(1)} %` : '';
    console.log(`  ${lock} ${d.date}  ${(STATUS[d.status] || d.status).padEnd(20)} ${D}úspěšnost ${Math.round(d.win_rate)} %, ø ${Math.round(d.avg_guesses)} pokusů${R}  ${mine}`);
  }
  const locked = days.filter(d => d.locked).length;
  console.log(`${D}  Celkem ${days.length} dní${locked ? `, zamčeno ${locked} (Premium)` : ''}. Hraj: /archiv RRRR-MM-DD${R}\n`);
}

async function openArchive(date) {
  if (!DATE_RE.test(date)) { console.log(`  ⚠️  Datum zadej jako RRRR-MM-DD.\n`); return null; }
  if (!(await requireAccount('Archiv'))) return null;
  if (date >= gameDay()) { console.log(`${D}  Dnešní slovo je v běžné hře.${R}\n`); return modes.daily; }
  if (PARITY) {
    // The site checks the calendar's lock flag before asking for the day
    const days = await apiGet('/archive').then(d => d.days || []).catch(() => []);
    if (days.some(d => d.date === date && d.locked)) { console.log(`  💳 Starší slova z archivu jsou součást Premium.\n`); return null; }
  }
  let state;
  try { state = await apiGet(`/archive/${date}/state`); }
  catch (e) { console.log(`  ${apiErrorMessage(e)}\n`); return null; }

  if (!archiveModes.has(date)) {
    archiveModes.set(date, newMode('archive', { title: `ARCHIV ${date}`, path: `/archive/${date}/guess` }));
  }
  const mode = archiveModes.get(date);
  applyGuesses(mode, state.guesses, { status: state.solved_word ? 'guessed' : null, word: state.solved_word });
  return mode;
}

// ── Groups ───────────────────────────────────────────────────────

let lastGroupList = [];

async function listGroups() {
  if (!(await requireAccount('Skupiny'))) return;
  let rounds, overview;
  try {
    [rounds, overview] = await Promise.all([apiGet('/user/group_rounds'), apiGet('/groups/overview')]);
  } catch (e) { console.log(`  ${apiErrorMessage(e)}\n`); return; }
  const groups = overview.groups || [];
  const byGid = new Map((rounds.rounds || []).map(r => [r.gid, r]));
  lastGroupList = groups.map(g => g.gid);
  for (const r of rounds.rounds || []) if (!lastGroupList.includes(r.gid)) lastGroupList.push(r.gid);

  console.log(`\n${D}── Skupiny ─────────────────────────────────────${R}`);
  if (!lastGroupList.length) {
    console.log(`${D}  Nejsi v žádné skupině. Do skupiny tě musí pozvat správce (zakládání je s Premium).${R}`);
  }
  lastGroupList.forEach((gid, i) => {
    const g = groups.find(x => x.gid === gid) || {};
    const r = byGid.get(gid);
    const name = g.name || r?.group_name || gid;
    let info = `${D}bez slova${R}`;
    if (r?.is_setter) info = `${D}slovo zadáváš ty${R}`;
    else if (r && r.has_word !== false) info = `${STATUS[r.status] || STATUS.not_started}${r.attempts ? ` — ${r.attempts} pokusů, nejlépe ${toPct(r.best_similarity).toFixed(1)} %` : ''}`;
    else if (r?.finished_today) info = `${D}kolo dnes skončilo${R}`;
    console.log(`  ${D}${String(i + 1).padStart(3)}.${R} ${B}${String(name).padEnd(24)}${R} ${info}`);
  });
  for (const k of ['invitations', 'pending', 'requests']) {
    if (overview[k]?.length) console.log(`${D}  ${k === 'invitations' ? 'Pozvánky' : k === 'pending' ? 'Čekající žádosti' : 'Žádosti o vstup'}: ${overview[k].length} (vyřídíš na webu)${R}`);
  }
  if (lastGroupList.length) console.log(`${D}  Hraj: /skupina <číslo>${R}`);
  console.log();
}

const groupModes = new Map();

async function openGroup(ref) {
  if (!(await requireAccount('Skupina'))) return null;
  const gid = /^\d+$/.test(ref) ? lastGroupList[Number(ref) - 1] : ref;
  if (!gid) { console.log(`  ⚠️  Neznámé číslo skupiny — vypiš si je přes /skupiny.\n`); return null; }

  let data;
  try { data = await apiGet(`/groups/${encodeURIComponent(gid)}/round`); }
  catch (e) { console.log(`  ${apiErrorMessage(e)}\n`); return null; }

  if (data.inactive) {
    console.log(`  💤 Skupina spí — zakladateli vypršelo Premium.\n`);
    return null;
  }
  if (!data.round) {
    const fin = data.finished_round || data.last_round;
    if (fin?.word) console.log(`${D}  Kolo skončilo. Slovo bylo: ${fin.word}${R}`);
    const who = data.next_setter_name ? `Na řadě se zadáním je ${data.next_setter_name}.` : 'Zatím tu žádné slovo není.';
    console.log(`  ${who}${data.is_my_turn ? ' Zadat slovo jde na webu (Premium).' : ''}\n`);
    return null;
  }

  const round = data.round;
  const key = `${gid}:${round.id ?? round.round_id ?? ''}`;
  if (!groupModes.has(key)) {
    const name = round.group_name || data.group_name || gid;
    groupModes.set(key, newMode('group', {
      title: `SKUPINA ${name}`.slice(0, 36),
      path: `/groups/${encodeURIComponent(gid)}/guess`,
      duplicate: 'reject',
    }));
  }
  const mode = groupModes.get(key);
  if (round.setter_name) mode.setter = round.setter_name;
  if (round.is_mine || round.is_setter) mode.isSetter = true;
  applyGuesses(mode, data.state?.guesses, { status: data.state?.status, word: round.word });
  return mode;
}

// ── Friends ──────────────────────────────────────────────────────

async function showFriends() {
  if (!(await requireAccount('Kamarádi'))) return;
  let data;
  try { data = await apiGet('/friends/today'); }
  catch (e) { console.log(`  ${apiErrorMessage(e)}\n`); return; }
  const cell = s => s && s.status !== 'not_started'
    ? `${STATUS[s.status] || s.status} ${String(s.attempts).padStart(3)}× ${toPct(s.best_similarity).toFixed(1).padStart(5)} %`
    : `${STATUS.not_started}${' '.repeat(14)}`;
  console.log(`\n${D}── Kamarádi dnes ───────────── slovo dne ──────────── megaslovo ──${R}`);
  for (const f of data.friends || []) {
    console.log(`  ${B}${String(f.display_name || '—').slice(0, 20).padEnd(20)}${R}${f.me ? `${D}(ty)${R}` : '    '} ${cell(f.daily)}   ${cell(f.mega)}`);
  }
  if ((data.friends || []).every(f => f.me)) console.log(`${D}  Zatím žádní kamarádi — přidáš je na webu.${R}`);
  console.log();
}

// ── Gameplay ─────────────────────────────────────────────────────

// Returns { switch: target } to change rounds, or { quit: true }.
async function handleSlashCommand(cmd, mode) {
  const [c, ...rest] = cmd.trim().split(/\s+/);
  const arg = rest.join(' ');
  switch (c.toLowerCase()) {
    case '/pomoc': case '/help': showHelp(mode); break;
    case '/seznam': case '/list': showAll(mode.history); break;
    case '/top': showTop(mode.history); break;
    case '/denni': case '/denní': return { switch: 'daily' };
    case '/mega': return { switch: 'mega' };
    case '/archiv': case '/archive':
      if (arg) return { switch: `archive:${arg}` };
      await listArchive(); break;
    case '/skupiny': case '/groups': await listGroups(); break;
    case '/skupina': case '/group':
      if (arg) return { switch: `group:${arg}` };
      await listGroups(); break;
    case '/kamaradi': case '/kamarádi': case '/friends': await showFriends(); break;
    case '/prihlasit': case '/přihlásit': case '/login':
      if (auth) console.log(`${D}  Už jsi přihlášen jako ${auth.email}.${R}\n`);
      else await login(process.env.PRIHORIVA_EMAIL || opts.email);
      break;
    case '/vzdej': case '/quit': case '/konec':
      console.log(`\nVzdal jsi to po ${mode.attempts} pokusech. Škoda!\n`);
      return { quit: true };
    case '/exit': return { quit: true };
    default: console.log(`${D}  Neznámý příkaz. Zkus /pomoc.${R}\n`);
  }
  return null;
}

async function sendGuess(mode, word) {
  try {
    const data = await apiPost(mode.path, guessBody(mode, word));
    if (data.recommended_cooldown) mode.cooldown = data.recommended_cooldown;
    if (data.mega_attempts_left !== undefined) mode.attemptsLeft = data.mega_attempts_left;
    return data;
  } catch (err) {
    if (!(err instanceof ApiError)) { console.log(`  ❌ Chyba při komunikaci se serverem: ${err.message}\n`); return null; }
    if (err.data?.recommended_cooldown) mode.cooldown = err.data.recommended_cooldown;
    if (err.status === 429 && mode.kind === 'mega') {
      mode.attemptsLeft = 0;
      if (err.data.limit) mode.dailyLimit = err.data.limit;
      console.log(`  🔒 ${spentMessage(mode)}\n`);
    } else {
      console.log(`  ${apiErrorMessage(err)}\n`);
    }
    return null;
  }
}

// Site-only checks before a guess is sent. Returns the word to send, or null.
function parityCheck(mode, input) {
  if (mode.guessed) {
    console.log(`  ✔ Tohle kolo už máš uhádnuté. Zkus /mega, /archiv, /skupiny nebo /exit.\n`);
    return null;
  }
  if (mode.kind === 'mega' && mode.attemptsLeft !== null && mode.attemptsLeft <= 0) {
    console.log(`  🔒 ${spentMessage(mode)}\n`);
    return null;
  }
  if (mode.isSetter) {
    console.log(`  Tohle slovo je od tebe, hádají ho ostatní.\n`);
    return null;
  }
  const now = Date.now();
  if (now - mode.lastTime < mode.cooldown) {
    console.log(`  ⏳ Prosím počkejte ${Math.ceil((mode.cooldown - (now - mode.lastTime)) / 1000)}s mezi pokusy.\n`);
    return null;
  }
  // Daily and mega restart the timer before validation; archive and group
  // rounds only when the guess is actually sent.
  if (mode.stampEarly) mode.lastTime = now;

  let word = input.toLowerCase();
  if (mode.validate) {
    const validation = validateWord(input);
    if (!validation.valid) { console.log(`  ⚠️  ${validation.error}\n`); return null; }
    word = validation.word.toLowerCase();
  }

  const cached = mode.history.find(h => h.word === word);
  if (cached) {
    if (mode.duplicate === 'reject') {
      console.log(`  ⚠️  Tohle slovo už jsi zkoušel/a.\n`);
    } else {
      console.log(`${Y}  ⚠️  "${word}" jsi už hádal — výsledek z cache:${R}`);
      console.log(`  ${showResult(cached.sim)}\n`);
    }
    return null;
  }
  mode.lastTime = now;
  return word;
}

function header(mode) {
  console.log(`\n${B}╔══════════════════════════════════════╗`);
  console.log(`║  ${mode.title.padEnd(36)}║`);
  console.log(`╚══════════════════════════════════════╝${R}`);
  if (mode.setter) console.log(`${D}Slovo zadal/a ${mode.setter}.${R}`);
  if (mode.kind === 'mega' && mode.attemptsLeft !== null) console.log(`${D}Zbývá dnes tipů: ${mode.attemptsLeft}${R}`);
  if (mode.restored) {
    console.log(`${D}Pokračuješ — ${mode.history.length} pokusů uloženo na serveru. /top = nejlepší.${R}`);
    mode.restored = false;
  }
  if (mode.guessed) {
    console.log(`${G}${B}✔ Už uhádnuto${mode.solvedWord ? `: ${mode.solvedWord}` : ''} (${mode.attempts} pokusů).${R}`);
    console.log(`${D}Další hra: /mega, /archiv, /skupiny — konec: /exit${R}\n`);
  } else {
    console.log(`${D}Piš slova, Enter = odeslat. /pomoc = nápověda, /konec = vzdát.${R}\n`);
  }
}

async function playMode(mode, showHeader = true) {
  if (showHeader) header(mode);

  while (true) {
    let input;
    try {
      input = (await ask(`${B}[${mode.attempts + 1}] Tvůj tip: ${R}`)).trim();
    } catch { return { quit: true }; }

    if (!input) continue;

    if (input.startsWith('/')) {
      const result = await handleSlashCommand(input, mode);
      if (result) return result;
      continue;
    }

    const word = PARITY ? parityCheck(mode, input) : input.toLowerCase();
    if (!word) continue;

    const data = await sendGuess(mode, word);
    if (!data) continue;
    if (data.typo || data.unavailable) { console.log(`  ⚠️  ${data.error}\n`); continue; }
    if (data.already_guessed) { console.log(`  ⚠️  Tohle slovo už jsi zkoušel/a.\n`); continue; }

    const sim = toPct(data.similarity);
    const existing = mode.history.find(h => h.word === word);
    if (existing) existing.sim = sim;
    else mode.history.push({ word, sim });
    mode.attempts++;

    process.stdout.write(`\n  ${showResult(sim)}`);
    if (mode.kind === 'mega' && mode.attemptsLeft !== null) process.stdout.write(`  ${D}(zbývá ${mode.attemptsLeft})${R}`);
    process.stdout.write('\n\n');

    if (data.guessed || data.similarity === 1) {
      const fresh = !mode.guessed;
      mode.guessed = true;
      mode.solvedWord = data.solved_word || word;
      const n = mode.attempts;
      console.log(`${G}${B}🎉 Uhádl jsi za ${n} ${n === 1 ? 'pokus' : n < 5 ? 'pokusy' : 'pokusů'}!${R}`);
      showTop(mode.history);
      if (mode.kind === 'daily' && fresh) {
        await reportWin();
        if (!modes.mega.guessed) {
          console.log(`\n${Y}${B}🏆 Denní slovo uhádnuto! Odemkl jsi MEGASLOVO TÝDNE.${R}`);
          const ans = await ask(`${B}Chceš zkusit megaslovo? (ano/ne): ${R}`).catch(() => 'ne');
          if (ans.trim().toLowerCase().startsWith('a')) return { switch: 'mega' };
        }
      }
      console.log(`${D}Další hra: /mega, /archiv, /skupiny — konec: /exit${R}\n`);
      continue;
    }

    if (mode.attempts % 5 === 0) showTop(mode.history);
  }
}

async function openTarget(target) {
  if (target === 'daily') return modes.daily;
  if (target === 'mega') return openMega();
  if (target.startsWith('archive:')) return openArchive(target.slice(8).trim());
  if (target.startsWith('group:')) return openGroup(target.slice(6).trim());
  return null;
}

async function main() {
  console.log(`\n${B}╔══════════════════════════════════════╗`);
  console.log(`║   PŘIHOŘÍVÁ HOŘÍ  — CLI edition      ║`);
  console.log(`╚══════════════════════════════════════╝${R}`);
  console.log(`${D}User ID: ${USER_ID} (dočasné, nové při každém spuštění)${R}`);
  console.log(`${D}Režim: ${PARITY ? 'browser parity (limity webu i serveru)' : 'jen limity serveru (--browser-parity pro limity webu)'}${R}`);
  console.log(`${D}Nápověda: /pomoc${R}\n`);

  await loadConfig();

  const email = opts.email || process.env.PRIHORIVA_EMAIL;
  if (email) await login(email);

  let current = modes.daily;
  let target = opts.mega ? 'mega' : 'daily';
  let first = true;
  try {
    while (true) {
      const next = await openTarget(target);
      const switched = next && next !== current;
      if (next) current = next;
      const result = await playMode(current, switched || first);
      first = false;
      if (result.quit || stdinClosed) break;
      target = result.switch;
    }
  } catch (e) {
    if (e.message !== 'stdin closed') throw e;
  }

  console.log(`\nNa shledanou! 👋`);
  rl.close();
}

main().catch(e => { console.error(e); rl.close(); });
