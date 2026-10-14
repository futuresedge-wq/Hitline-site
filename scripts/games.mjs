// Game cards: moneyline, spread and total from the odds feed, plus a stats-based matchup for each game.
// Everything is computed from free data (nflverse, NHL, MLB and CFBD) so there is no model and no paid service.
// The odds come from the same per-game requests the props already make (see GAMELINES in build.mjs).
import { getJson, norm, GAMELINES, DEBUG, NFL, ab, injuries, nflData, cfbData, MLBAPI, NHLAPI, ESPN, resetClock } from './build.mjs';

const TZ = 'America/Toronto';
const day = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(iso)); // YYYY-MM-DD
const dayNum = (d) => Math.round(new Date(`${d}T12:00:00Z`).getTime() / 864e5);
const num = (x) => (x === '' || x == null || x === 'NA' ? null : Number.isFinite(Number(x)) ? Number(x) : null);
const imp = (o) => (o < 0 ? -o / (-o + 100) : 100 / (o + 100));
const dec = (o) => (o > 0 ? 1 + o / 100 : 1 + 100 / -o);
const REF = /pinnacle/i;
const ord = (n) => { const v = n % 100; return n + (['th', 'st', 'nd', 'rd'][(v - 20) % 10] || ['th', 'st', 'nd', 'rd'][v] || 'th'); };
const f1 = (x) => (x == null || !Number.isFinite(x) ? '-' : (Math.round(x * 10) / 10).toFixed(1));
const poss = (n) => (/s$/i.test(n) ? `${n}'` : `${n}'s`);
const rec = (w, l, t) => `${w}-${l}${t ? '-' + t : ''}`;

/* ---------- 1. Lines from the raw per-game odds ---------- */
function pairs(outs, a, b, flip) {
  // pairs two sides at the same number: spreads (home +x vs away -x) or totals (Over x vs Under x)
  const out = [];
  for (const x of outs) {
    if (x.name !== a || x.point == null) continue;
    const y = outs.find((z) => z.name === b && z.point != null && Math.abs(z.point - (flip ? -x.point : x.point)) < 1e-9);
    if (y) out.push({ line: x.point, a: x.price, b: y.price });
  }
  return out;
}
const balanced = (list) => list.slice().sort((p, q) => Math.abs(imp(p.a) - imp(p.b)) - Math.abs(imp(q.a) - imp(q.b)))[0];
const mode = (vals) => { const c = new Map(); vals.forEach((v) => c.set(v, (c.get(v) || 0) + 1)); return [...c].sort((x, y) => y[1] - x[1] || Math.abs(x[0]) - Math.abs(y[0]))[0]?.[0] ?? null; };
const best = (arr, k) => arr.filter((x) => !REF.test(x.book) && x[k] != null).sort((x, y) => dec(y[k]) - dec(x[k]))[0] || null;
const offer = (x, k) => (x ? { odds: x[k], book: x.book, link: x.link || null } : null);

