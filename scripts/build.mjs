// Builds the props dataset: lines (The Odds API) + game logs (NHL API, nflverse) + injuries (ESPN, unofficial).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
// NHL game logs are cached between runs (last season never changes; this season is refreshed after 12h)
const LOGS = {};
// Time budget: when it runs out, uncached players are skipped (they get picked up on the next run) so the site still publishes
let START = Date.now();
const budgetMs = () => Number(process.env.BUILD_MINUTES || 15) * 60000;
let FETCHED = 0;
export function loadCache(path) { try { Object.assign(LOGS, JSON.parse(readFileSync(path, 'utf8'))); } catch {} }
export function saveCache(path) { try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(LOGS)); } catch {} }
const ODDS = 'https://api.the-odds-api.com/v4';
const NHLAPI = 'https://api-web.nhle.com/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const MLBAPI = 'https://statsapi.mlb.com/api/v1';
const MARKETS = {
  nhl: { key: 'icehockey_nhl', espn: 'hockey/nhl', list: {
    player_shots_on_goal: ['Shots on goal', 'shots'], player_points: ['Points', 'points'], player_assists: ['Assists', 'assists'],
    player_goals: ['Goals', 'goals'], player_power_play_points: ['Power play points', 'powerPlayPoints'], player_blocked_shots: ['Blocked shots', 'blockedShots'],
    player_goals_2plus: ['Goals', 'goals'], player_points_1plus: ['Points', 'points'], player_points_2plus: ['Points', 'points'], player_points_3plus: ['Points', 'points'], goalie_saves: ['Saves', 'saves'] } },
  mlb: { key: 'baseball_mlb', espn: 'baseball/mlb', list: {
    batter_hits: ['Hits', 'hits', 'hitting'], batter_total_bases: ['Total bases', 'totalBases', 'hitting'], batter_home_runs: ['Home runs', 'homeRuns', 'hitting'],
    batter_rbis: ['RBIs', 'rbi', 'hitting'], batter_runs_scored: ['Runs', 'runs', 'hitting'], batter_hits_runs_rbis: ['Hits + runs + RBIs', 'hrr', 'hitting'],
    pitcher_strikeouts: ['Pitcher strikeouts', 'strikeOuts', 'pitching'], pitcher_outs: ['Pitcher outs', 'outs', 'pitching'] } },
  nfl: { key: 'americanfootball_nfl', espn: 'football/nfl', list: {
    player_rush_yds: ['Rushing yards', 'rushing_yards'], player_reception_yds: ['Receiving yards', 'receiving_yards'], player_receptions: ['Receptions', 'receptions'],
    player_pass_yds: ['Passing yards', 'passing_yards'], player_rush_attempts: ['Rush attempts', 'carries'],
    player_pass_tds: ['Passing TDs', 'passing_tds'], player_anytime_td: ['Touchdowns', 'tds'], player_2plus_td: ['Touchdowns', 'tds'] } },
};
const NFL = { 'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF','Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE','Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB','Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC','Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LA','Miami Dolphins':'MIA','Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG','New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF','Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS' };
const lev = (a, b) => {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
};
const DEBUG = {}; // shown in /api/props to help diagnose missing games
const ANYTIME = new Set(['player_goals', 'player_anytime_td', 'batter_home_runs']); // anytime-scorer prices are over 0.5
const ab = (t) => (t === 'LAR' ? 'LA' : t);

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/-/g, ' ').replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim().replace(/ (jr|sr|ii|iii|iv)$/, '');
const md = (d) => { const [, m, x] = d.split('-'); return `${+m}/${+x}`; };
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
// Retries rate-limited (429) requests, honouring Retry-After
const getText = async (url) => {
  for (let i = 0; ; i++) {
    let r;
    try { r = await fetch(url, { signal: AbortSignal.timeout(45000) }); }
    catch (e) { if (i < 3) { await sleep(1000 * (i + 1)); continue; } throw e; }
    if ((r.status === 429 || r.status >= 500) && i < 3) { await sleep(Math.min(Number(r.headers.get('retry-after')) || 2 * (i + 1), 20) * 1000); continue; }
    if (!r.ok) throw new Error(`${r.status} ${url.replace(/apiKey=[^&]+/, 'apiKey=***')}`);
    return r.text();
  }
};
const getJson = async (url) => JSON.parse(await getText(url));
async function pool(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}
function csv(t) {
  const split = (l) => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o; };
  const lines = t.split(/\r?\n/), h = split(lines[0]);
  return lines.slice(1).filter(Boolean).map((l) => { const v = split(l), r = {}; h.forEach((k, i) => (r[k] = v[i])); return r; });
}

