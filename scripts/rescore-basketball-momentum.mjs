// Re-score the saved basketball games (scores_basketball.json) with the CURRENT
// algorithm, capturing the full component breakdown and the momentum sub-
// components. Pulls fresh play-by-play from ESPN /summary (the saved file only
// had boxscore stats, no plays) and runs every game through the production
// scoring modules so the output matches what the live API would produce.
//
//   node scripts/rescore-basketball-momentum.mjs
//
// Writes scripts/scores_basketball_rescored.json (one row per game).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { SPORTS } from '../src/config.js';
import { parseSummary } from '../src/services/stats.js';
import { computeStatsBonus } from '../src/services/statsBonus.js';
import {
  analyzeMomentum,
  analyzeComeback,
  analyzeBasketballRuns,
} from '../src/services/timeline.js';
import { calcExcitementBreakdown } from '../src/services/algorithm.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SUMMARY_BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CONCURRENCY = 8;

const saved = JSON.parse(fs.readFileSync(path.join(__dirname, 'scores_basketball.json'), 'utf8'));
// Carry pre-game upset over from the prior run keyed by id — the upset signal
// wasn't touched by these changes, and recomputing it would need a full WP
// timeline fetch per game.
const upsetById = new Map(saved.map(g => [g.id, g.upsetBonus ?? 0]));