export function gameFromOdds(sport, e, o) {
  const allow = (process.env.BOOKS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const DFS = /prizepicks|underdog|sleeper|dabble|parlayplay|pick6|fliff|sportzino|thrillzz|courtside/i;
  const okBook = (b) => (allow.length ? allow.includes(String(b.title).toLowerCase()) || allow.includes(String(b.key).toLowerCase()) : !DFS.test(`${b.key} ${b.title}`));
  const bks = o ? (o.bookmakers || []).filter(okBook) : [];
  const G = { id: `${sport}-${e.id}`, sport, start: e.commence_time, home: e.home_team, away: e.away_team, ml: null, spread: null, total: null, link: null };
  const mls = [], sps = [], tts = [];
  for (const b of bks) {
    const link = typeof b.link === 'string' && /^https:\/\//.test(b.link) ? b.link : null;
    if (link && !G.link && !REF.test(b.title)) G.link = link;
    const ms = (b.markets || []).filter((m) => !m.team);
    const h2h = ms.filter((m) => m.key === 'h2h').flatMap((m) => m.outcomes || []);
    const h = h2h.find((x) => x.name === e.home_team), a = h2h.find((x) => x.name === e.away_team);
    if (h && a) mls.push({ book: b.title, link, home: h.price, away: a.price });
    const sp = pairs(ms.filter((m) => m.key === 'spreads').flatMap((m) => m.outcomes || []), e.home_team, e.away_team, true);
    if (sp.length) sps.push({ book: b.title, link, all: sp, main: balanced(sp) });
    const tt = pairs(ms.filter((m) => m.key === 'totals').flatMap((m) => m.outcomes || []), 'Over', 'Under', false);
    if (tt.length) tts.push({ book: b.title, link, all: tt, main: balanced(tt) });
  }
  if (mls.length) {
    const fair = mls.map((m) => imp(m.home) / (imp(m.home) + imp(m.away)));
    G.ml = { home: offer(best(mls, 'home'), 'home'), away: offer(best(mls, 'away'), 'away'), fair: Math.round((fair.reduce((t, x) => t + x, 0) / fair.length) * 1000) / 10, books: mls };
  }
  const build = (list, ka, kb) => {
    if (!list.length) return null;
    const line = mode(list.map((x) => x.main.line));
    const books = list.map((x) => { const p = x.all.find((z) => z.line === line) || x.main; return { book: x.book, link: x.link, line: p.line, [ka]: p.a, [kb]: p.b }; });
    const at = books.filter((x) => x.line === line);
    return { line, [ka]: offer(best(at, ka), ka), [kb]: offer(best(at, kb), kb), books };
  };
  const sp = build(sps, 'home', 'away'), tt = build(tts, 'over', 'under');
  if (sp) G.spread = sp;
  if (tt) G.total = tt;
  return G;
}

/* ---------- 2. Matchup helpers ---------- */
// items: [{date, opp, home, pf, pa, line, tot}] newest first. line = the team's spread (negative when favoured).
function agg(items) {
  const o = { n: items.length, w: 0, l: 0, t: 0, pf: 0, pa: 0, ats: { w: 0, l: 0, p: 0 }, ou: { o: 0, u: 0, p: 0 }, home: { w: 0, l: 0, t: 0 }, road: { w: 0, l: 0, t: 0 }, last: [], streak: '' };
  for (const x of items) {
    const r = x.pf > x.pa ? 'w' : x.pf < x.pa ? 'l' : 't';
    o[r]++; o[x.home ? 'home' : 'road'][r]++; o.pf += x.pf; o.pa += x.pa;
    if (x.line != null) { const c = x.pf - x.pa + x.line; c > 0 ? o.ats.w++ : c < 0 ? o.ats.l++ : o.ats.p++; }
    if (x.tot != null) { const c = x.pf + x.pa - x.tot; c > 0 ? o.ou.o++ : c < 0 ? o.ou.u++ : o.ou.p++; }
  }
  o.ppg = o.n ? o.pf / o.n : null; o.papg = o.n ? o.pa / o.n : null;
  o.last = items.slice(0, 5).map((x) => ({ r: x.pf > x.pa ? 'W' : x.pf < x.pa ? 'L' : 'T', t: `${x.home ? 'vs' : '@'} ${x.opp} ${x.pf}-${x.pa}` }));
  if (items.length) { const f = items[0].pf > items[0].pa ? 'W' : items[0].pf < items[0].pa ? 'L' : 'T'; let k = 0; for (const x of items) { const r = x.pf > x.pa ? 'W' : x.pf < x.pa ? 'L' : 'T'; if (r === f) k++; else break; } o.streak = f + k; }
  return o;
}
// rank 1 = best. hi: higher is better.
const rankIn = (map, key, hi) => { const v = map.get(key); if (!Number.isFinite(v)) return null; let r = 1; for (const x of map.values()) if (Number.isFinite(x) && (hi ? x > v : x < v)) r++; return r; };
// one comparison row. better: 'high' | 'low' | null
function row(label, h, a, o = {}) {
  const fmt = o.fmt || ((x) => (x == null ? '-' : String(x)));
  let edge = null;
  if (o.better && Number.isFinite(h) && Number.isFinite(a) && h !== a) edge = (o.better === 'high' ? h > a : h < a) ? 'home' : 'away';
  return { label, home: { v: fmt(h), r: o.rh || null }, away: { v: fmt(a), r: o.ra || null }, edge };
}
// "strength meets weakness" note when one side's offence ranks well and the other's defence ranks poorly (or the reverse)
function clash(notes, off, def, offRank, defRank, offTxt, defTxt) {
  if (offRank == null || defRank == null) return;
  if (offRank <= 10 && defRank >= 20) notes.push(`${poss(off)} offence is strong (${offTxt}, ${ord(offRank)}) against a defence that struggles (${defTxt}, ${ord(defRank)}).`);
  else if (offRank >= 22 && defRank <= 10) notes.push(`${poss(off)} offence is weak (${offTxt}, ${ord(offRank)}) against a good defence (${defTxt}, ${ord(defRank)}).`);
}
function commonNotes(notes, H, A, h, a) {
  if (h.ats.w + h.ats.l >= 3 && a.ats.w + a.ats.l >= 3) notes.push(`Against the spread, ${H} is ${rec(h.ats.w, h.ats.l, h.ats.p)} and ${A} is ${rec(a.ats.w, a.ats.l, a.ats.p)}.`);
  if (h.ou.o + h.ou.u >= 3 && a.ou.o + a.ou.u >= 3) notes.push(`Totals: ${H} games went over ${h.ou.o} of ${h.ou.o + h.ou.u} times, ${A} games ${a.ou.o} of ${a.ou.o + a.ou.u}.`);
  const w5 = (x) => x.last.filter((g) => g.r === 'W').length;
  if (h.last.length >= 3 && a.last.length >= 3) notes.push(`Recent form: ${H} has won ${w5(h)} of its last ${h.last.length}, ${A} ${w5(a)} of ${a.last.length}.`);
  if (h.home.w + h.home.l + h.home.t >= 2 && a.road.w + a.road.l + a.road.t >= 2) notes.push(`${H} is ${rec(h.home.w, h.home.l, h.home.t)} at home; ${A} is ${rec(a.road.w, a.road.l, a.road.t)} on the road.`);
}
const shell = (kind, H, A, hAbbr, aAbbr) => ({ kind, home: { name: H, abbr: hAbbr }, away: { name: A, abbr: aAbbr }, stats: [], notes: [], context: [], h2h: [], form: { home: [], away: [] }, inj: { home: [], away: [] } });

/* ---------- 3. NFL ---------- */
async function nflCards(list, errors) {
  const { rows, games, season } = await nflData(errors);
  const reg = games.filter((g) => String(g.season) === String(season) && (!g.game_type || g.game_type === 'REG'));
  const isDone = (g) => num(g.home_score) != null && num(g.away_score) != null;
  const items = new Map();
  const push = (t, x) => { if (!items.has(t)) items.set(t, []); items.get(t).push(x); };
  for (const g of reg.filter(isDone)) {
    const hs = num(g.home_score), as = num(g.away_score), sl = num(g.spread_line), tl = num(g.total_line);
    push(g.home_team, { date: g.gameday, opp: g.away_team, home: true, pf: hs, pa: as, line: sl == null ? null : -sl, tot: tl });
    push(g.away_team, { date: g.gameday, opp: g.home_team, home: false, pf: as, pa: hs, line: sl == null ? null : sl, tot: tl });
  }
  const A = new Map();
  for (const [t, v] of items) A.set(t, agg(v.sort((x, y) => (x.date < y.date ? 1 : -1))));
  const ppg = new Map([...A].map(([t, o]) => [t, o.ppg])), papg = new Map([...A].map(([t, o]) => [t, o.papg]));
  // yards from the player stats: passing and rushing for and against
  const yd = { pf: new Map(), pa: new Map(), rf: new Map(), ra: new Map() };
  const add = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
  for (const r of rows) {
    if (String(r.season) !== String(season) || (r.season_type && r.season_type !== 'REG')) continue;
    const t = ab(r.team || r.recent_team), o = ab(r.opponent_team), py = +r.passing_yards || 0, ry = +r.rushing_yards || 0;
    if (!t || !o) continue;
    add(yd.pf, t, py); add(yd.rf, t, ry); add(yd.pa, o, py); add(yd.ra, o, ry);
  }
  const per = (m) => new Map([...m].map(([t, v]) => [t, A.get(t) && A.get(t).n ? v / A.get(t).n : null]));
  const Y = { pf: per(yd.pf), pa: per(yd.pa), rf: per(yd.rf), ra: per(yd.ra) };
  const injMap = await injuries('football/nfl');
  const bad = (t) => (injMap[norm(t)] || []).filter((x) => /out|doubtful|injured/i.test(x.status)).slice(0, 6).map((x) => `${x.disp} (${x.status})`);
  const out = new Map();
  for (const g of list) {
    const h = ab(NFL[g.home]), a = ab(NFL[g.away]);
    if (!h || !a || !A.has(h) || !A.has(a)) continue;
    const ha = A.get(h), aa = A.get(a), M = shell('nfl', g.home, g.away, h, a);
    const t0 = new Date(g.start).getTime();
    const up = games.find((x) => x.home_team === h && x.away_team === a && String(x.season) === String(season) && Math.abs(new Date(`${x.gameday}T12:00:00Z`).getTime() - t0) < 4 * 864e5);
    const R = (m, t, hi) => rankIn(m, t, hi);
    M.stats.push(
      row('Record', ha.w, aa.w, { better: 'high', fmt: () => '' }),
      row('Points per game', ha.ppg, aa.ppg, { better: 'high', fmt: f1, rh: R(ppg, h, true), ra: R(ppg, a, true) }),
      row('Points allowed', ha.papg, aa.papg, { better: 'low', fmt: f1, rh: R(papg, h, false), ra: R(papg, a, false) }),
      row('Point margin', ha.ppg - ha.papg, aa.ppg - aa.papg, { better: 'high', fmt: (x) => (x > 0 ? '+' : '') + f1(x) }),
      row('Pass yards per game', Y.pf.get(h), Y.pf.get(a), { better: 'high', fmt: f1, rh: R(Y.pf, h, true), ra: R(Y.pf, a, true) }),
      row('Pass yards allowed', Y.pa.get(h), Y.pa.get(a), { better: 'low', fmt: f1, rh: R(Y.pa, h, false), ra: R(Y.pa, a, false) }),
      row('Rush yards per game', Y.rf.get(h), Y.rf.get(a), { better: 'high', fmt: f1, rh: R(Y.rf, h, true), ra: R(Y.rf, a, true) }),
      row('Rush yards allowed', Y.ra.get(h), Y.ra.get(a), { better: 'low', fmt: f1, rh: R(Y.ra, h, false), ra: R(Y.ra, a, false) }));
    M.stats[0] = { label: 'Record', home: { v: rec(ha.w, ha.l, ha.t) }, away: { v: rec(aa.w, aa.l, aa.t) }, edge: ha.w / (ha.n || 1) === aa.w / (aa.n || 1) ? null : ha.w / (ha.n || 1) > aa.w / (aa.n || 1) ? 'home' : 'away' };
    M.stats.push(
      { label: 'Against the spread', home: { v: rec(ha.ats.w, ha.ats.l, ha.ats.p) }, away: { v: rec(aa.ats.w, aa.ats.l, aa.ats.p) }, edge: null },
      { label: 'Over / under', home: { v: `${ha.ou.o}-${ha.ou.u}` }, away: { v: `${aa.ou.o}-${aa.ou.u}` }, edge: null },
      { label: 'Home / road', home: { v: rec(ha.home.w, ha.home.l, ha.home.t) + ' home' }, away: { v: rec(aa.road.w, aa.road.l, aa.road.t) + ' road' }, edge: null },
      { label: 'Streak', home: { v: ha.streak || '-' }, away: { v: aa.streak || '-' }, edge: null });
    if (up && num(up.home_rest) != null) M.stats.push(row('Days of rest', num(up.home_rest), num(up.away_rest), { better: 'high' }));
    M.form = { home: ha.last, away: aa.last };
    commonNotes(M.notes, g.home, g.away, ha, aa);
    clash(M.notes, g.home, g.away, R(ppg, h, true), R(papg, a, false), `${f1(ha.ppg)} pts/g`, `${f1(aa.papg)} allowed`);
    clash(M.notes, g.away, g.home, R(ppg, a, true), R(papg, h, false), `${f1(aa.ppg)} pts/g`, `${f1(ha.papg)} allowed`);
    const rushPass = (off, def, offT, defT) => { const r1 = R(Y.pf, offT, true), d1 = R(Y.pa, defT, false), r2 = R(Y.rf, offT, true), d2 = R(Y.ra, defT, false);
      if (r1 != null && d1 != null && r1 <= 10 && d1 >= 20) M.notes.push(`Passing game to watch: ${off} is ${ord(r1)} in passing yards and ${def} allows the ${ord(d1)}-most.`);
      if (r2 != null && d2 != null && r2 <= 10 && d2 >= 20) M.notes.push(`Rushing game to watch: ${off} is ${ord(r2)} in rushing yards and ${def} allows the ${ord(d2)}-most.`); };
    rushPass(g.home, g.away, h, a); rushPass(g.away, g.home, a, h);
    if (up) {
      const hr = num(up.home_rest), ar = num(up.away_rest);
      if (hr != null && ar != null && Math.abs(hr - ar) >= 3) M.notes.push(`${hr > ar ? g.home : g.away} has ${Math.abs(hr - ar)} more days of rest.`);
      if (up.roof) M.context.push(/outdoors|open/i.test(up.roof) ? 'Outdoor stadium' : `Roof: ${up.roof}`);
      const w = num(up.wind), tp = num(up.temp);
      if (w != null && w >= 15) M.notes.push(`Wind is forecast near ${w} mph, which can hurt passing and kicking.`);
      if (tp != null && tp <= 32) M.notes.push(`Cold game: about ${tp}°F.`);
      if (up.home_qb_name && up.away_qb_name) M.context.push(`Quarterbacks: ${up.away_qb_name} (${a}) at ${up.home_qb_name} (${h})`);
      if (up.stadium) M.context.push(up.stadium);
      if (up.div_game === '1') M.context.push('Divisional game');
    }
    M.h2h = games.filter((x) => isDone(x) && ((x.home_team === h && x.away_team === a) || (x.home_team === a && x.away_team === h))).sort((x, y) => (x.gameday < y.gameday ? 1 : -1)).slice(0, 5)
      .map((x) => `${x.gameday}: ${x.away_team} ${x.away_score} at ${x.home_team} ${x.home_score}`);
    M.inj = { home: bad(g.home), away: bad(g.away) };
    out.set(g.id, { M, h, a });
  }
  return out;
}

/* ---------- 4. College football ---------- */
async function cfbCards(list, errors) {
  const cd = await cfbData(errors);
  const { sched, bySchool, lines, sp } = cd;
  const cands = (full) => { const n = norm(full); return [...bySchool].filter(([s]) => n === s || n.startsWith(s + ' ')).map(([, t]) => t); };
  const T = (nm) => bySchool.get(norm(nm));
  const has = (l, nm) => l.some((t) => norm(t.school) === norm(nm));
  const pair = (e) => {
    const hs = cands(e.home), as = cands(e.away), t0 = new Date(e.start).getTime();
    const near = sched.filter((x) => Math.abs(new Date(x.start).getTime() - t0) < 36e5 * 36);
    let g = near.find((x) => has(hs, x.home) && has(as, x.away));
    if (!g) { const m = near.filter((x) => has(hs, x.home) || has(as, x.away)); if (m.length === 1) g = m[0]; }
    return g && T(g.home) && T(g.away) ? [T(g.home), T(g.away), g] : [hs.sort((p, q) => q.school.length - p.school.length)[0], as.sort((p, q) => q.school.length - p.school.length)[0], null];
  };
  const items = new Map();
  const push = (t, x) => { const k = norm(t); if (!items.has(k)) items.set(k, []); items.get(k).push(x); };
  const abOf = (nm) => (T(nm) ? T(nm).abbr : String(nm).slice(0, 4).toUpperCase());
  for (const g of sched.filter((x) => x.done && x.hp != null && x.ap != null)) {
    const ln = lines[g.id];
    push(g.home, { date: String(g.start).slice(0, 10), opp: abOf(g.away), home: !g.neutral, pf: g.hp, pa: g.ap, line: ln ? ln[0] : null, tot: ln ? ln[1] : null });
    push(g.away, { date: String(g.start).slice(0, 10), opp: abOf(g.home), home: false, pf: g.ap, pa: g.hp, line: ln ? -ln[0] : null, tot: ln ? ln[1] : null });
  }
  const A = new Map();
  for (const [t, v] of items) A.set(t, agg(v.sort((x, y) => (x.date < y.date ? 1 : -1))));
  const elig = [...A].filter(([, o]) => o.n >= 3);
  const ppg = new Map(elig.map(([t, o]) => [t, o.ppg])), papg = new Map(elig.map(([t, o]) => [t, o.papg]));
  const out = new Map();
  for (const g of list) {
    const [ht, at, sg] = pair(g);
    if (!ht || !at) continue;
    const hk = norm(ht.school), ak = norm(at.school), ha = A.get(hk) || agg([]), aa = A.get(ak) || agg([]);
    const M = shell('ncaaf', ht.school, at.school, ht.abbr, at.abbr);
    const R = (m, k, hi) => rankIn(m, k, hi), hs = sp[hk], as = sp[ak];
    if (ha.n || aa.n) {
      M.stats.push(
        { label: 'Record', home: { v: rec(ha.w, ha.l) }, away: { v: rec(aa.w, aa.l) }, edge: ha.w - ha.l === aa.w - aa.l ? null : ha.w - ha.l > aa.w - aa.l ? 'home' : 'away' });
      if (hs && as) M.stats.push(
        row('SP+ rating', hs.rating, as.rating, { better: 'high', fmt: f1, rh: hs.rank, ra: as.rank }),
        row('SP+ offence', hs.offR, as.offR, { better: 'high', fmt: f1, rh: hs.off, ra: as.off }),
        row('SP+ defence', hs.defR, as.defR, { better: 'low', fmt: f1, rh: hs.def, ra: as.def }));
      M.stats.push(
        row('Points per game', ha.ppg, aa.ppg, { better: 'high', fmt: f1, rh: R(ppg, hk, true), ra: R(ppg, ak, true) }),
        row('Points allowed', ha.papg, aa.papg, { better: 'low', fmt: f1, rh: R(papg, hk, false), ra: R(papg, ak, false) }),
        row('Point margin', ha.ppg - ha.papg, aa.ppg - aa.papg, { better: 'high', fmt: (x) => (x > 0 ? '+' : '') + f1(x) }),
        { label: 'Against the spread', home: { v: rec(ha.ats.w, ha.ats.l, ha.ats.p) }, away: { v: rec(aa.ats.w, aa.ats.l, aa.ats.p) }, edge: null },
        { label: 'Over / under', home: { v: `${ha.ou.o}-${ha.ou.u}` }, away: { v: `${aa.ou.o}-${aa.ou.u}` }, edge: null },
        { label: 'Home / road', home: { v: rec(ha.home.w, ha.home.l) + ' home' }, away: { v: rec(aa.road.w, aa.road.l) + ' road' }, edge: null },
        { label: 'Streak', home: { v: ha.streak || '-' }, away: { v: aa.streak || '-' }, edge: null });
      M.form = { home: ha.last, away: aa.last };
      commonNotes(M.notes, ht.school, at.school, ha, aa);
      clash(M.notes, ht.school, at.school, R(ppg, hk, true), R(papg, ak, false), `${f1(ha.ppg)} pts/g`, `${f1(aa.papg)} allowed`);
      clash(M.notes, at.school, ht.school, R(ppg, ak, true), R(papg, hk, false), `${f1(aa.ppg)} pts/g`, `${f1(ha.papg)} allowed`);
    }
    if (hs && as && Number.isFinite(hs.rating) && Number.isFinite(as.rating)) {
      const d = hs.rating - as.rating, fav = d >= 0 ? ht.school : at.school;
      M.notes.push(`SP+ rates ${fav} ${f1(Math.abs(d))} points better on a neutral field${sg && sg.neutral ? '' : ' (home field is worth a few more to the host)'}.`);
    }
    if (sg && sg.neutral) M.context.push('Neutral site');
    const lastDate = (k) => { const v = items.get(k); return v && v.length ? v[0].date : null; };
    const rest = (k) => { const d = lastDate(k); return d ? dayNum(day(g.start)) - dayNum(d) : null; };
    const hr = rest(hk), ar = rest(ak);
    if (hr != null && ar != null) { M.stats.push(row('Days since last game', hr, ar, { better: 'high' })); if (Math.abs(hr - ar) >= 3) M.notes.push(`${hr > ar ? ht.school : at.school} has ${Math.abs(hr - ar)} more days since its last game (a bye or a short week matters).`); }
    out.set(g.id, { M, h: ht.abbr, a: at.abbr });
  }
  return out;
}

/* ---------- 5. NHL ---------- */
async function nhlCards(list, errors) {
  const st = (await getJson(`${NHLAPI}/standings/now`)).standings || [];
  const now = new Date(), y = now.getFullYear(), s = now.getMonth() >= 8 ? y : y - 1;
  const teams = st.map((t) => ({ abbr: t.teamAbbrev.default, common: t.teamCommonName.default, full: `${t.placeName ? t.placeName.default : ''} ${t.teamCommonName.default}`.trim(), t }));
  const find = (full) => { const n = norm(full); return teams.find((x) => norm(x.full) === n) || teams.find((x) => n.endsWith(norm(x.common))); };
  let sum = new Map();
  try {
    const d = await getJson(`https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=${encodeURIComponent(`seasonId=${s}${s + 1} and gameTypeId=2`)}`);
    for (const r of d.data || []) sum.set(norm(r.teamFullName), r);
    if (!DEBUG.nhlSummarySample && d.data && d.data[0]) DEBUG.nhlSummarySample = Object.keys(d.data[0]);
  } catch (e) { (DEBUG.logErrors = DEBUG.logErrors || []).push(`nhl team summary: ${e.message}`); }
  const sumOf = (x) => sum.get(norm(x.full)) || [...sum].find(([k]) => k.endsWith(norm(x.common)))?.[1] || null;
  const gp = (x) => x.t.gamesPlayed || 0;
  const gf = new Map(teams.map((x) => [x.abbr, gp(x) ? x.t.goalFor / gp(x) : null])), ga = new Map(teams.map((x) => [x.abbr, gp(x) ? x.t.goalAgainst / gp(x) : null]));
  const sm = (k) => new Map(teams.map((x) => [x.abbr, sumOf(x) ? sumOf(x)[k] : null]));
  const pp = sm('powerPlayPct'), pk = sm('penaltyKillPct'), sf = sm('shotsForPerGame'), sa = sm('shotsAgainstPerGame');
  const sched = new Map();
  const need = new Set(); list.forEach((g) => { const a = find(g.home), b = find(g.away); if (a) need.add(a.abbr); if (b) need.add(b.abbr); });
  await Promise.all([...need].map(async (ab2) => { try { sched.set(ab2, (await getJson(`${NHLAPI}/club-schedule-season/${ab2}/now`)).games || []); } catch (e) { (DEBUG.logErrors = DEBUG.logErrors || []).push(`nhl schedule ${ab2}: ${e.message}`); } }));
  const finals = (ab2) => (sched.get(ab2) || []).filter((x) => /FINAL|OFF/.test(x.gameState) && x.gameType === 2).sort((p, q) => (p.gameDate < q.gameDate ? 1 : -1));
  const itemsOf = (ab2) => finals(ab2).map((x) => { const home = x.homeTeam.abbrev === ab2, me = home ? x.homeTeam : x.awayTeam, op = home ? x.awayTeam : x.homeTeam; return { date: x.gameDate, opp: op.abbrev, home, pf: me.score, pa: op.score }; });
  const out = new Map();
  for (const g of list) {
    const H = find(g.home), Aw = find(g.away);
    if (!H || !Aw) continue;
    const h = H.t, a = Aw.t, M = shell('nhl', g.home, g.away, H.abbr, Aw.abbr);
    const hi = agg(itemsOf(H.abbr)), ai = agg(itemsOf(Aw.abbr));
    const R = (m, k, hiB) => rankIn(m, k, hiB), pct = (x) => (x == null ? null : x * 100);
    const gdl = (t) => `${t.goalDifferential > 0 ? '+' : ''}${t.goalDifferential}`;
    M.stats.push(
      { label: 'Record', home: { v: `${h.wins}-${h.losses}-${h.otLosses}` }, away: { v: `${a.wins}-${a.losses}-${a.otLosses}` }, edge: h.pointPctg === a.pointPctg ? null : h.pointPctg > a.pointPctg ? 'home' : 'away' },
      row('Points %', pct(h.pointPctg), pct(a.pointPctg), { better: 'high', fmt: f1 }),
      row('Goals per game', gf.get(H.abbr), gf.get(Aw.abbr), { better: 'high', fmt: (x) => (x == null ? '-' : x.toFixed(2)), rh: R(gf, H.abbr, true), ra: R(gf, Aw.abbr, true) }),
      row('Goals against', ga.get(H.abbr), ga.get(Aw.abbr), { better: 'low', fmt: (x) => (x == null ? '-' : x.toFixed(2)), rh: R(ga, H.abbr, false), ra: R(ga, Aw.abbr, false) }),
      { label: 'Goal difference', home: { v: gdl(h) }, away: { v: gdl(a) }, edge: h.goalDifferential === a.goalDifferential ? null : h.goalDifferential > a.goalDifferential ? 'home' : 'away' });
    if (sum.size) M.stats.push(
      row('Power play %', pct(pp.get(H.abbr)), pct(pp.get(Aw.abbr)), { better: 'high', fmt: f1, rh: R(pp, H.abbr, true), ra: R(pp, Aw.abbr, true) }),
      row('Penalty kill %', pct(pk.get(H.abbr)), pct(pk.get(Aw.abbr)), { better: 'high', fmt: f1, rh: R(pk, H.abbr, true), ra: R(pk, Aw.abbr, true) }),
      row('Shots for per game', sf.get(H.abbr), sf.get(Aw.abbr), { better: 'high', fmt: f1, rh: R(sf, H.abbr, true), ra: R(sf, Aw.abbr, true) }),
      row('Shots against', sa.get(H.abbr), sa.get(Aw.abbr), { better: 'low', fmt: f1, rh: R(sa, H.abbr, false), ra: R(sa, Aw.abbr, false) }));
    M.stats.push(
      { label: 'Home / road', home: { v: `${h.homeWins}-${h.homeLosses}-${h.homeOtLosses} home` }, away: { v: `${a.roadWins}-${a.roadLosses}-${a.roadOtLosses} road` }, edge: null },
      { label: 'Last 10', home: { v: `${h.l10Wins}-${h.l10Losses}-${h.l10OtLosses}` }, away: { v: `${a.l10Wins}-${a.l10Losses}-${a.l10OtLosses}` }, edge: null },
      { label: 'Streak', home: { v: h.streakCode ? h.streakCode + h.streakCount : '-' }, away: { v: a.streakCode ? a.streakCode + a.streakCount : '-' }, edge: null });
    M.form = { home: hi.last, away: ai.last };
    const rest = (ab2) => { const f = finals(ab2)[0]; return f ? dayNum(day(g.start)) - dayNum(f.gameDate) - 1 : null; };
    const hr = rest(H.abbr), ar = rest(Aw.abbr);
    if (hr != null && ar != null) M.stats.push(row('Days of rest', hr, ar, { better: 'high' }));
    if (hr === 0) M.notes.push(`${g.home} is on the second night of a back-to-back.`);
    if (ar === 0) M.notes.push(`${g.away} is on the second night of a back-to-back.`);
    if (hr != null && ar != null && Math.abs(hr - ar) >= 2 && hr > 0 && ar > 0) M.notes.push(`${hr > ar ? g.home : g.away} has ${Math.abs(hr - ar)} more days of rest.`);
    if (h.gamesPlayed >= 3 && a.gamesPlayed >= 3) {
      const w5 = (x) => x.last.filter((q) => q.r === 'W').length;
      if (hi.last.length >= 3 && ai.last.length >= 3) M.notes.push(`Recent form: ${g.home} has won ${w5(hi)} of its last ${hi.last.length}, ${g.away} ${w5(ai)} of ${ai.last.length}.`);
      const rk = (m, k, hiB) => R(m, k, hiB);
      const o1 = rk(gf, H.abbr, true), d1 = rk(ga, Aw.abbr, false), o2 = rk(gf, Aw.abbr, true), d2 = rk(ga, H.abbr, false);
      clash(M.notes, g.home, g.away, o1, d1, `${f1(gf.get(H.abbr))} goals/g`, `${f1(ga.get(Aw.abbr))} against`);
      clash(M.notes, g.away, g.home, o2, d2, `${f1(gf.get(Aw.abbr))} goals/g`, `${f1(ga.get(H.abbr))} against`);
      const ppH = rk(pp, H.abbr, true), pkA = rk(pk, Aw.abbr, true), ppA = rk(pp, Aw.abbr, true), pkH = rk(pk, H.abbr, true);
      if (ppH != null && pkA != null && ppH <= 8 && pkA >= 24) M.notes.push(`Special teams edge: ${poss(g.home)} power play ranks ${ord(ppH)} against a penalty kill ranked ${ord(pkA)}.`);
      if (ppA != null && pkH != null && ppA <= 8 && pkH >= 24) M.notes.push(`Special teams edge: ${poss(g.away)} power play ranks ${ord(ppA)} against a penalty kill ranked ${ord(pkH)}.`);
    }
    const meet = (sched.get(H.abbr) || []).filter((x) => /FINAL|OFF/.test(x.gameState) && x.gameType === 2 && (x.homeTeam.abbrev === Aw.abbr || x.awayTeam.abbrev === Aw.abbr)).sort((p, q) => (p.gameDate < q.gameDate ? 1 : -1));
    M.h2h = meet.slice(0, 5).map((x) => `${x.gameDate}: ${x.awayTeam.abbrev} ${x.awayTeam.score} at ${x.homeTeam.abbrev} ${x.homeTeam.score}`);
    M.context.push('Starting goalies are usually confirmed on game day. Check the lineup before betting a goalie or team prop.');
    out.set(g.id, { M, h: H.abbr, a: Aw.abbr });
  }
  return out;
}

/* ---------- 6. MLB ---------- */
async function mlbCards(list, errors) {
  const now = new Date(), y = now.getMonth() >= 1 ? now.getFullYear() : now.getFullYear() - 1;
  const tl = (await getJson(`${MLBAPI}/teams?sportId=1`)).teams;
  const find = (full) => { const n = norm(full); return tl.find((t) => norm(t.name) === n) || tl.find((t) => n.endsWith(norm(t.teamName))); };
  const stand = new Map();
  try {
    const d = await getJson(`${MLBAPI}/standings?leagueId=103,104&season=${y}&standingsTypes=regularSeason`);
    for (const r of d.records || []) for (const t of r.teamRecords || []) stand.set(t.team.id, t);
  } catch (e) { errors.push(`mlb matchups: standings failed (${e.message})`); return new Map(); }
  const spl = (t, type) => { const x = ((t.records && t.records.splitRecords) || []).find((z) => z.type === type); return x ? `${x.wins}-${x.losses}` : '-'; };
  const gpOf = (t) => (t.wins || 0) + (t.losses || 0);
  const rpg = new Map([...stand].map(([id, t]) => [id, gpOf(t) ? t.runsScored / gpOf(t) : null])), rag = new Map([...stand].map(([id, t]) => [id, gpOf(t) ? t.runsAllowed / gpOf(t) : null]));
  // probable pitchers for the games in the window
  const ts = list.map((g) => new Date(g.start).getTime());
  const probable = new Map();
  if (ts.length) {
    const d0 = new Date(Math.min(...ts) - 864e5).toISOString().slice(0, 10), d1 = new Date(Math.max(...ts) + 864e5).toISOString().slice(0, 10);
    try {
      const sc = await getJson(`${MLBAPI}/schedule?sportId=1&startDate=${d0}&endDate=${d1}&hydrate=probablePitcher`);
      for (const dt of sc.dates || []) for (const gm of dt.games || []) probable.set(gm.gamePk, gm);
    } catch (e) { (DEBUG.logErrors = DEBUG.logErrors || []).push(`mlb probables: ${e.message}`); }
  }
  const pcache = new Map();
  const pitcher = (p) => { if (!p) return Promise.resolve(null); if (!pcache.has(p.id)) pcache.set(p.id, (async () => { try { const d = await getJson(`${MLBAPI}/people/${p.id}/stats?stats=season&group=pitching&season=${y}`); const s = d.stats?.[0]?.splits?.[0]?.stat; return { name: p.fullName, era: s ? Number(s.era) : null, whip: s ? Number(s.whip) : null, k9: s && s.strikeoutsPer9Inn != null ? Number(s.strikeoutsPer9Inn) : null, ip: s ? s.inningsPitched : null, gs: s ? s.gamesStarted : null, rec: s ? `${s.wins}-${s.losses}` : null }; } catch { return { name: p.fullName, era: null, whip: null, k9: null, ip: null, gs: null, rec: null }; } })()); return pcache.get(p.id); };
  const out = new Map();
  for (const g of list) {
    const H = find(g.home), A2 = find(g.away);
    if (!H || !A2 || !stand.has(H.id) || !stand.has(A2.id)) continue;
    const h = stand.get(H.id), a = stand.get(A2.id), M = shell('mlb', g.home, g.away, H.abbreviation, A2.abbreviation);
    const R = (m, k, hi) => rankIn(m, k, hi), wp = (t) => (gpOf(t) ? t.wins / gpOf(t) : null);
    M.stats.push(
      { label: 'Record', home: { v: `${h.wins}-${h.losses}` }, away: { v: `${a.wins}-${a.losses}` }, edge: wp(h) === wp(a) ? null : wp(h) > wp(a) ? 'home' : 'away' },
      row('Runs per game', rpg.get(H.id), rpg.get(A2.id), { better: 'high', fmt: (x) => (x == null ? '-' : x.toFixed(2)), rh: R(rpg, H.id, true), ra: R(rpg, A2.id, true) }),
      row('Runs allowed', rag.get(H.id), rag.get(A2.id), { better: 'low', fmt: (x) => (x == null ? '-' : x.toFixed(2)), rh: R(rag, H.id, false), ra: R(rag, A2.id, false) }),
      { label: 'Run difference', home: { v: `${h.runDifferential > 0 ? '+' : ''}${h.runDifferential}` }, away: { v: `${a.runDifferential > 0 ? '+' : ''}${a.runDifferential}` }, edge: h.runDifferential === a.runDifferential ? null : h.runDifferential > a.runDifferential ? 'home' : 'away' },
      { label: 'Home / road', home: { v: spl(h, 'home') + ' home' }, away: { v: spl(a, 'away') + ' road' }, edge: null },
      { label: 'Last 10', home: { v: spl(h, 'lastTen') }, away: { v: spl(a, 'lastTen') }, edge: null },
      { label: 'Streak', home: { v: (h.streak && h.streak.streakCode) || '-' }, away: { v: (a.streak && a.streak.streakCode) || '-' }, edge: null });
    out.set(g.id, { M, h: H.abbreviation, a: A2.abbreviation, H, A2, _g: g });
  }
  // starters (done after the loop so the pitcher lookups run in parallel)
  await Promise.all([...out.values()].map(async (v) => {
    const t0 = new Date(v._g.start).getTime();
    const gm = [...probable.values()].find((x) => x.teams.home.team.id === v.H.id && x.teams.away.team.id === v.A2.id && Math.abs(new Date(x.gameDate).getTime() - t0) < 5 * 36e5);
    if (!gm) return;
    const [hp, ap] = await Promise.all([pitcher(gm.teams.home.probablePitcher), pitcher(gm.teams.away.probablePitcher)]);
    if (!hp && !ap) return;
    const M = v.M, nm = (p) => (p ? p.name : 'TBD');
    M.stats.push({ label: 'Probable starter', home: { v: nm(hp) }, away: { v: nm(ap) }, edge: null });
    if (hp && ap) M.stats.push(
      row('Starter ERA', hp.era, ap.era, { better: 'low', fmt: (x) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(2)) }),
      row('Starter WHIP', hp.whip, ap.whip, { better: 'low', fmt: (x) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(2)) }),
      row('Starter K/9', hp.k9, ap.k9, { better: 'high', fmt: (x) => (x == null || Number.isNaN(x) ? '-' : x.toFixed(1)) }));
    for (const [p, side, opp] of [[hp, v._g.home, v._g.away], [ap, v._g.away, v._g.home]]) if (p && p.era != null && p.gs >= 3) M.notes.push(`${p.name} (${side}) has a ${p.era.toFixed(2)} ERA and ${p.whip != null ? p.whip.toFixed(2) + ' WHIP ' : ''}over ${p.ip} innings this season.`);
    if (hp && ap && hp.era != null && ap.era != null && Math.abs(hp.era - ap.era) >= 1.5 && hp.gs >= 3 && ap.gs >= 3) M.notes.push(`Pitching edge: ${poss(hp.era < ap.era ? v._g.home : v._g.away)} starter has the clearly better ERA.`);
  }));
  for (const v of out.values()) {
    const gg = v._g, M = v.M, h = stand.get(v.H.id), a = stand.get(v.A2.id);
    const wpH = h.wins / (gpOf(h) || 1), wpA = a.wins / (gpOf(a) || 1);
    if (gpOf(h) >= 20 && gpOf(a) >= 20) {
      const o1 = rankIn(rpg, v.H.id, true), d1 = rankIn(rag, v.A2.id, false), o2 = rankIn(rpg, v.A2.id, true), d2 = rankIn(rag, v.H.id, false);
      clash(M.notes, gg.home, gg.away, o1, d1, `${f1(rpg.get(v.H.id))} runs/g`, `${f1(rag.get(v.A2.id))} allowed`);
      clash(M.notes, gg.away, gg.home, o2, d2, `${f1(rpg.get(v.A2.id))} runs/g`, `${f1(rag.get(v.H.id))} allowed`);
      if (Math.abs(wpH - wpA) >= 0.1) M.notes.push(`${wpH > wpA ? gg.home : gg.away} had the better regular-season record by ${Math.round(Math.abs(wpH - wpA) * 100)} points of win percentage.`);
    }
    M.context.push('Numbers are regular-season totals for the season shown. Lineups and bullpen use are not included.');
    delete v._g; delete v.H; delete v.A2;
  }
  return out;
}

