#!/usr/bin/env node
// Fetch completed NBA, WNBA, CBB, WCBB games and score them with the
// excitement algorithm. No Redis required — ESPN scoreboard + summary APIs only.
//
// Date windows:
//   NBA   Oct 21 – Nov 30 2025  (early season)
//   WNBA  Jul  1 – Aug 15 2025  (mid-season)
//   CBB   Nov  5 – Nov 30 2025  (opening weeks)
//   WCBB  Nov  5 – Nov 30 2025  (opening weeks)
//
// Usage: node scripts/historical-scores-basketball.mjs

import { writeFileSync } from 'node:fs';

const BASE    = 'https://site.api.espn.com/apis/site/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };
const CONCURRENCY = 10;
const OUT = 'scripts/scores_basketball.json';

// ── Sport configs ─────────────────────────────────────────────────────────────

const SPORTS = {
  nba: {
    name: 'NBA', espnSport: 'basketball', espnLeague: 'nba',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    halfPeriods: 2,   // Q1+Q2 = halftime
  },
  wnba: {
    name: 'WNBA', espnSport: 'basketball', espnLeague: 'wnba',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    halfPeriods: 2,
  },
  cbb: {
    name: 'CBB', espnSport: 'basketball', espnLeague: 'mens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    halfPeriods: 1,   // 1st half = halftime
  },
  wcbb: {
    name: 'WCBB', espnSport: 'basketball', espnLeague: 'womens-college-basketball',
    margins: { great: 3, good: 8, ok: 15, blowout: 25 },
    halfPeriods: 1,
  },
};

// ── Date generation ───────────────────────────────────────────────────────────

function dateRange(start, end) {
  const dates = [];
  const cur = new Date(start);
  const fin = new Date(end);
  while (cur <= fin) {
    dates.push(cur.toISOString().slice(0, 10).replace(/-/g, ''));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

const DATE_WINDOWS = {
  nba:  dateRange('2025-10-21', '2025-11-30'),
  wnba: dateRange('2025-07-01', '2025-08-15'),
  cbb:  dateRange('2025-11-05', '2025-12-31'),
  wcbb: dateRange('2025-11-05', '2025-12-31'),
};

// ── Algorithm (no Redis) ──────────────────────────────────────────────────────

function closenessScore(margin, m, isOT) {
  if (isOT || margin === 0) return 60;
  if (margin <= m.great)    return 60;
  if (margin <= m.good)     return 45;
  if (margin <= m.ok)       return 29;
  if (margin <= m.blowout)  return 10;
  return 0;
}

function detectComeback(halfHome, halfAway, finalMargin, sport) {
  if (halfHome == null || halfAway == null) return false;
  const halfMargin = Math.abs(halfHome - halfAway);
  return (halfMargin - finalMargin) >= sport.margins.good;
}

// Estimate momentum from period linescores: lead changes + late-period scoring.
function momentumFromLinescores(homeLines, awayLines, halfPeriods) {
  if (!homeLines?.length || !awayLines?.length) return 0;

  const periods = Math.min(homeLines.length, awayLines.length);
  let homeRunning = 0, awayRunning = 0;
  let leadChanges = 0, prevLeader = 0;
  let lastPeriodH = 0, lastPeriodA = 0;

  for (let i = 0; i < periods; i++) {
    const h = parseFloat(homeLines[i]?.value) || 0;
    const a = parseFloat(awayLines[i]?.value) || 0;
    homeRunning += h;
    awayRunning += a;

    const leader = homeRunning > awayRunning ? 1 : awayRunning > homeRunning ? -1 : 0;
    if (i > 0 && leader !== 0 && prevLeader !== 0 && leader !== prevLeader) leadChanges++;
    prevLeader = leader;

    // Track final period scoring
    if (i === periods - 1) { lastPeriodH = h; lastPeriodA = a; }
  }

  let bonus = 0;
  if (leadChanges >= 3) bonus += 6;
  else if (leadChanges >= 2) bonus += 3;

  // Active final period
  const lastTotal = lastPeriodH + lastPeriodA;
  // Basketball final-period scoring thresholds vary by sport
  const activeThreshold = halfPeriods === 1 ? 30 : 45; // halves vs quarters
  const busyThreshold   = halfPeriods === 1 ? 20 : 30;
  if (lastTotal >= activeThreshold) bonus += 6;
  else if (lastTotal >= busyThreshold) bonus += 3;

  return Math.min(20, bonus);
}

function calcExcitement(margin, isOT, isComeback, sport, momentumBonus, upsetBonus, statsBonus) {
  const cls   = closenessScore(margin, sport.margins, isOT);
  const otBon = isOT       ? 10 : 0;
  const cbBon = isComeback ? 10 : 0;
  return Math.min(100, Math.round(cls + otBon + cbBon + momentumBonus + upsetBonus + statsBonus));
}

function excitementLabel(score) {
  if (score >= 80) return 'Must Watch';
  if (score >= 60) return 'Exciting';
  if (score >= 40) return 'Worth It';
  if (score >= 20) return 'So-So';
  return 'Skip It';
}

// ── Stats bonus (current algorithm, NBA/WNBA split) ───────────────────────────

const MAX_BONUS = 15;
const THREE_KEY = 'threePointFieldGoalsMade-threePointFieldGoalsAttempted';

function nr(value, floor, ceiling) {
  return Math.max(0, Math.min(1, ((value || 0) - floor) / (ceiling - floor)));
}
function add(a, b) { return (a || 0) + (b || 0); }

function calcNBAStats(home, away, totalScore) {
  const stats = {
    points:        nr(totalScore, 200, 260),
    threePointers: nr(add(home[THREE_KEY], away[THREE_KEY]), 15, 40),
    stealsBlocks:  nr(add(home.steals, away.steals) + add(home.blocks, away.blocks), 15, 40),
  };
  const w = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  const raw = Object.entries(w).reduce((s, [k, wt]) => s + (stats[k] || 0) * wt, 0);
  return { score: Math.max(1, Math.round(raw * MAX_BONUS)), components: stats };
}

function calcWNBAStats(home, away, totalScore) {
  const stats = {
    points:        nr(totalScore, 140, 200),
    threePointers: nr(add(home[THREE_KEY], away[THREE_KEY]), 8, 22),
    stealsBlocks:  nr(add(home.steals, away.steals) + add(home.blocks, away.blocks), 12, 30),
  };
  const w = { points: 0.20, threePointers: 0.45, stealsBlocks: 0.35 };
  const raw = Object.entries(w).reduce((s, [k, wt]) => s + (stats[k] || 0) * wt, 0);
  return { score: Math.max(1, Math.round(raw * MAX_BONUS)), components: stats };
}

// CBB/WCBB use the NBA function (same stat structure, different ranges to calibrate later)
function calcCBBStats(home, away, totalScore) {
  return calcNBAStats(home, away, totalScore);
}

const STATS_FN = { nba: calcNBAStats, wnba: calcWNBAStats, cbb: calcCBBStats, wcbb: calcCBBStats };

// ── ESPN API helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { await res.text(); return null; }
    return await res.json();
  } catch { return null; }
}

