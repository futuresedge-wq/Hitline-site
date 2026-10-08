// Track record: log each day's top picks before the game, grade them from the player game logs afterwards.
// The record lives in public/history.json. Every build reads the previous copy from the live site, so it
// carries forward without a database. A second copy sits in .cache/ as a fallback.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const TZ = 'America/Toronto';
const PER_SPORT = 8;          // same size as the Top picks strip on the site
const PER_DAY_CAP = 8;        // most picks logged for one sport on one day
const GRADE_AFTER_H = 5;      // wait this long after the start before grading
const VOID_AFTER_D = 7;       // no result after this long means the player did not play
const KEEP_DAYS = 120;

export const implied = (o) => (o < 0 ? (-o / (-o + 100)) * 100 : (100 / (o + 100)) * 100);
export const dayOf = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)); // YYYY-MM-DD
const md = (day) => { const [, m, d] = day.split('-'); return `${+m}/${+d}`; };
const shift = (day, n) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

// The props the site would show in Top picks (L5 sample, 80%+ hit rate, positive edge), best edge first
export function candidates(props, now) {
  const out = [];
  for (const sport of new Set(props.map((p) => p.sport))) {
    const seen = new Set();
    props
      .filter((p) => p.sport === sport && new Date(p.start) > now && Array.isArray(p.games))
      .map((p) => { const g = p.games.slice(0, 5), hits = g.filter((x) => x.v > p.line).length, pct = g.length ? Math.round((hits / g.length) * 100) : 0; return { p, n: g.length, pct, edge: pct - implied(p.odds) }; })
      .filter((c) => c.n >= 5 && c.pct >= 80 && c.edge > 0)
      .sort((a, b) => b.edge - a.edge || b.n - a.n)
      .filter((c) => !seen.has(c.p.player) && seen.add(c.p.player))
      .slice(0, PER_SPORT)
      .forEach((c) => out.push(c));
  }
  return out;
}

export function record(hist, props, now) {
  const have = new Set(hist.picks.map((x) => x.k));
  const perDay = {};
  hist.picks.forEach((x) => { const k = `${x.sport}|${x.day}`; perDay[k] = (perDay[k] || 0) + 1; });
  let added = 0;
  for (const { p, pct, edge } of candidates(props, now)) {
    const k = `${p.id}@${p.start}`, day = dayOf(p.start), dk = `${p.sport}|${day}`;
    if (have.has(k) || (perDay[dk] || 0) >= PER_DAY_CAP) continue;
    const bet = (p.books || []).find((b) => b.line === p.line && !/pinnacle/i.test(b.book));
    hist.picks.push({ k, id: p.id, sport: p.sport, player: p.player, team: p.team, opp: p.opp, home: p.home, market: p.market, line: p.line, odds: p.odds, book: bet ? bet.book : null, pct, edge: Math.round(edge * 10) / 10, start: p.start, day, res: null });
    have.add(k); perDay[dk] = (perDay[dk] || 0) + 1; added++;
  }
  return added;
}

// A pick is graded once the player's game log shows the game it was logged for
export function grade(hist, props, now) {
  const byId = new Map(props.map((p) => [p.id, p]));
  let graded = 0, voided = 0;
  for (const x of hist.picks) {
    if (x.res) continue;
    const age = now - new Date(x.start);
    if (age < GRADE_AFTER_H * 36e5) continue;
    const cur = byId.get(x.id), g = cur && Array.isArray(cur.games) ? cur.games : [];
    const days = [md(x.day)];
    if (x.sport !== 'mlb') days.push(md(shift(x.day, -1)), md(shift(x.day, 1))); // MLB plays the same opponent on back-to-back days, so it must match exactly
    const e = days.map((d) => g.find((r) => r.opp === x.opp && r.date === d)).find(Boolean);
    if (e) { x.res = e.v > x.line ? 'hit' : 'miss'; x.act = e.v; graded++; }
    else if (age > VOID_AFTER_D * 864e5) { x.res = 'void'; voided++; }
  }
  return { graded, voided };
}

export function update(prev, props, now = new Date()) {
  const hist = { updated: now.toISOString(), picks: Array.isArray(prev && prev.picks) ? prev.picks.filter((x) => x && x.k && x.day) : [] };
  const added = props.length ? record(hist, props, now) : 0;
  const res = props.length ? grade(hist, props, now) : { graded: 0, voided: 0 };
  const cut = shift(dayOf(now), -KEEP_DAYS);
  hist.picks = hist.picks.filter((x) => x.day >= cut).sort((a, b) => (a.start < b.start ? -1 : 1));
  return Object.assign(hist, { _added: added, _graded: res.graded, _voided: res.voided });
}

async function fetchPrev(url) {
  if (!url) return null;
  const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}
const readLocal = (path) => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };

// Newest of the live copy and the cached copy
export async function loadPrev(url, cachePath) {
  let live = null;
  try { live = await fetchPrev(url); } catch (e) { console.warn(`history: could not read ${url} (${e.message})`); }
  const cached = readLocal(cachePath);
  const pick = [live, cached].filter((h) => h && Array.isArray(h.picks)).sort((a, b) => String(b.updated).localeCompare(String(a.updated)))[0];
  return pick || { picks: [] };
}

export function saveHistory(hist, ...paths) {
  const { _added, _graded, _voided, ...clean } = hist;
  for (const p of paths) { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(clean)); }
}
