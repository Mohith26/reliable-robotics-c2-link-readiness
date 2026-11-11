// Seeded synthetic campaign: node scripts/generate.mjs  ->  data/campaign.json
import fs from 'node:fs';
import path from 'node:path';
import { simulateCampaign } from '../core/simulate.js';
const here = path.dirname(new URL(import.meta.url).pathname);
const c = simulateCampaign({ seed: 20250806 });
fs.writeFileSync(path.join(here, '..', 'data', 'campaign.json'), JSON.stringify(c));
console.log('days', c.days.length, 'seconds', c.days.reduce((a, d) => a + d.samples.length, 0));
