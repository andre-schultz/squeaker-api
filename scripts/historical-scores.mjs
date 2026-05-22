#!/usr/bin/env node
// Fetch completed NFL + CFB games from Oct/Nov 2025 and score them with the
// excitement algorithm. No Redis required — uses ESPN scoreboard + WP APIs.
//
// Usage:  node scripts/historical-scores.mjs [--top N] [--sport nfl|cfb|both]

import { parseArgs } from 'node:util';

const { values: args } = parseArgs({
  options: {
    top:   { type: 'string',  default: '30' },
    sport: { type: 'string',  default: 'both' },
    save:  { type: 'string',  default: '' },
  },
  strict: false,
});

const TOP_N = parseInt(args.top, 10) || 30;
const SPORT_FILTER = args.sport.toLowerCase();
const SAVE_PATH = args.save || '';

// ── Config ────────────────────────────────────────────────────────────────────

const SPORTS = {
  nfl: {
    name: 'NFL', espnSport: 'football', espnLeague: 'nfl',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
  },
  cfb: {
    name: 'CFB', espnSport: 'football', espnLeague: 'college-football',
    margins: { great: 3, good: 7, ok: 14, blowout: 24 },
  },
};

// NFL game dates Oct–Nov 2025 (Thursdays, Sundays, Mondays)
const NFL_DATES = [
  '20251002', '20251005', '20251006',
  '20251009', '20251012', '20251013',
  '20251016', '20251019', '20251020',
  '20251023', '20251026', '20251027',
  '20251030', '20251102', '20251103',
  '20251106', '20251109', '20251110',
  '20251113', '20251116', '20251117',
  '20251120', '20251123', '20251124',
  '20251127', '20251130',
];

// CFB Saturdays Oct–Nov 2025
const CFB_DATES = [
  '20251004', '20251011', '20251018', '20251025',
  '20251101', '20251108', '20251115', '20251122', '20251129',
];

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';
const CORE = 'https://sports.core.api.espn.com/v2/sports';
const HEADERS = { 'User-Agent': 'Squeaker/1.0' };

// ── Algorithm (inlined, no Redis dependency) ──────────────────────────────────

function closenessScore(margin, m, isOT) {
  if (isOT || margin === 0) return 75;
  if (margin <= m.great)   return 75;
  if (margin <= m.good)    return 56;
  if (margin <= m.ok)      return 36;
  if (margin <= m.blowout) return 12;
  return 0;
}

function detectComeback(halfHome, halfAway, finalMargin, sport) {
  if (halfHome == null || halfAway == null) return false;
  const halfMargin = Math.abs(halfHome - halfAway);
  return (halfMargin - finalMargin) >= sport.margins.good;
}

function calcExcitement(margin, isOT, isComeback, sport, momentumBonus, wpDramaBonus, upsetBonus) {
  const cls           = closenessScore(margin, sport.margins, isOT);
  const otBonus       = isOT       ? 10 : 0;
  const comebackBonus = isComeback ? 10 : 0;
  const raw = cls + otBonus + comebackBonus + momentumBonus + wpDramaBonus + upsetBonus;
  return Math.min(100, Math.round(raw));
}

function excitementLabel(score) {
  if (score >= 80) return 'Must Watch';
  if (score >= 60) return 'Exciting';
  if (score >= 40) return 'Worth It';
  if (score >= 20) return 'So-So';
  return 'Skip It';
}

// Estimate momentum from quarter linescores alone.
// Detects lead changes between quarters and heavy Q4 scoring.
function momentumFromLinescores(homeLines, awayLines) {
  if (!homeLines?.length || !awayLines?.length) return 0;

  const periods = Math.min(homeLines.length, awayLines.length);
  let homeRunning = 0;
  let awayRunning = 0;
  let leadChanges = 0;
  let prevLeader = 0; // +1 home, -1 away, 0 tied
  let q4HomeScore = 0;
  let q4AwayScore = 0;

  for (let i = 0; i < periods; i++) {
    const h = parseFloat(homeLines[i]?.value) || 0;
    const a = parseFloat(awayLines[i]?.value) || 0;
    homeRunning += h;
    awayRunning += a;

    const leader = homeRunning > awayRunning ? 1 : awayRunning > homeRunning ? -1 : 0;
    if (i > 0 && leader !== 0 && prevLeader !== 0 && leader !== prevLeader) {
      leadChanges++;
    }
    prevLeader = leader;

    // Q4 is index 3 (period 4); OT would be index 4+
    if (i === 3) { q4HomeScore = h; q4AwayScore = a; }
  }

  let bonus = 0;

  // Lead changes
  if (leadChanges >= 3) bonus += 6;
  else if (leadChanges >= 2) bonus += 3;

  // Late scoring drama in Q4: both teams scored, or margin-cutting score
  const q4Total = q4HomeScore + q4AwayScore;
  if (q4Total >= 14) bonus += 6;  // active Q4 scoring
  else if (q4Total >= 7) bonus += 3;

  return Math.min(20, bonus);
}