async function fetchScoreboard(espnSport, espnLeague, dateStr) {
  return fetchJSON(`${BASE}/${espnSport}/${espnLeague}/scoreboard?dates=${dateStr}&limit=200`);
}

async function fetchStats(gameId, espnSport, espnLeague) {
  const data = await fetchJSON(`${BASE}/${espnSport}/${espnLeague}/summary?event=${gameId}`);
  const teamRows = data?.boxscore?.teams || [];
  if (teamRows.length < 2) return null;

  const parseTeam = (team) => {
    const stats = {};
    for (const s of team.statistics || []) {
      const val = parseFloat(s.displayValue);
      stats[s.name] = isNaN(val) ? s.displayValue : val;
    }
    return stats;
  };

  const home = teamRows.find(t => t.homeAway === 'home');
  const away = teamRows.find(t => t.homeAway === 'away');
  if (!home || !away) return null;
  return { home: parseTeam(home), away: parseTeam(away) };
}

// ── Game parsing ──────────────────────────────────────────────────────────────

async function processEvent(ev, sportKey, cfg) {
  const co     = ev.competitions?.[0];
  if (!co) return null;
  const status = co.status?.type;
  if (!status?.completed) return null;

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = parseFloat(home.score) || 0;
  const awayScore = parseFloat(away.score) || 0;
  const margin    = Math.abs(homeScore - awayScore);
  const detail    = (status.shortDetail || '').toLowerCase();
  const winnerIsHome = homeScore >= awayScore;

  const isOT = /\bot\b/.test(detail) || /\b\d+ot\b/.test(detail) ||
               detail.includes('overtime') || detail.includes('extra time');

  // Halftime from linescores
  const homeLines = home.linescores || [];
  const awayLines = away.linescores || [];
  const hp = cfg.halfPeriods;
  const halfHome = homeLines.length >= hp
    ? homeLines.slice(0, hp).reduce((s, p) => s + (parseFloat(p.value) || 0), 0) : null;
  const halfAway = awayLines.length >= hp
    ? awayLines.slice(0, hp).reduce((s, p) => s + (parseFloat(p.value) || 0), 0) : null;

  const isComeback  = detectComeback(halfHome, halfAway, margin, cfg);
  const momentumBonus = momentumFromLinescores(homeLines, awayLines, hp);

  // Stats
  const rawStats = await fetchStats(ev.id, cfg.espnSport, cfg.espnLeague);
  let statsBonus = 1, statsBonusComponents = null, rawStatsData = null;
  if (rawStats) {
    const total = homeScore + awayScore;
    const result = STATS_FN[sportKey](rawStats.home, rawStats.away, total);
    statsBonus = result.score;
    statsBonusComponents = result.components;
    rawStatsData = rawStats;
  }

  const excitement = calcExcitement(
    margin, isOT, isComeback, cfg, momentumBonus, 0, statsBonus
  );

  const cls = closenessScore(margin, cfg.margins, isOT);

  return {
    id:          ev.id,
    sport:       sportKey,
    date:        ev.date?.slice(0, 10),
    away:        away.team.abbreviation,
    home:        home.team.abbreviation,
    awayScore, homeScore, margin, isOT, isComeback,
    excitement,
    label:       excitementLabel(excitement),
    closeness:   cls,
    otBon:       isOT       ? 10 : 0,
    comebackBon: isComeback ? 10 : 0,
    momentumBonus,
    upsetBonus:  0,
    statsBonus,
    statsBonusComponents,
    rawStatsData,
  };
}