// Over lines from every bookmaker, grouped by player and market
// Each sport can use its own odds provider: NHL_ODDS_BASE_URL / NHL_ODDS_KEY, NFL_ODDS_BASE_URL / NFL_ODDS_KEY.
// Anything unset falls back to ODDS_BASE_URL / ODDS_API_KEY, then to The Odds API.
async function oddsProps(cfg, sport) {
  const U = sport.toUpperCase();
  const key = process.env[`${U}_ODDS_KEY`] || process.env.ODDS_API_KEY;
  const base = process.env[`${U}_ODDS_BASE_URL`] || process.env.ODDS_BASE_URL || ODDS;
  if (!key) throw new Error(`No odds API key set for ${sport} (set ${U}_ODDS_KEY or ODDS_API_KEY)`);
  const regions = process.env.ODDS_REGIONS || 'us', horizon = Number(process.env[`${U}_HORIZON_HOURS`] || process.env.HORIZON_HOURS || 36);
  const events = await getJson(`${base}/sports/${cfg.key}/events?apiKey=${key}`);
  const soon = events.filter((e) => { const h = (new Date(e.commence_time) - Date.now()) / 36e5; return h > -1 && h < horizon; }).slice(0, Number(process.env.MAX_EVENTS || 50));
  const only = (process.env.MARKETS || '').split(',').map((x) => x.trim()).filter(Boolean);
  const markets = Object.keys(cfg.list).filter((k) => !only.length || only.includes(k)).join(',');
  if (!markets) return [];
  const res = await pool(soon, 1, async (e) => {
    await sleep(300); // one game at a time, spaced out, to stay under burst limits
    try { return { e, o: await getJson(`${base}/sports/${cfg.key}/events/${e.id}/odds?apiKey=${key}&regions=${regions}&markets=${markets}&oddsFormat=american`) }; }
    catch (err) { return { e, err: err.message }; }
  });
  console.log(`${sport}: odds for ${soon.length} games fetched, ${Math.round((Date.now() - START) / 1000)}s elapsed`);
  DEBUG[sport] = { eventsListed: events.length, inWindow: soon.length, games: res.map((r) => (r ? `${r.e.away_team} @ ${r.e.home_team}: ${r.err ? 'ERROR ' + r.err : (r.o.bookmakers || []).length + ' books'}` : 'failed')) };
  // Everything the feed returned, before any filtering, so missing markets can be diagnosed
  const seen = {};
  for (const r of res) if (r && r.o) for (const b of r.o.bookmakers || []) for (const m of b.markets || []) {
    const sm = (seen[m.key] = seen[m.key] || { books: [], outcomeNames: [], sample: null });
    if (!sm.books.includes(b.key)) sm.books.push(b.key);
    for (const x of m.outcomes || []) {
      if (!sm.outcomeNames.includes(x.name)) sm.outcomeNames.push(x.name);
      if (!sm.sample) sm.sample = { description: x.description, name: x.name, point: x.point, price: x.price };
    }
  }
  DEBUG[sport].marketsSeen = seen;
  const map = new Map();
  // BOOKS=DraftKings,FanDuel,... keeps only those books. If unset, DFS and sweepstakes apps are dropped
  // because their synthetic even-money prices would distort best-odds and edge.
  const allow = (process.env.BOOKS || '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const DFS = /prizepicks|underdog|sleeper|dabble|parlayplay|pick6|fliff|sportzino|thrillzz|courtside/i;
  const okBook = (b) => (allow.length ? allow.includes(String(b.title).toLowerCase()) || allow.includes(String(b.key).toLowerCase()) : !DFS.test(`${b.key} ${b.title}`));
  for (const r of res) {
    if (!r || !r.o) continue;
    for (const b of (r.o.bookmakers || []).filter(okBook)) for (const m of b.markets || []) for (const x of m.outcomes || []) {
      if (!cfg.list[m.key]) continue;
      let who = x.description, line = x.point;
      const ms = /(?:^|_)(\d)plus(?:_|$)/.exec(m.key); // milestone market: 2plus = over 1.5
      if (ms) {
        if (/^(under|no)$/i.test(x.name)) continue;
        who = /^(yes|over)$/i.test(x.name) || /^\d+\+/.test(x.name) ? x.description : x.name;
        line = Number(ms[1]) - 0.5;
      } else if (x.name === 'Over' && x.point != null) { /* normal over/under */ }
      else if (ANYTIME.has(m.key) && x.point == null && !/^(under|no)$/i.test(x.name) && !/^\d+\+/.test(x.name)) {
        who = x.name === 'Yes' ? x.description : x.name; line = 0.5; // anytime goal scorer = over 0.5 goals
      } else continue;
      const pname = String(who || '').replace(/\s*\([^)]*\)\s*$/, '').replace(/^([^,]+),\s*(.+)$/, '$2 $1').trim(); // some feeds append "(TEAM)"
      const k = `${norm(pname)}|${m.key}`;
      if (!map.has(k)) map.set(k, { player: pname, mkey: m.key, event: r.e, books: [] });
      map.get(k).books.push({ book: b.title, line, odds: x.price });
    }
  }
  return [...map.values()];
}