// Analyze win-probability history for drama signals.
// timeline = [{ homeWP, awayWP }, ...] ordered chronologically.
function analyzeWPDrama(timeline, winnerIsHome) {
  if (!timeline || timeline.length < 3) return { dramaBonus: 0, signals: [] };

  let maxSwing = 0;
  let bigSwingCount = 0;

  for (let i = 1; i < timeline.length; i++) {
    const swing = Math.abs(timeline[i].homeWP - timeline[i - 1].homeWP);
    if (swing > maxSwing) maxSwing = swing;
    if (swing >= 0.25) bigSwingCount++;
  }

  // Late comeback: winner WP dipped ≤20% in final 25% of timeline entries
  const lateStart = Math.floor(timeline.length * 0.75);
  let winnerWPmin = 1.0;
  for (let i = lateStart; i < timeline.length; i++) {
    const wp = winnerIsHome ? timeline[i].homeWP : timeline[i].awayWP;
    if (wp < winnerWPmin) winnerWPmin = wp;
  }

  let dramaBonus = 0;
  const signals = [];

  const swingBonus = Math.min(9, bigSwingCount * 3);
  if (swingBonus > 0) {
    dramaBonus += swingBonus;
    signals.push(`${bigSwingCount} big WP swing(s)`);
  }
  if (maxSwing >= 0.4) {
    dramaBonus += 5;
    signals.push(`WP flip (${(maxSwing * 100).toFixed(0)}%)`);
  }
  if (winnerWPmin <= 0.20 && timeline.length > 4) {
    dramaBonus += 8;
    signals.push(`Late comeback (dipped to ${Math.round(winnerWPmin * 100)}% WP)`);
  }

  return { dramaBonus: Math.min(15, dramaBonus), signals, maxSwing };
}

function analyzeUpset(timeline, winnerIsHome) {
  if (!timeline?.length) return { upsetBonus: 0, winnerPreGameWP: null };
  const earliest = timeline[0];
  const winnerPreGameWP = winnerIsHome ? earliest.homeWP : earliest.awayWP;
  if (winnerPreGameWP > 0.5) return { upsetBonus: 0, winnerPreGameWP };
  const bonus = Math.min(10, Math.max(0, Math.round((0.5 - winnerPreGameWP) * 20)));
  return { upsetBonus: bonus, winnerPreGameWP };
}

// ── ESPN API helpers ──────────────────────────────────────────────────────────

async function fetchJSON(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) { await res.text(); return null; }
    return await res.json();
  } catch {
    return null;
  }
}

async function fetchScoreboard(espnSport, espnLeague, dateStr) {
  const url = `${BASE}/${espnSport}/${espnLeague}/scoreboard?dates=${dateStr}&limit=100`;
  return fetchJSON(url);
}

// Fetch the full win-probability history for a completed game.
// ESPN paginates oldest-first with a configurable limit; we fetch all pages.
async function fetchFullWPTimeline(espnSport, espnLeague, eventId) {
  const PAGE_SIZE = 200;
  const firstUrl = `${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities?limit=${PAGE_SIZE}&page=1`;
  const first = await fetchJSON(firstUrl);
  if (!first?.items?.length) return [];

  const pageCount = first.pageCount || 1;
  const allItems = [...first.items];

  // Fetch remaining pages in parallel (most games fit in 1-2 pages)
  if (pageCount > 1) {
    const pageNums = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
    const pages = await Promise.all(
      pageNums.map(p =>
        fetchJSON(`${CORE}/${espnSport}/leagues/${espnLeague}/events/${eventId}/competitions/${eventId}/probabilities?limit=${PAGE_SIZE}&page=${p}`)
      )
    );
    for (const page of pages) {
      if (page?.items) allItems.push(...page.items);
    }
  }

  return allItems
    .filter(e => e.homeWinPercentage != null && e.awayWinPercentage != null)
    .map(e => ({
      homeWP: Math.max(0, Math.min(1, e.homeWinPercentage)),
      awayWP: Math.max(0, Math.min(1, e.awayWinPercentage)),
    }));
}

