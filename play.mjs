#!/usr/bin/env node
import readline from 'readline';
import { randomBytes } from 'crypto';

const API = 'https://backend-dot-prihoriva.ew.r.appspot.com';

const USER_ID = 'cli_' + randomBytes(4).toString('hex') + '_' + Date.now().toString(36);

// Mirrors Ht() — similarity is 0–100
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

// Mirrors Mt() from the live site — same error messages and character set
const CZECH_RE = /^[a-záčďéěíňóřšťúůýžA-ZÁČĎÉĚÍŇÓŘŠŤÚŮÝŽ'-]+$/;

function validateWord(word) {
  if (!word || typeof word !== 'string') return { valid: false, error: 'Slovo není platné' };
  const t = word.trim();
  if (t.length > 20) return { valid: false, error: 'Slovo je příliš dlouhé (max 20 znaků)' };
  if (t.length < 2)  return { valid: false, error: 'Slovo je příliš krátké (min 2 znaky)' };
  if (/\s/.test(t))  return { valid: false, error: 'Lze zadat pouze jedno slovo' };
  if (!CZECH_RE.test(t)) return { valid: false, error: 'Slovo obsahuje nepovolené znaky' };
  return { valid: true, word: t };
}

function headers(extra = {}) {
  return { 'Content-Type': 'application/json', 'X-User-ID': USER_ID, ...extra };
}

async function callAPI(endpoint, body, extraHeaders = {}) {
  const res = await fetch(`${API}${endpoint}`, {
    method: 'POST',
    headers: headers(extraHeaders),
    body: body !== null ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text }; }
  if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
  return data;
}

async function reportWin() {
  try {
    const res = await fetch(`${API}/increment_correct_guesses`, { method: 'POST' });
    const d = await res.json();
    console.log(`${D}  ↳ /increment_correct_guesses: ${d.status}${R}`);
  } catch (e) {
    console.log(`${D}  ↳ /increment_correct_guesses selhalo: ${e.message}${R}`);
  }
}

function showTop(history, n = 10) {
  if (history.length === 0) { console.log(`${D}  Zatím žádné pokusy.${R}\n`); return; }
  const top = [...history].sort((a, b) => b.sim - a.sim).slice(0, n);
  console.log(`\n${D}── Nejlepší pokusy ─────────────────────────────${R}`);
  top.forEach((h, i) => {
    const c = color(h.sim);
    console.log(`  ${D}${i + 1}.${R} ${B}${h.word.padEnd(20)}${R} ${c}${h.sim.toFixed(1).padStart(5)} % ${bar(h.sim)} ${label(h.sim)}${R}`);
  });
  console.log();
}

function showAll(history) {
  if (history.length === 0) { console.log(`${D}  Zatím žádné pokusy.${R}\n`); return; }
  console.log(`\n${D}── Všechny pokusy (v pořadí odeslání) ─────────${R}`);
  history.forEach((h, i) => {
    const c = color(h.sim);
    console.log(`  ${D}${String(i + 1).padStart(3)}.${R} ${B}${h.word.padEnd(20)}${R} ${c}${h.sim.toFixed(1).padStart(5)} % ${bar(h.sim)} ${label(h.sim)}${R}`);
  });
  console.log(`${D}  Celkem: ${history.length} pokusů${R}\n`);
}

function showHelp(isWeekly) {
  const mode = isWeekly ? 'megaslovo týdne' : 'slovo dne';
  console.log(`
${B}── Nápověda (${mode}) ──────────────────────────${R}
  Hádej české slovo (2–20 znaků, bez mezer, bez číslic).
  Po každém hádání musíš počkat 2 sekundy (nebo dle serveru).
  Stejné slovo nelze hádat dvakrát — uvidíš uložený výsledek.

${B}Příkazy:${R}
  ${Y}/pomoc${R}     — tato nápověda
  ${Y}/seznam${R}    — vypíše všechny pokusy s přesností
  ${Y}/top${R}       — zobrazí 10 nejlepších pokusů
  ${Y}/konec${R}     — vzdej aktuální kolo
  ${Y}/vzdej${R}     — stejné jako /konec
  ${Y}/exit${R}      — ukončí celý program
`);
}

function handleSlashCommand(cmd, history, isWeekly) {
  const c = cmd.toLowerCase().trim();
  if (c === '/pomoc' || c === '/help') { showHelp(isWeekly); return 'continue'; }
  if (c === '/seznam' || c === '/list') { showAll(history); return 'continue'; }
  if (c === '/top') { showTop(history); return 'continue'; }
  if (c === '/vzdej' || c === '/quit' || c === '/konec') return 'quit';
  if (c === '/exit') { console.log(`\nNa shledanou! 👋`); process.exit(0); }
  console.log(`${D}  Neznámý příkaz. Zkus /pomoc.${R}\n`);
  return 'continue';
}

async function playMode(rl, mode) {
  const isWeekly = mode === 'mega';
  const endpoint = isWeekly ? '/weekly/similarity' : '/similarity';
  const title    = isWeekly ? 'MEGASLOVO TÝDNE' : 'SLOVO DNE';
  const hint     = isWeekly ? '(těžší; server neposílá rank zpět)' : '';

  console.log(`\n${B}╔══════════════════════════════════════╗`);
  console.log(`║  ${title.padEnd(36)}║`);
  console.log(`╚══════════════════════════════════════╝${R}`);
  if (hint) console.log(`${D}${hint}${R}`);
  console.log(`${D}Piš slova, Enter = odeslat. /pomoc = nápověda, /konec = vzdát.${R}\n`);

  const history    = [];
  const guessedSet = new Set(); // lowercase words already sent to API
  let attempts     = 0;
  let cooldown     = 2000; // mirrors live site default (2 s)
  let lastTime     = 0;
  let inFlight     = false;
  let closed       = false;
  rl.once('close', () => { closed = true; });

  const ask = q => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('stdin closed'));
    rl.question(q, resolve);
  });

  while (true) {
    let input;
    try {
      input = (await ask(`${B}[${attempts + 1}] Tvůj tip: ${R}`)).trim();
    } catch { break; }

    if (!input) continue;

    // Slash commands
    if (input.startsWith('/')) {
      const result = handleSlashCommand(input, history, isWeekly);
      if (result === 'quit') { console.log(`\nVzdal jsi to po ${attempts} pokusech. Škoda!\n`); break; }
      continue;
    }


    // Duplicate check — show cached result without hitting the API
    const lc = input.toLowerCase();
    if (guessedSet.has(lc)) {
      const cached = history.find(h => h.word === lc);
      const c = color(cached.sim);
      console.log(`${Y}  ⚠️  "${lc}" jsi už hádal — výsledek z cache:${R}`);
      console.log(`  ${c}${B}${cached.sim.toFixed(1)} %${R}  ${c}${bar(cached.sim)}  ${label(cached.sim)}${R}\n`);
      continue;
    }

    // Throttle check (mirrors live site: 2 s default, updated from server)
    if (inFlight) {
      console.log(`  ⏳ Počkej na dokončení předchozího pokusu.\n`);
      continue;
    }
    const now = Date.now();
    const elapsed = now - lastTime;
    if (lastTime > 0 && elapsed < cooldown) {
      const wait = Math.ceil((cooldown - elapsed) / 1000);
      console.log(`  ⏳ Prosím počkejte ${wait}s mezi pokusy.\n`);
      continue;
    }

    // Input validation (mirrors live site's Mt())
    const validation = validateWord(input);
    if (!validation.valid) {
      console.log(`  ⚠️  ${validation.error}\n`);
      continue;
    }
    const word = validation.word.toLowerCase();

    inFlight = true;
    lastTime = Date.now();

    try {
      const body = isWeekly
        ? { word1: word }
        : { word1: word, guesses: attempts + 1 };

      const data = await callAPI(endpoint, body);

      if (data.typo) { console.log(`  ⚠️  ${data.error}\n`); inFlight = false; continue; }

      const sim = parseFloat((data.similarity * 100).toFixed(2));
      if (data.recommended_cooldown) cooldown = data.recommended_cooldown;

      guessedSet.add(word);
      history.push({ word, sim });
      attempts++;

      const c = color(sim);
      process.stdout.write(`\n  ${c}${B}${sim.toFixed(1)} %${R}  ${c}${bar(sim)}  ${label(sim)}${R}`);

      if (data.rank != null) {
        process.stdout.write(`  ${D}(rank #${data.rank} z ${data.total_players})${R}`);
      }
      process.stdout.write('\n\n');

      if (sim >= 100) {
        console.log(`${G}${B}🎉 Uhádl jsi za ${attempts} ${attempts === 1 ? 'pokus' : attempts < 5 ? 'pokusy' : 'pokusů'}!${R}`);
        showTop(history);
        if (!isWeekly) await reportWin();
        inFlight = false;
        return true;
      }

      if (attempts % 5 === 0) showTop(history);

    } catch (err) {
      console.log(`  ❌ Chyba: ${err.message}\n`);
    }

    inFlight = false;
  }

  return false;
}

async function main() {
  console.log(`\n${B}╔══════════════════════════════════════╗`);
  console.log(`║   PŘIHOŘÍVÁ HOŘÍ  — CLI edition      ║`);
  console.log(`╚══════════════════════════════════════╝${R}`);
  console.log(`${D}User ID: ${USER_ID} (dočasné, nové při každém spuštění)${R}`);
  console.log(`${D}Nápověda: /pomoc${R}\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  const wonDaily = await playMode(rl, 'daily');

  if (wonDaily) {
    console.log(`\n${Y}${B}🏆 Denní slovo uhádnuto! Odemkl jsi MEGASLOVO TÝDNE.${R}`);
    const ask = q => new Promise(resolve => rl.question(q, resolve));
    const ans = await ask(`${B}Chceš zkusit megaslovo? (ano/ne): ${R}`);
    if (ans.trim().toLowerCase().startsWith('a')) {
      await playMode(rl, 'mega');
    }
  }

  console.log(`\nNa shledanou! 👋`);
  rl.close();
}

main().catch(console.error);