async function injuries(path) {
  try {
    const d = await getJson(`${ESPN}/${path}/injuries`), m = {};
    for (const t of d.injuries || []) m[norm(t.displayName)] = (t.injuries || []).map((i) => ({ name: norm(i.athlete?.displayName), disp: i.athlete?.displayName || '', status: i.status || '', detail: (i.shortComment || '').slice(0, 90) }));
    return m;
  } catch { return {}; }
}
function inj(m, player, team, opp) {
  const bad = (x) => /out|injured|doubtful/i.test(x.status), list = (k) => m[norm(k)] || [];
  const self = list(team).find((x) => x.name === norm(player)), fmt = (x) => `${x.disp} (${x.status})`;
  return { self: self ? self.status + (self.detail ? ': ' + self.detail : '') : null, team: list(team).filter(bad).slice(0, 4).map(fmt), opp: list(opp).filter(bad).slice(0, 4).map(fmt) };
}

// Warn when a market had lines but nothing usable came out (usually a missing stat field)
function warn(sport, raw, out, errors) {
  for (const k of Object.keys(MARKETS[sport].list)) {
    if (raw.some((r) => r.mkey === k) && !out.some((p) => p.id.endsWith('-' + k))) errors.push(`${sport}: ${k} had lines but no usable game data (stat field may be missing)`);
  }
  return out;
}

function assemble(sport, r, games, team, opp, home, injMap, teamFull, oppFull) {
  const cnt = {}; r.books.forEach((b) => (cnt[b.line] = (cnt[b.line] || 0) + 1));
  const line = +Object.entries(cnt).sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const books = r.books.slice().sort((a, b) => b.odds - a.odds);
  return { id: `${sport}-${norm(r.player).replace(/ /g, '_')}-${r.mkey}`, sport, player: r.player, team, opp, home, start: r.event.commence_time,
    market: MARKETS[sport].list[r.mkey][0], line, odds: books.find((b) => b.line === line).odds, books, games, injury: inj(injMap, r.player, teamFull, oppFull) };
}