// ── Batch runner ──────────────────────────────────────────────────────────────

async function runBatch(items, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += CONCURRENCY) {
    const batch = await Promise.all(items.slice(i, i + CONCURRENCY).map(fn));
    results.push(...batch);
  }
  return results;
}

// ── Main ──────────────────────────────────────────────────────────────────────

const allGames = [];

for (const [sportKey, cfg] of Object.entries(SPORTS)) {
  const dates = DATE_WINDOWS[sportKey];
  console.log(`\nFetching ${cfg.name} (${dates[0]}–${dates[dates.length - 1]}, ${dates.length} dates)...`);

  let totalCompleted = 0;
  const events = [];

  for (const date of dates) {
    const data = await fetchScoreboard(cfg.espnSport, cfg.espnLeague, date);
    const completed = (data?.events || []).filter(ev => ev.competitions?.[0]?.status?.type?.completed);
    if (completed.length) {
      events.push(...completed.map(ev => ({ ev, sportKey, cfg })));
      totalCompleted += completed.length;
    }
  }

  console.log(`  ${totalCompleted} completed games found — fetching stats...`);

  let processed = 0;
  const games = await runBatch(events, async ({ ev, sportKey, cfg }) => {
    const g = await processEvent(ev, sportKey, cfg);
    processed++;
    if (processed % 50 === 0) process.stdout.write(`\r  ${processed}/${events.length}`);
    return g;
  });
  process.stdout.write('\n');

  const valid = games.filter(Boolean);
  console.log(`  → ${valid.length} games scored`);
  allGames.push(...valid);
}

writeFileSync(OUT, JSON.stringify(allGames, null, 2));
console.log(`\nSaved ${allGames.length} total games → ${OUT}`);

// ── Quick summary ─────────────────────────────────────────────────────────────
for (const sportKey of Object.keys(SPORTS)) {
  const gs = allGames.filter(g => g.sport === sportKey);
  if (!gs.length) continue;
  const avg  = (gs.reduce((s, g) => s + g.excitement, 0) / gs.length).toFixed(1);
  const mw   = gs.filter(g => g.excitement >= 80).length;
  const exc  = gs.filter(g => g.excitement >= 60).length;
  const sAvg = (gs.reduce((s, g) => s + g.statsBonus, 0) / gs.length).toFixed(1);
  const sMax = Math.max(...gs.map(g => g.statsBonus));
  console.log(`${SPORTS[sportKey].name.padEnd(5)} n=${gs.length.toString().padStart(4)} | avg=${avg} | Must Watch=${mw} (${(mw/gs.length*100).toFixed(1)}%) | Exciting+=${exc} | stats avg=${sAvg} max=${sMax}`);
}