/* ---------- 6b. Written analysis: plain-English summary built from the lines and the numbers above (no AI service, no cost) ---------- */
const am = (o) => (o > 0 ? '+' + o : String(o));
const pfloat = (r) => (r ? parseFloat(String(r.home.v)) : NaN);
export function analysis(g, M) {
  const out = [], H = g.home, A = g.away;
  // 1. what the market says
  const m = [];
  if (g.spread && g.spread.line !== 0 && (g.sport === 'nfl' || g.sport === 'ncaaf')) {
    const fav = g.spread.line < 0 ? H : A, pts = Math.abs(g.spread.line);
    m.push(`The market has ${fav} as a ${pts}-point favourite${g.ml ? '' : '.'}`);
  }
  if (g.ml && g.ml.fair != null) {
    const homeFav = g.ml.fair >= 50, fav = homeFav ? H : A, pct = homeFav ? g.ml.fair : 100 - g.ml.fair, o = (homeFav ? g.ml.home : g.ml.away);
    m.push(m.length ? `, and the moneyline puts ${poss(fav)} win chance at about ${Math.round(pct)}% (best price ${am(o.odds)}).` : `The moneyline makes ${fav} the favourite at about ${Math.round(pct)}% to win (best price ${am(o.odds)}).`);
  }
  let first = m.join('');
  if (g.total) first += `${first ? ' ' : ''}The total is set at ${g.total.line}.`;
  if (first) out.push(first);
  // 2. how the numbers compare
  const rows = M.stats.filter((r) => r.edge), nh = rows.filter((r) => r.edge === 'home'), na = rows.filter((r) => r.edge === 'away');
  if (rows.length >= 3) {
    const lead = nh.length === na.length ? null : nh.length > na.length ? 'home' : 'away', who = lead === 'home' ? H : A, mine = lead === 'home' ? nh : na;
    if (lead) out.push(`On the numbers, the edge goes to ${who}, with the better figure in ${mine.length} of ${rows.length} compared categories, including ${mine.slice(0, 3).map((r) => r.label.toLowerCase()).join(', ')}.`);
    else out.push(`The two teams are even on the numbers: each has the better figure in ${nh.length} of ${rows.length} compared categories.`);
  }
  // 3. what stands out (the notes above, in order)
  if (M.notes.length) out.push(`Worth knowing: ${M.notes.slice(0, 4).join(' ')}`);
  // 4. what the total implies against how each team actually scores (football only: the spread and total translate into points)
  if (g.total && g.spread && (g.sport === 'nfl' || g.sport === 'ncaaf')) {
    const ph = pfloat(M.stats.find((r) => r.label === 'Points per game')), pa = M.stats.find((r) => r.label === 'Points per game');
    const paw = pa ? parseFloat(String(pa.away.v)) : NaN;
    if (Number.isFinite(ph) && Number.isFinite(paw)) {
      const ih = (g.total.line - g.spread.line) / 2, ia = (g.total.line + g.spread.line) / 2;
      out.push(`The spread and total imply about ${ih.toFixed(1)} points for ${H} and ${ia.toFixed(1)} for ${A}. This season they have averaged ${ph.toFixed(1)} and ${paw.toFixed(1)}.`);
    }
  }
  // 5. caution
  const tail = { nhl: 'Starting goalies are not confirmed until game day and can move a line a lot.', mlb: 'Lineups and bullpen availability are not included and can change the picture.', nfl: 'Late injury news and weather can change this, so check the lineup before kickoff.', ncaaf: 'Late injury news and depth-chart changes can change this, so check before kickoff.' }[g.sport];
  out.push(`${tail} This summarises the numbers on this page and is not a prediction or betting advice.`);
  return out;
}