// Stats missing from the NHL game log are read from each game's boxscore instead
const BOX = new Set(['blockedShots']);
const boxes = new Map();
async function boxStat(gid, pid, stat) {
  if (Date.now() - START > budgetMs()) return null;
  if (!boxes.has(gid)) boxes.set(gid, getJson(`${NHLAPI}/gamecenter/${gid}/boxscore`).catch(() => null));
  const b = await boxes.get(gid);
  if (!b) return null;
  const ps = ['homeTeam', 'awayTeam'].flatMap((t) => ['forwards', 'defense'].flatMap((k) => b.playerByGameStats?.[t]?.[k] || []));
  return ps.find((p) => p.playerId === pid)?.[stat] ?? null;
}

async function nhl(errors) {
  const cfg = MARKETS.nhl, raw = await oddsProps(cfg, 'nhl');
  if (!raw.length) return [];
  const st = await getJson(`${NHLAPI}/standings/now`);
  const teams = st.standings.map((t) => ({ abbr: t.teamAbbrev.default, common: t.teamCommonName.default }));
  const abbr = (full) => teams.find((t) => full.endsWith(t.common))?.abbr;
  const need = new Set(); raw.forEach((r) => [r.event.home_team, r.event.away_team].forEach((t) => need.add(abbr(t)))); need.delete(undefined);
  const rosters = {};
  await pool([...need], 6, async (a) => { const d = await getJson(`${NHLAPI}/roster/${a}/current`); rosters[a] = new Map([...d.forwards, ...d.defensemen, ...(d.goalies || [])].map((p) => [norm(`${p.firstName.default} ${p.lastName.default}`), p.id])); });
  const injMap = await injuries(cfg.espn);
  const now = new Date(), y = now.getFullYear(), s = now.getMonth() >= 8 ? y : y - 1, seasons = [`${s}${s + 1}`, `${s - 1}${s}`];
  const cache = new Map();
  const logs = (id) => { if (!cache.has(id)) cache.set(id, (async () => {
    let all = [];
    for (const se of seasons) {
      const k = `${id}:${se}`, c = LOGS[k], stale = se === seasons[0] && (!c || Date.now() - c.t > 12 * 36e5);
      let rows = c && !stale ? c.rows : null;
      if (!rows && Date.now() - START > budgetMs()) { DEBUG.timeBudgetHit = true; rows = c ? c.rows : []; }
      if (!rows) {
        try {
          rows = ((await getJson(`${NHLAPI}/player/${id}/game-log/${se}/2`)).gameLog || [])
            .filter((x) => String(x.gameId).slice(4, 6) === '02')
            .sort((a, b) => b.gameDate.localeCompare(a.gameDate)).slice(0, 25)
            .map((x) => ({ gameId: x.gameId, gameDate: x.gameDate, opponentAbbrev: x.opponentAbbrev, homeRoadFlag: x.homeRoadFlag, goals: x.goals, assists: x.assists, points: x.points, shots: x.shots, shotsAgainst: x.shotsAgainst, goalsAgainst: x.goalsAgainst, gamesStarted: x.gamesStarted }));
          LOGS[k] = { t: Date.now(), rows };
          if (++FETCHED % 25 === 0) console.log(`nhl: fetched ${FETCHED} game logs, ${Math.round((Date.now() - START) / 1000)}s elapsed`);
        } catch (e) { const L = (DEBUG.logErrors = DEBUG.logErrors || []); if (L.length < 10) L.push(`${id} ${se}: ${e.message}`); rows = c ? c.rows : []; }
      }
      all = all.concat(rows);
      if (all.length >= 20) break;
    }
    return all.sort((a, b) => b.gameDate.localeCompare(a.gameDate));
  })()); return cache.get(id); };
  const drops = { noRoster: [], shortLog: [] };
  const findId = (m, n) => {
    if (!m) return null;
    if (m.has(n)) return m.get(n);
    const [f, ...rest] = n.split(' '), l = rest.join(' ');
    const c = [...m].filter(([rn]) => { const [rf, ...rr] = rn.split(' '); return rr.join(' ') === l && rf[0] === f[0]; });
    if (c.length === 1) return c[0][1];
    // last resort: same first initial and a last name one typo away (e.g. Trochek vs Trocheck)
    const near = [...m].filter(([rn]) => { const [rf, ...rr] = rn.split(' '); return rf[0] === f[0] && lev(rr.join(' '), l) <= 1; });
    return near.length === 1 ? near[0][1] : null;
  };
  const res = await pool(raw, 8, async (r) => {
    const e = r.event, h = abbr(e.home_team), a = abbr(e.away_team), n = norm(r.player);
    const hid = findId(rosters[h], n), aid = findId(rosters[a], n), side = hid ? 'home' : aid ? 'away' : null;
    if (!side) { drops.noRoster.push(r.player); return null; }
    const stat = cfg.list[r.mkey][1];
    const pid = side === 'home' ? hid : aid;
    const allRows = await logs(pid);
    const rowsL = (stat === 'saves' ? allRows.filter((x) => x.gamesStarted === undefined || x.gamesStarted === 1) : allRows).slice(0, 20), g = [];
    for (const x of rowsL) {
      const v = BOX.has(stat) ? await boxStat(x.gameId, pid, stat) : stat === 'saves' ? (x.shotsAgainst != null && x.goalsAgainst != null ? x.shotsAgainst - x.goalsAgainst : null) : x[stat];
      if (v != null) g.push({ v, opp: x.opponentAbbrev, home: x.homeRoadFlag === 'H', date: md(x.gameDate) });
    }
    if (g.length < 5) { drops.shortLog.push(r.player); return null; }
    return side === 'home' ? assemble('nhl', r, g, h, a, true, injMap, e.home_team, e.away_team) : assemble('nhl', r, g, a, h, false, injMap, e.away_team, e.home_team);
  });
  DEBUG.nhlDropped = { noRoster: drops.noRoster.slice(0, 15), shortLog: drops.shortLog.slice(0, 15) };
  return warn('nhl', raw, res.filter(Boolean), errors);
}

