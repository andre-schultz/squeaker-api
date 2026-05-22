#!/usr/bin/env node
// Re-score all games from scores_oct_nov_2025.json using the updated algorithm:
//   - Closeness ceiling 60 (was 75), tiers: 60/45/29/10
//   - WP drama bonus removed
//   - Stats activity bonus added (up to +15)
//
// Fetches stats from ESPN summary endpoint (one call per game, batched 10 at a time).
// Saves result to scores_oct_nov_2025_v2.json.

import { writeFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __dir  = path.dirname(fileURLToPath(import.meta.url));
const IN     = path.join(__dir, 'scores_oct_nov_2025.json');
const OUT    = path.join(__dir, 'scores_oct_nov_2025_v2.json');
const CONCURRENCY = 10;

const HEADERS = { 'User-Agent': 'Squeaker/1.0' };
const SUMMARY = 'https://site.api.espn.com/apis/site/v2/sports';

const SPORTS_CFG = {
  nfl: { espnSport: 'football', espnLeague: 'nfl',              margins: { great: 3, good: 7, ok: 14, blowout: 24 } },
  cfb: { espnSport: 'football', espnLeague: 'college-football', margins: { great: 3, good: 7, ok: 14, blowout: 24 } },
};

// ── Updated algorithm (matches committed src/services/algorithm.js) ────────────

function closenessScore(margin, m, isOT) {
  if (isOT || margin === 0) return 60;
  if (margin <= m.great)    return 60;
  if (margin <= m.good)     return 45;
  if (margin <= m.ok)       return 29;
  if (margin <= m.blowout)  return 10;
  return 0;
}

function calcExcitement(margin, isOT, isComeback, sport, momentumBonus, upsetBonus, statsBonus) {
  const cls     = closenessScore(margin, sport.margins, isOT);
  const otBon   = isOT       ? 10 : 0;
  const cbBon   = isComeback ? 10 : 0;
  const raw     = cls + otBon + cbBon + momentumBonus + upsetBonus + statsBonus;
  return Math.min(100, Math.round(raw));
}

function excitementLabel(score) {
  if (score >= 80) return 'Must Watch';
  if (score >= 60) return 'Exciting';
  if (score >= 40) return 'Worth It';
  if (score >= 20) return 'So-So';
  return 'Skip It';
}

// ── Stats bonus (mirrors src/services/statsBonus.js) ─────────────────────────

const MAX_BONUS = 15;

function nr(value, floor, ceiling) {
  return Math.max(0, Math.min(1, ((value || 0) - floor) / (ceiling - floor)));
}
function s(a, b) { return (a || 0) + (b || 0); }

function calcFootballStatsBonus(home, away, totalScore) {
  const stats = {
    points:     nr(totalScore, 3, 65),
    turnovers:  nr(s(home.interceptions, away.interceptions) + s(home.fumbles, away.fumbles), 0, 6),
    firstDowns: nr(s(home.firstDowns,    away.firstDowns),    20, 65),
    yards:      nr(s(home.totalYards,    away.totalYards),   350, 840),
  };
  const weights = { points: 0.25, turnovers: 0.35, firstDowns: 0.20, yards: 0.20 };
  const raw = Object.entries(weights).reduce((acc, [k, w]) => acc + (stats[k] || 0) * w, 0);
  return Math.max(1, Math.round(raw * MAX_BONUS));
}

// ── ESPN stats fetch ───────────────────────────────────────────────────────────

async function fetchStats(gameId, espnSport, espnLeague) {
  try {
    const url = `${SUMMARY}/${espnSport}/${espnLeague}/summary?event=${gameId}`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { await res.text(); return null; }
    const data = await res.json();
    const teamRows = data.boxscore?.teams || [];
    if (teamRows.length < 2) return null;

    const parseTeam = (team) => {
      const stats = {};
      for (const s of team.statistics || []) {
        if (Array.isArray(s.stats)) {
          for (const sub of s.stats) {
            const val = parseFloat(sub.displayValue);
            stats[`${s.name}_${sub.name}`] = isNaN(val) ? sub.displayValue : val;
          }
        } else {
          const val = parseFloat(s.displayValue);
          stats[s.name] = isNaN(val) ? s.displayValue : val;
        }
      }
      return stats;
    };

    const home = teamRows.find(t => t.homeAway === 'home');
    const away = teamRows.find(t => t.homeAway === 'away');
    if (!home || !away) return null;
    return { home: parseTeam(home), away: parseTeam(away) };
  } catch {
    return null;
  }
}

// ── Batch executor ────────────────────────────────────────────────────────────

async function processBatch(games, processFn) {
  const results = [];
  for (let i = 0; i < games.length; i += CONCURRENCY) {
    const batch = games.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(batch.map(processFn));
    results.push(...batchResults);
    process.stdout.write(`\r  ${Math.min(i + CONCURRENCY, games.length)} / ${games.length} games`);
  }
  process.stdout.write('\n');
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const games = JSON.parse(readFileSync(IN, 'utf8'));
console.log(`Loaded ${games.length} games from ${IN}`);

let statsMissed = 0;

const rescored = await processBatch(games, async (g) => {
  const cfg   = SPORTS_CFG[g.sport];
  const stats = await fetchStats(g.id, cfg.espnSport, cfg.espnLeague);

  let statsBonus = 0;
  let statsBonusBreakdown = null;

  if (stats) {
    statsBonus         = calcFootballStatsBonus(stats.home, stats.away, g.homeScore + g.awayScore);
    statsBonusBreakdown = { home: stats.home, away: stats.away };
  } else {
    statsMissed++;
  }

  const excitement = calcExcitement(
    g.margin, g.isOT, g.isComeback, cfg,
    g.momentumBonus, g.upsetBonus, statsBonus,
  );

  return {
    ...g,
    // Replace old WP-era excitement with new formula
    excitement,
    label: excitementLabel(excitement),
    // Updated component values
    closeness:   closenessScore(g.margin, cfg.margins, g.isOT),
    statsBonus,
    statsBonusBreakdown,
    // Remove WP drama (no longer in score)
    dramaBonus:  undefined,
    wpSignals:   undefined,
  };
});

console.log(`Stats fetched: ${games.length - statsMissed} / ${games.length} (${statsMissed} missed)`);

writeFileSync(OUT, JSON.stringify(rescored, null, 2));
console.log(`Saved → ${OUT}`);

// ── Quick summary ─────────────────────────────────────────────────────────────

for (const sport of ['nfl', 'cfb']) {
  const gs = rescored.filter(g => g.sport === sport);
  const avg = (gs.reduce((a, g) => a + g.excitement, 0) / gs.length).toFixed(1);
  const byLabel = ['Must Watch', 'Exciting', 'Worth It', 'So-So', 'Skip It'].map(l => {
    const n = gs.filter(g => g.label === l).length;
    return `${l}: ${n} (${(n / gs.length * 100).toFixed(1)}%)`;
  });
  console.log(`\n${sport.toUpperCase()} avg=${avg}  |  ${byLabel.join('  |  ')}`);
}
