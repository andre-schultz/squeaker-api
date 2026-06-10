// Diagnostic: of ALL 7+ unanswered runs, how many actually score (flip/tie/
// go-ahead/close) vs. score nothing (base 0 — e.g. a run that only pads a lead)?
// Mirrors the production run-walk + classifyRun in timeline.js, and validates
// the scoring-run count against the production analyzeBasketballRuns signals.
//
//   node scripts/analyze_run_classification.mjs
// Writes scripts/run_classification.json

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { SPORTS } from '../src/config.js';
import { analyzeBasketballRuns } from '../src/services/timeline.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const THRESHOLD = Number(process.argv[2]) || 7; // run-qualifying minimum (default 7)
const BB_CLOSE = 5, CONCURRENCY = 8;

const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'scores_basketball.json'), 'utf8'));

async function fetchSummary(sport, id) {
  const cfg = SPORTS[sport];
  const url = `${SUMMARY_BASE}/${cfg.espnSport}/${cfg.espnLeague}/summary?event=${id}`;
  for (let a = 0; a < 3; a++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch {}
    await new Promise(r => setTimeout(r, 300 * (a + 1)));
  }
  return null;
}

const leader = (h, a) => (h > a ? 'home' : a > h ? 'away' : 'tied');
// Returns the category label for a run, mirroring classifyRun().
function classify(bH, bA, pH, pA) {
  const before = leader(bH, bA), after = leader(pH, pA), margin = Math.abs(pH - pA);
  if (before !== 'tied' && after !== 'tied' && before !== after) return 'flip';
  if (margin === 0) return 'tie';
  if (before === 'tied' && after !== 'tied') return 'goahead';
  if (margin <= BB_CLOSE) return 'close';
  return 'none';
}

// Walk scoring plays, emit every run of THRESHOLD+ unanswered points with its
// category and size (mirror of analyzeBasketballRuns' run detection).
function allRuns(data) {
  const scoring = (data?.plays || []).filter(p => p?.scoringPlay &&
    typeof p.homeScore === 'number' && typeof p.awayScore === 'number');
  const runs = [];
  let pH = 0, pA = 0, runner = null, rp = 0, bH = 0, bA = 0;
  const flush = (peakH, peakA) => {
    if (runner && rp >= THRESHOLD) runs.push({ size: rp, cat: classify(bH, bA, peakH, peakA) });
  };
  for (const p of scoring) {
    const dH = p.homeScore - pH, dA = p.awayScore - pA;
    const s = dH > 0 ? 'home' : dA > 0 ? 'away' : null;
    if (s === null) { pH = p.homeScore; pA = p.awayScore; continue; }
    const pts = s === 'home' ? dH : dA;
    if (s === runner) rp += pts;
    else { flush(pH, pA); runner = s; rp = pts; bH = pH; bA = pA; }
    pH = p.homeScore; pA = p.awayScore;
  }
  flush(pH, pA);
  return runs;
}

async function pool(items, worker, n) {
  let idx = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i]);
      if ((i + 1) % 200 === 0) console.log(`  ...${i + 1}/${items.length}`);
    }
  }));
}

const CATS = ['flip', 'tie', 'goahead', 'close', 'none'];
const agg = {}; // league -> { flip, tie, goahead, close, none, noneSizes:[] }
for (const lg of ['nba', 'wnba', 'cbb', 'wcbb']) agg[lg] = { flip: 0, tie: 0, goahead: 0, close: 0, none: 0, noneSizes: [] };
let mismatches = 0;

(async () => {
  console.log(`Classifying every ${THRESHOLD}+ run across ${saved.length} games...`);
  await pool(saved, async (g) => {
    const data = await fetchSummary(g.sport, g.id);
    if (!data) return;
    const runs = allRuns(data);
    const a = agg[g.sport];
    for (const r of runs) { a[r.cat]++; if (r.cat === 'none') a.noneSizes.push(r.size); }
    // Validate: scoring runs (cat != none) should equal production signal count.
    const teams = data.boxscore?.teams || [];
    const prod = analyzeBasketballRuns(data.plays,
      teams.find(t => t.homeAway === 'home')?.team?.id,
      teams.find(t => t.homeAway === 'away')?.team?.id, data.format);
    const scoring = runs.filter(r => r.cat !== 'none').length;
    if (scoring !== prod.signals.length) mismatches++;
  }, CONCURRENCY);

  fs.writeFileSync(path.join(__dirname, `run_classification_t${THRESHOLD}.json`), JSON.stringify(agg));
  console.log(`(threshold=${THRESHOLD}) Validation mismatches vs production: ${mismatches}\n`);

  console.log('league       total  scored   none  %none  |  flip   tie  goahd  close');
  for (const lg of ['nba', 'wnba', 'cbb', 'wcbb']) {
    const a = agg[lg];
    const total = CATS.reduce((s, c) => s + a[c], 0);
    const scored = total - a.none;
    const pctNone = total ? (100 * a.none / total).toFixed(0) : '0';
    console.log(`${lg.toUpperCase().padEnd(10)} ${String(total).padStart(6)} ${String(scored).padStart(7)} ${String(a.none).padStart(6)} ${(pctNone+'%').padStart(6)}  | ${String(a.flip).padStart(5)} ${String(a.tie).padStart(5)} ${String(a.goahead).padStart(6)} ${String(a.close).padStart(6)}`);
  }
})();