async function mlb(errors) {
  const cfg = MARKETS.mlb, raw = await oddsProps(cfg, 'mlb');
  if (!raw.length) return [];
  const tl = (await getJson(`${MLBAPI}/teams?sportId=1`)).teams;
  const byId = new Map(tl.map((t) => [t.id, t]));
  const findTeam = (full) => { const n = norm(full); return tl.find((t) => norm(t.name) === n) || tl.find((t) => n.endsWith(norm(t.teamName))); };
  const need = new Map(); raw.forEach((r) => [r.event.home_team, r.event.away_team].forEach((t) => { const x = findTeam(t); if (x) need.set(x.id, x); }));
  const rosters = {};
  await pool([...need.keys()], 6, async (id) => { const d = await getJson(`${MLBAPI}/teams/${id}/roster?rosterType=active`); rosters[id] = new Map((d.roster || []).map((p) => [norm(p.person.fullName), p.person.id])); });
  const injMap = await injuries(cfg.espn);
  const now = new Date(), y = now.getMonth() >= 1 ? now.getFullYear() : now.getFullYear() - 1, seasons = [y, y - 1];
  const cache = new Map();
  const logs = (id, group) => { const ck = `${id}:${group}`; if (!cache.has(ck)) cache.set(ck, (async () => {
    let all = [];
    for (const se of seasons) {
      const k = `mlb:${id}:${group}:${se}`, c = LOGS[k], stale = se === seasons[0] && (!c || Date.now() - c.t > 12 * 36e5);
      let rows = c && !stale ? c.rows : null;
      if (!rows && Date.now() - START > budgetMs()) { DEBUG.timeBudgetHit = true; rows = c ? c.rows : []; }
      if (!rows) {
        try {
          const d = await getJson(`${MLBAPI}/people/${id}/stats?stats=gameLog&group=${group}&season=${se}&gameType=R`);
          rows = ((d.stats?.[0]?.splits) || []).map((x) => ({ date: x.date, home: x.isHome, oppId: x.opponent?.id, st: x.stat || {} }))
            .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25)
            .map((x) => ({ date: x.date, home: x.home, oppId: x.oppId, hits: x.st.hits, totalBases: x.st.totalBases, homeRuns: x.st.homeRuns, rbi: x.st.rbi, runs: x.st.runs, strikeOuts: x.st.strikeOuts, ip: x.st.inningsPitched, gs: x.st.gamesStarted }));
          LOGS[k] = { t: Date.now(), rows };
          if (++FETCHED % 25 === 0) console.log(`mlb: fetched ${FETCHED} game logs, ${Math.round((Date.now() - START) / 1000)}s elapsed`);
        } catch (e) { const L = (DEBUG.logErrors = DEBUG.logErrors || []); if (L.length < 10) L.push(`mlb ${id} ${se}: ${e.message}`); rows = c ? c.rows : []; }
      }
      all = all.concat(rows);
      if (all.length >= 20) break;
    }
    return all.sort((a, b) => b.date.localeCompare(a.date));
  })()); return cache.get(ck); };
  const outsOf = (ip) => { if (ip == null) return null; const [w, f = '0'] = String(ip).split('.'); return Number(w) * 3 + Number(f); };
  const drops = { noRoster: [], shortLog: [] };
  const findId = (m, n) => {
    if (!m) return null;
    if (m.has(n)) return m.get(n);
    const [f, ...rest] = n.split(' '), l = rest.join(' ');
    const c = [...m].filter(([rn]) => { const [rf, ...rr] = rn.split(' '); return rr.join(' ') === l && rf[0] === f[0]; });
    if (c.length === 1) return c[0][1];
    const near = [...m].filter(([rn]) => { const [rf, ...rr] = rn.split(' '); return rf[0] === f[0] && lev(rr.join(' '), l) <= 1; });
    return near.length === 1 ? near[0][1] : null;
  };
  const res = await pool(raw, 8, async (r) => {
    const e = r.event, ht = findTeam(e.home_team), at = findTeam(e.away_team), n = norm(r.player);
    if (!ht || !at) { drops.noRoster.push(`${r.player} (team?)`); return null; }
    const hid = findId(rosters[ht.id], n), aid = findId(rosters[at.id], n), side = hid ? 'home' : aid ? 'away' : null;
    if (!side) { drops.noRoster.push(r.player); return null; }
    const [, stat, group] = cfg.list[r.mkey], pid = side === 'home' ? hid : aid;
    let rowsL = await logs(pid, group);
    if (group === 'pitching') rowsL = rowsL.filter((x) => x.gs === undefined || x.gs === 1);
    const g = [];
    for (const x of rowsL.slice(0, 20)) {
      const v = stat === 'hrr' ? (x.hits == null || x.runs == null || x.rbi == null ? null : x.hits + x.runs + x.rbi) : stat === 'outs' ? outsOf(x.ip) : x[stat];
      if (v != null) g.push({ v, opp: byId.get(x.oppId)?.abbreviation || '?', home: !!x.home, date: md(x.date) });
    }
    if (g.length < 5) { drops.shortLog.push(r.player); return null; }
    const mine = side === 'home' ? ht : at, theirs = side === 'home' ? at : ht;
    return assemble('mlb', r, g, mine.abbreviation, theirs.abbreviation, side === 'home', injMap, mine.name, theirs.name);
  });
  DEBUG.mlbDropped = { noRoster: drops.noRoster.slice(0, 15), shortLog: drops.shortLog.slice(0, 15) };
  return warn('mlb', raw, res.filter(Boolean), errors);
}

