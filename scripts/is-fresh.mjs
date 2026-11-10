// Has GLERL posted a forecast the public page doesn't have yet?
// The hourly workflow runs this after `npm run data`. It compares the snapshot just pulled
// with the one the live page is serving and writes changed=true|false for the next steps,
// so the site is only rebuilt when there is something new to show.
import fs from 'node:fs';

const station = process.argv[2] ?? '45198';
const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '/').split('/');
const liveUrl = process.env.LIVE_URL ?? `https://${owner}.github.io/${repo}/data/${station}.json`;

const essence = d => JSON.stringify([d?.source?.initialized, d?.time, d?.hs, d?.wind]);

async function changed() {
  if (process.env.GITHUB_EVENT_NAME && process.env.GITHUB_EVENT_NAME !== 'schedule') return 'a push or manual run always deploys';
  const mine = JSON.parse(fs.readFileSync(new URL(`../public/data/${station}.json`, import.meta.url), 'utf8'));
  let live;
  try {
    const r = await fetch(liveUrl, {cache: 'no-store'});
    if (!r.ok) return `the live page answered ${r.status}`;
    live = await r.json();
  } catch (e) {
    return `could not read the live page (${e.message})`;
  }
  if (essence(mine) === essence(live)) {
    console.log(`No new forecast: the page already shows the run initialised ${live.source?.initialized}.`);
    return '';
  }
  if (Date.parse(mine.source?.initialized) < Date.parse(live.source?.initialized)) {
    // the fetch failed and left the older committed snapshot: never roll the page back
    console.log(`Keeping the page: it shows ${live.source?.initialized}, newer than the ${mine.source?.initialized} run here.`);
    return '';
  }
  return `new run ${mine.source?.initialized} (the page shows ${live.source?.initialized})`;
}

const why = await changed();
if (why) console.log(`Deploying: ${why}.`);
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${why ? 'true' : 'false'}\n`);
