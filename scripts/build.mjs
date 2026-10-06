// Builds the props dataset: lines (The Odds API) + game logs (NHL API, nflverse) + injuries (ESPN, unofficial).
const ODDS = 'https://api.the-odds-api.com/v4';
const NHLAPI = 'https://api-web.nhle.com/v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports';
const MARKETS = {
  nhl: { key: 'icehockey_nhl', espn: 'hockey/nhl', list: {
    player_shots_on_goal: ['Shots on goal', 'shots'], player_points: ['Points', 'points'], player_assists: ['Assists', 'assists'],
    player_goals: ['Goals', 'goals'], player_power_play_points: ['Power play points', 'powerPlayPoints'], player_blocked_shots: ['Blocked shots', 'blockedShots'] } },
  nfl: { key: 'americanfootball_nfl', espn: 'football/nfl', list: {
    player_rush_yds: ['Rushing yards', 'rushing_yards'], player_reception_yds: ['Receiving yards', 'receiving_yards'], player_receptions: ['Receptions', 'receptions'],
    player_pass_yds: ['Passing yards', 'passing_yards'], player_rush_attempts: ['Rush attempts', 'carries'] } },
};
const NFL = { 'Arizona Cardinals':'ARI','Atlanta Falcons':'ATL','Baltimore Ravens':'BAL','Buffalo Bills':'BUF','Carolina Panthers':'CAR','Chicago Bears':'CHI','Cincinnati Bengals':'CIN','Cleveland Browns':'CLE','Dallas Cowboys':'DAL','Denver Broncos':'DEN','Detroit Lions':'DET','Green Bay Packers':'GB','Houston Texans':'HOU','Indianapolis Colts':'IND','Jacksonville Jaguars':'JAX','Kansas City Chiefs':'KC','Las Vegas Raiders':'LV','Los Angeles Chargers':'LAC','Los Angeles Rams':'LA','Miami Dolphins':'MIA','Minnesota Vikings':'MIN','New England Patriots':'NE','New Orleans Saints':'NO','New York Giants':'NYG','New York Jets':'NYJ','Philadelphia Eagles':'PHI','Pittsburgh Steelers':'PIT','San Francisco 49ers':'SF','Seattle Seahawks':'SEA','Tampa Bay Buccaneers':'TB','Tennessee Titans':'TEN','Washington Commanders':'WAS' };
const DEBUG = {}; // shown in /api/props to help diagnose missing games
const ab = (t) => (t === 'LAR' ? 'LA' : t);

const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ').trim();
const md = (d) => { const [, m, x] = d.split('-'); return `${+m}/${+x}`; };
const sleep = (ms) => new Promise((z) => setTimeout(z, ms));
// Retries rate-limited (429) requests, honouring Retry-After
const getText = async (url) => {
  for (let i = 0; ; i++) {
    const r = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (r.status === 429 && i < 3) { await sleep(Math.min(Number(r.headers.get('retry-after')) || 2 * (i + 1), 20) * 1000); continue; }
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
  const regions = process.env.ODDS_REGIONS || 'us', horizon = Number(process.env.HORIZON_HOURS || 36);
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
      if (x.name !== 'Over' || !cfg.list[m.key]) continue;
      const pname = String(x.description || '').replace(/\s*\([^)]*\)\s*$/, '').trim(); // some feeds append "(TEAM)"
      const k = `${norm(pname)}|${m.key}`;
      if (!map.has(k)) map.set(k, { player: pname, mkey: m.key, event: r.e, books: [] });
      map.get(k).books.push({ book: b.title, line: x.point, odds: x.price });
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
  await pool([...need], 6, async (a) => { const d = await getJson(`${NHLAPI}/roster/${a}/current`); rosters[a] = new Map([...d.forwards, ...d.defensemen].map((p) => [norm(`${p.firstName.default} ${p.lastName.default}`), p.id])); });
  const injMap = await injuries(cfg.espn);
  const now = new Date(), y = now.getFullYear(), s = now.getMonth() >= 8 ? y : y - 1, seasons = [`${s}${s + 1}`, `${s - 1}${s}`];
  const cache = new Map();
  const logs = (id) => { if (!cache.has(id)) cache.set(id, (async () => { let all = []; for (const se of seasons) { try { all = all.concat(((await getJson(`${NHLAPI}/player/${id}/game-log/${se}/2`)).gameLog || []).filter((x) => String(x.gameId).slice(4, 6) === '02')); } catch {} if (all.length >= 20) break; } return all.sort((a, b) => b.gameDate.localeCompare(a.gameDate)); })()); return cache.get(id); };
  const drops = { noRoster: [], shortLog: [] };
  const res = await pool(raw, 8, async (r) => {
    const e = r.event, h = abbr(e.home_team), a = abbr(e.away_team), n = norm(r.player);
    const side = rosters[h]?.has(n) ? 'home' : rosters[a]?.has(n) ? 'away' : null;
    if (!side) { drops.noRoster.push(r.player); return null; }
    const stat = cfg.list[r.mkey][1];
    const pid = rosters[side === 'home' ? h : a].get(n);
    const rowsL = (await logs(pid)).slice(0, 20), g = [];
    for (const x of rowsL) {
      const v = BOX.has(stat) ? await boxStat(x.gameId, pid, stat) : x[stat];
      if (v != null) g.push({ v, opp: x.opponentAbbrev, home: x.homeRoadFlag === 'H', date: md(x.gameDate) });
    }
    if (g.length < 5) { drops.shortLog.push(r.player); return null; }
    return side === 'home' ? assemble('nhl', r, g, h, a, true, injMap, e.home_team, e.away_team) : assemble('nhl', r, g, a, h, false, injMap, e.away_team, e.home_team);
  });
  DEBUG.nhlDropped = { noRoster: drops.noRoster.slice(0, 15), shortLog: drops.shortLog.slice(0, 15) };
  return warn('nhl', raw, res.filter(Boolean), errors);
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
  const out = raw.map((r) => {
    const e = r.event, h = ab(NFL[e.home_team]), a = ab(NFL[e.away_team]), list = by.get(norm(r.player));
    if (!list || !h || !a) return null;
    const t = ab(list[0].team || list[0].recent_team), stat = cfg.list[r.mkey][1];
    if (t !== h && t !== a) return null;
    const g = list.slice(0, 20).map((x) => { const i = sched[`${x.season}|${x.week}|${x.team || x.recent_team}`]; return { v: x[stat] === undefined || x[stat] === '' ? null : +x[stat] || 0, opp: x.opponent_team, home: i ? i.home : null, date: i ? md(i.date) : `W${x.week}` }; });
    if (g.length < 5 || g.some((x) => x.v === null)) return null;
    const home = t === h;
    return assemble('nfl', r, g, t, home ? a : h, home, injMap, home ? e.home_team : e.away_team, home ? e.away_team : e.home_team);
  }).filter(Boolean);
  return warn('nfl', raw, out, errors);
}

export async function build() {
  const out = { updated: new Date().toISOString(), props: [], errors: [], debug: DEBUG };
  for (const [sport, fn] of [['nhl', nhl], ['nfl', nfl]].filter(([sp]) => (process.env.SPORTS || 'nhl,nfl').includes(sp))) {
    try { out.props.push(...(await fn(out.errors))); } catch (e) { out.errors.push(`${sport}: ${e.message}`); }
  }
  return out;
}