async function fetchSummary(sport, id) {
  const cfg = SPORTS[sport];
  const url = `${SUMMARY_BASE}/${cfg.espnSport}/${cfg.espnLeague}/summary?event=${id}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
      if (res.ok) return await res.json();
      if (res.status === 404) return null;
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
  }
  return null;
}

// Seconds remaining from an ESPN clock object ("10:42" -> 642, "6.8" -> 6.8).
function clockSeconds(clock) {
  const s = clock?.displayValue;
  if (!s) return 0;
  if (s.includes(':')) { const [m, sec] = s.split(':').map(Number); return (m || 0) * 60 + (sec || 0); }
  const n = parseFloat(s); return isNaN(n) ? 0 : n;
}

// Build a fine-grained score timeline (one snapshot per scoring play) from the
// play-by-play, with per-play progress derived from period + clock. This stands
// in for the live polled timeline and is strictly more accurate.
function buildTimeline(data) {
  const reg = data?.format?.regulation;
  const periods = reg?.periods || 4;
  const periodSecs = reg?.clock || 720;
  const total = periods * periodSecs;
  const progOf = (p) => {
    const per = p?.period?.number || 1;
    const rem = clockSeconds(p?.clock);
    const elapsed = (Math.min(per, periods) - 1) * periodSecs + (periodSecs - rem);
    return Math.max(0, Math.min(1, elapsed / total));
  };
  const tl = [{ t: 0, home: 0, away: 0, progress: 0 }];
  const scoring = (data?.plays || []).filter(p => p?.scoringPlay &&
    typeof p.homeScore === 'number' && typeof p.awayScore === 'number');
  let i = 1;
  for (const p of scoring) {
    tl.push({ t: i++, home: p.homeScore, away: p.awayScore, progress: progOf(p) });
  }
  return tl;
}

// Run-bonus configs to sweep. baseline = current production behavior.
const VARIANTS = [
  { name: 'base5',    threshold: 7,  baseScale: 0.5 }, // Solution A: base 10 -> 5
  { name: 'thresh10', threshold: 10, baseScale: 1.0 }, // Solution B: 7 -> 10 unanswered
  { name: 'combo',    threshold: 9,  baseScale: 0.5 }, // Combined: base 10->5 AND 7->9
];

function scoreGame(g, data, runOpts) {
  const cfg = SPORTS[g.sport];
  const parsed = parseSummary(data, cfg.espnSport);
  if (!parsed) return null;

  const teams = data.boxscore.teams;
  const homeId = teams.find(t => t.homeAway === 'home')?.team?.id;
  const awayId = teams.find(t => t.homeAway === 'away')?.team?.id;

  const totalScore = (g.awayScore ?? 0) + (g.homeScore ?? 0);
  const margin = g.margin;
  const isOT = !!g.isOT;

  const runs = analyzeBasketballRuns(data.plays, homeId, awayId, data.format, runOpts)
               || { runBonus: 0, signals: [] };
  const timeline = buildTimeline(data);

  const mom = analyzeMomentum(timeline, { sport: g.sport }, {
    done: true, progress: 1,
    runBonus: runs.runBonus, runSignals: runs.signals,
  });
  // Basketball is excluded from the comeback component (handled by surge/runs),
  // so this is 0 here — computed for completeness.
  const cb = analyzeComeback(timeline, cfg, { done: true, progress: 1, sportKey: g.sport });

  const stats = computeStatsBonus(g.sport, parsed, totalScore) || { score: 0, breakdown: {} };
  const upset = upsetById.get(g.id) ?? 0;

  // Basketball has no empty-net goals, so the closeness margin is the real margin.
  const bd = calcExcitementBreakdown(margin, isOT, cb.comebackBonus, cfg,
    mom.momentumBonus, 1.0, upset, stats.score);

  return {
    id: g.id, sport: g.sport, date: g.date,
    away: g.away, home: g.home, awayScore: g.awayScore, homeScore: g.homeScore,
    margin, isOT,
    total: bd.final,
    closeness: bd.closeness,
    ot: bd.ot,
    comeback: bd.comeback,
    momentum: bd.momentum,
    upset: bd.upset,
    stats: bd.stats,
    momentumBreakdown: {
      surge: round2(mom.breakdown.surge ?? 0),
      runs:  round2(mom.breakdown.runs ?? 0),
      close: round2(mom.breakdown.close ?? 0),
    },
    nRuns: runs.signals.length,
    // Per-run sizes (unanswered points), parsed from the "10-0 run" signal text.
    runSizes: runs.signals.map(s => parseInt(s, 10)).filter(n => !isNaN(n)),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

async function pool(items, worker, n) {
  const out = new Array(items.length);
  let idx = 0;
  async function run() {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
      if ((i + 1) % 100 === 0) console.log(`  ...${i + 1}/${items.length}`);
    }
  }
  await Promise.all(Array.from({ length: n }, run));
  return out;
}

(async () => {
  console.log(`Re-scoring ${saved.length} games × ${VARIANTS.length} variants ` +
              `(${VARIANTS.map(v => v.name).join(', ')}), concurrency ${CONCURRENCY}...`);

  // Fetch each summary ONCE, score under every variant.
  const perVariant = Object.fromEntries(VARIANTS.map(v => [v.name, []]));
  let failed = 0;
  await pool(saved, async (g) => {
    const data = await fetchSummary(g.sport, g.id);
    if (!data) { failed++; return; }
    for (const v of VARIANTS) {
      try {
        const r = scoreGame(g, data, { threshold: v.threshold, baseScale: v.baseScale });
        if (r) perVariant[v.name].push(r);
      } catch { /* skip this game for this variant */ }
    }
  }, CONCURRENCY);

  console.log(`Done. ${failed} fetch failures.`);
  for (const v of VARIANTS) {
    const ok = perVariant[v.name];
    const outPath = path.join(__dirname, `scores_basketball_${v.name}.json`);
    fs.writeFileSync(outPath, JSON.stringify(ok, null, 0));
    console.log(`\n[${v.name}] threshold=${v.threshold} baseScale=${v.baseScale} -> ${ok.length} games, ${outPath}`);
    const byLeague = {};
    for (const r of ok) (byLeague[r.sport] ??= []).push(r);
    for (const lg of ['nba', 'wnba', 'cbb', 'wcbb']) {
      const rows = byLeague[lg] || [];
      if (!rows.length) continue;
      const mean = (k) => (rows.reduce((a, b) => a + b[k], 0) / rows.length).toFixed(1);
      const capPct = (100 * rows.filter(r => r.momentum === 25).length / rows.length).toFixed(0);
      console.log(`  ${lg}: n=${rows.length} meanTotal=${mean('total')} meanMom=${mean('momentum')} mom==25:${capPct}%`);
    }
  }
})();