async function nfl(errors) {
  const cfg = MARKETS.nfl, raw = await oddsProps(cfg, 'nfl');
  if (!raw.length) return [];
  const now = new Date(), y = now.getFullYear(), s = now.getMonth() >= 8 ? y : y - 1, rows = [];
  for (const yr of [s, s - 1]) {
    let ok = false;
    for (const u of [`stats_player/stats_player_week_${yr}.csv`, `player_stats/player_stats_${yr}.csv`]) {
      try { rows.push(...csv(await getText(`https://github.com/nflverse/nflverse-data/releases/download/${u}`))); ok = true; break; } catch {}
    }
    if (!ok) errors.push(`nfl: could not load ${yr} player stats`);
  }
  const sched = {};
  try { for (const g of csv(await getText('https://raw.githubusercontent.com/nflverse/nfldata/master/data/games.csv'))) { sched[`${g.season}|${g.week}|${g.home_team}`] = { home: true, date: g.gameday }; sched[`${g.season}|${g.week}|${g.away_team}`] = { home: false, date: g.gameday }; } }
  catch { errors.push('nfl: schedule file unavailable, home/away splits disabled'); }
  const by = new Map();
  for (const r of rows) { if (r.season_type && r.season_type !== 'REG') continue; const k = norm(r.player_display_name); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  for (const v of by.values()) v.sort((a, b) => b.season - a.season || b.week - a.week);
  const injMap = await injuries(cfg.espn);
  const drops = { noStats: [], teamMismatch: [], shortLog: [] };
  const nflFind = (n, h, a) => {
    if (by.has(n)) return by.get(n);
    const [f, ...rest] = n.split(' '), l = rest.join(' ');
    const c = [...by].filter(([k, v]) => { const [kf, ...kr] = k.split(' '), tm = ab(v[0].team || v[0].recent_team); return (tm === h || tm === a) && kf[0] === f[0] && lev(kr.join(' '), l) <= 1; });
    return c.length === 1 ? c[0][1] : null;
  };
  const out = raw.map((r) => {
    if (/D\/ST/i.test(r.player)) return null; // team defences are not players
    const e = r.event, h = ab(NFL[e.home_team]), a = ab(NFL[e.away_team]), list = nflFind(norm(r.player), h, a);
    if (!list || !h || !a) { drops.noStats.push(r.player); return null; }
    const t = ab(list[0].team || list[0].recent_team), stat = cfg.list[r.mkey][1];
    if (t !== h && t !== a) { drops.teamMismatch.push(r.player); return null; }
    const tdv = (x) => (x.rushing_tds === undefined || x.receiving_tds === undefined ? null : (+x.rushing_tds || 0) + (+x.receiving_tds || 0));
    const g = list.slice(0, 20).map((x) => { const i = sched[`${x.season}|${x.week}|${x.team || x.recent_team}`]; return { v: stat === 'tds' ? tdv(x) : x[stat] === undefined || x[stat] === '' ? null : +x[stat] || 0, opp: x.opponent_team, home: i ? i.home : null, date: i ? md(i.date) : `W${x.week}` }; });
    if (g.length < 5 || g.some((x) => x.v === null)) { drops.shortLog.push(r.player); return null; }
    const home = t === h;
    return assemble('nfl', r, g, t, home ? a : h, home, injMap, home ? e.home_team : e.away_team, home ? e.away_team : e.home_team);
  }).filter(Boolean);
  DEBUG.nflDropped = { noStats: [...new Set(drops.noStats)].slice(0, 15), teamMismatch: [...new Set(drops.teamMismatch)].slice(0, 15), shortLog: [...new Set(drops.shortLog)].slice(0, 15) };
  return warn('nfl', raw, out, errors);
}

export async function build() {
  START = Date.now();
  const out = { updated: new Date().toISOString(), props: [], errors: [], debug: DEBUG };
  for (const [sport, fn] of [['nhl', nhl], ['nfl', nfl], ['mlb', mlb]].filter(([sp]) => (process.env.SPORTS || 'nhl,nfl,mlb').includes(sp))) {
    try { out.props.push(...(await fn(out.errors))); } catch (e) { out.errors.push(`${sport}: ${e.message}`); }
  }
  return out;
}
