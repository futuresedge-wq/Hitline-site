import { writeFileSync } from 'node:fs';
import { build, loadCache, saveCache } from './build.mjs';
import { loadPrev, update, saveHistory } from './history.mjs';

const CACHE = '.cache/nhl-logs.json';
loadCache(CACHE);

const data = await build();
saveCache(CACHE);
if (!data.props.length) console.error('No props built.', JSON.stringify(data.errors), JSON.stringify(data.debug));
writeFileSync('public/props.json', JSON.stringify(data));
writeFileSync('public/debug.json', JSON.stringify({ updated: data.updated, errors: data.errors, debug: data.debug }, null, 2));
console.log(`Built ${data.props.length} props`);

// Track record: log today's top picks and grade finished games. A failure here must never stop the deploy.
try {
  const prev = await loadPrev(process.env.HISTORY_URL, '.cache/history.json');
  const hist = update(prev, data.props, new Date());
  saveHistory(hist, 'public/history.json', '.cache/history.json');
  console.log(`History: ${hist.picks.length} picks (+${hist._added} logged, ${hist._graded} graded, ${hist._voided} voided)`);
} catch (e) {
  console.error('History step failed:', e.message);
}
