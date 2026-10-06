import { writeFileSync } from 'node:fs';
import { build } from './build.mjs';

const data = await build();
if (!data.props.length) console.error('No props built.', JSON.stringify(data.errors), JSON.stringify(data.debug));
writeFileSync('public/props.json', JSON.stringify(data));
writeFileSync('public/debug.json', JSON.stringify({ updated: data.updated, errors: data.errors, debug: data.debug }, null, 2));
console.log(`Built ${data.props.length} props`);