/* ---------- 7. Put it together ---------- */
export async function buildGames(errors) {
  resetClock();
  const sports = (process.env.SPORTS || 'nhl,nfl,mlb').split(',').map((x) => x.trim());
  const all = [];
  for (const sport of ['nfl', 'ncaaf', 'nhl', 'mlb']) {
    if (!sports.includes(sport) || !GAMELINES[sport]) continue;
    const games = GAMELINES[sport].events.map(({ e, o }) => gameFromOdds(sport, e, o));
    DEBUG[`${sport}Games`] = { events: games.length, withMoneyline: games.filter((g) => g.ml).length, withSpread: games.filter((g) => g.spread).length, withTotal: games.filter((g) => g.total).length };
    let cards = new Map();
    try {
      const fn = { nfl: nflCards, ncaaf: cfbCards, nhl: nhlCards, mlb: mlbCards }[sport];
      cards = await fn(games, errors);
    } catch (e) { errors.push(`${sport} matchups: ${e.message}`); }
    for (const g of games) {
      const c = cards.get(g.id);
      if (c) { g.homeAbbr = c.h; g.awayAbbr = c.a; g.matchup = c.M; try { c.M.analysis = analysis(g, c.M); } catch { c.M.analysis = []; } }
      else if (sport === 'nfl') { g.homeAbbr = ab(NFL[g.home]) || null; g.awayAbbr = ab(NFL[g.away]) || null; }
      all.push(g);
    }
    DEBUG[`${sport}Games`].withMatchup = games.filter((g) => g.matchup).length;
  }
  return all.sort((a, b) => (a.start < b.start ? -1 : 1));
}