// ── Game parsing ──────────────────────────────────────────────────────────────

async function processEvent(ev, sportKey, cfg) {
  const co = ev.competitions?.[0];
  if (!co) return null;

  const status = co.status?.type;
  if (!status?.completed) return null; // only final games

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = parseFloat(home.score) || 0;
  const awayScore = parseFloat(away.score) || 0;
  const margin    = Math.abs(homeScore - awayScore);
  const detail    = (status.shortDetail || '').toLowerCase();
  const winnerIsHome = homeScore >= awayScore;

  const isOT = /\bot\b/.test(detail) ||
               /\b\d+ot\b/.test(detail) ||
               detail.includes('overtime') ||
               detail.includes('extra time') ||
               detail.includes('penalties');

  // Halftime scores from linescores
  const homeLines = home.linescores || [];
  const awayLines = away.linescores || [];
  const half      = Math.ceil(homeLines.length / 2);
  const halfHome  = homeLines.length >= 2
    ? homeLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;
  const halfAway  = awayLines.length >= 2
    ? awayLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;

  const isComeback = detectComeback(halfHome, halfAway, margin, cfg);

  // Momentum from quarter-by-quarter scoring
  const momentumBonus = momentumFromLinescores(homeLines, awayLines);

  // WP history from ESPN — gives drama + upset bonuses
  const wpTimeline = await fetchFullWPTimeline(cfg.espnSport, cfg.espnLeague, ev.id);
  const { dramaBonus, signals: wpSignals } = analyzeWPDrama(wpTimeline, winnerIsHome);
  const { upsetBonus, winnerPreGameWP }    = analyzeUpset(wpTimeline, winnerIsHome);

  const excitement = calcExcitement(
    margin, isOT, isComeback, cfg,
    momentumBonus, dramaBonus, upsetBonus,
  );

  // Build per-quarter score string
  const qScores = homeLines.map((q, i) => {
    const h = parseFloat(q.value) || 0;
    const a = parseFloat(awayLines[i]?.value) || 0;
    return `Q${i + 1}: ${a}-${h}`;
  }).join(' | ');

  return {
    id:          ev.id,
    sport:       sportKey,
    date:        ev.date?.slice(0, 10),
    away:        away.team.abbreviation,
    home:        home.team.abbreviation,
    awayScore,
    homeScore,
    margin,
    isOT,
    isComeback,
    excitement,
    label:       excitementLabel(excitement),
    // Score breakdown
    closeness:   closenessScore(margin, cfg.margins, isOT),
    comebackBon: isComeback ? 10 : 0,
    otBon:       isOT       ? 10 : 0,
    momentumBonus,
    dramaBonus,
    upsetBonus,
    winnerPreGameWP,
    wpSamples:   wpTimeline.length,
    wpSignals,
    qScores,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function fetchDatesForSport(sportKey, cfg, dates) {
  const games = [];
  let fetched = 0;

  for (const date of dates) {
    const data = await fetchScoreboard(cfg.espnSport, cfg.espnLeague, date);
    if (!data?.events?.length) continue;
    fetched++;

    const completed = data.events.filter(ev => ev.competitions?.[0]?.status?.type?.completed);
    console.log(`  ${sportKey.toUpperCase()} ${date}: ${completed.length} completed games`);

    // Process games in small parallel batches to avoid hammering ESPN WP API
    for (let i = 0; i < completed.length; i += 4) {
      const batch = completed.slice(i, i + 4);
      const results = await Promise.all(batch.map(ev => processEvent(ev, sportKey, cfg)));
      for (const g of results) { if (g) games.push(g); }
    }
  }

  console.log(`  → ${games.length} games processed across ${fetched} dates\n`);
  return games;
}

import { writeFileSync } from 'node:fs';

async function main() {
  const sportsToRun = SPORT_FILTER === 'nfl' ? ['nfl']
                    : SPORT_FILTER === 'cfb' ? ['cfb']
                    : ['nfl', 'cfb'];

  const allGames = [];

  for (const sportKey of sportsToRun) {
    const cfg   = SPORTS[sportKey];
    const dates = sportKey === 'nfl' ? NFL_DATES : CFB_DATES;
    console.log(`\nFetching ${cfg.name} games (${dates.length} date windows)...`);
    const games = await fetchDatesForSport(sportKey, cfg, dates);
    allGames.push(...games);
  }

  allGames.sort((a, b) => b.excitement - a.excitement);
  const top = allGames.slice(0, TOP_N);

  // ── Output ────────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(120)}`);
  console.log(`TOP ${TOP_N} MOST EXCITING GAMES — NFL + CFB Oct/Nov 2025`);
  console.log(`${'═'.repeat(120)}`);
  console.log(
    '#'.padEnd(3),
    'Score'.padEnd(7),
    'Label'.padEnd(12),
    'Sport'.padEnd(6),
    'Date'.padEnd(11),
    'Matchup'.padEnd(24),
    'Result'.padEnd(10),
    'Cls'.padEnd(4),
    'OT'.padEnd(4),
    'CB'.padEnd(4),
    'Mom'.padEnd(4),
    'WP'.padEnd(4),
    'Up'.padEnd(4),
    'WP?'.padEnd(5),
    'Signals',
  );
  console.log('─'.repeat(120));

  top.forEach((g, i) => {
    const matchup = `${g.away} @ ${g.home}`;
    const result  = `${g.awayScore}-${g.homeScore}${g.isOT ? ' OT' : ''}`;
    const wpInfo  = g.wpSamples > 0 ? `${g.wpSamples}pt` : 'none';
    const preGameWP = g.winnerPreGameWP != null
      ? ` (fav:${(g.winnerPreGameWP * 100).toFixed(0)}%)`
      : '';
    const signals = [
      g.isComeback ? 'comeback' : '',
      ...g.wpSignals,
      g.upsetBonus > 0 ? `upset+${g.upsetBonus}${preGameWP}` : '',
    ].filter(Boolean).join(', ');

    console.log(
      `${(i + 1).toString().padEnd(3)}`,
      `${g.excitement}`.padEnd(7),
      g.label.padEnd(12),
      g.sport.toUpperCase().padEnd(6),
      g.date.padEnd(11),
      matchup.padEnd(24),
      result.padEnd(10),
      `${g.closeness}`.padEnd(4),
      `${g.otBon}`.padEnd(4),
      `${g.comebackBon}`.padEnd(4),
      `${g.momentumBonus}`.padEnd(4),
      `${g.dramaBonus}`.padEnd(4),
      `${g.upsetBonus}`.padEnd(4),
      wpInfo.padEnd(5),
      signals,
    );
  });

  // ── Summary stats ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(120));
  console.log('SUMMARY STATISTICS');
  console.log('─'.repeat(50));

  for (const sportKey of sportsToRun) {
    const gs = allGames.filter(g => g.sport === sportKey);
    if (!gs.length) continue;
    const avg = (gs.reduce((s, g) => s + g.excitement, 0) / gs.length).toFixed(1);
    const max = gs[0]?.excitement;
    const mustWatch = gs.filter(g => g.excitement >= 80).length;
    const exciting  = gs.filter(g => g.excitement >= 60).length;
    const hasWP     = gs.filter(g => g.wpSamples > 0).length;
    console.log(`${SPORTS[sportKey].name.padEnd(8)} — ${gs.length} games | avg: ${avg} | max: ${max} | Must Watch: ${mustWatch} | Exciting+: ${exciting} | WP data: ${hasWP}`);
  }

  // Distribution
  const buckets = { 'Must Watch (80+)': 0, 'Exciting (60-79)': 0, 'Worth It (40-59)': 0, 'So-So (20-39)': 0, 'Skip It (<20)': 0 };
  for (const g of allGames) {
    if (g.excitement >= 80) buckets['Must Watch (80+)']++;
    else if (g.excitement >= 60) buckets['Exciting (60-79)']++;
    else if (g.excitement >= 40) buckets['Worth It (40-59)']++;
    else if (g.excitement >= 20) buckets['So-So (20-39)']++;
    else buckets['Skip It (<20)']++;
  }

  console.log('\nDistribution:');
  const total = allGames.length;
  for (const [label, count] of Object.entries(buckets)) {
    const bar = '█'.repeat(Math.round(count / total * 40));
    console.log(`  ${label.padEnd(22)} ${String(count).padStart(4)} (${(count / total * 100).toFixed(1)}%) ${bar}`);
  }
  console.log('');

  if (SAVE_PATH) {
    writeFileSync(SAVE_PATH, JSON.stringify(allGames, null, 2));
    console.log(`Saved ${allGames.length} games to ${SAVE_PATH}`);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
