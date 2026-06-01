// Uses native global fetch (Node 18+). node-fetch v3 was previously implicated
// in a slow memory leak via undici pool retention; native fetch hits the
// same undici layer but without the wrapper.
import { SPORTS, HOURS_WINDOW, AUDIT_ENABLED, isSoccer, espnGamecastUrl } from '../config.js';
import { calcExcitement, calcExcitementBreakdown, detectComeback, excitementDesc } from './algorithm.js';
import { recordSnapshot, analyzeMomentum } from './timeline.js';
import {
  fetchAndStoreWPTimeline,
  analyzeUpset,
  computeActionScore,
} from './probabilities.js';
import { getOrFetchOdds } from './odds.js';
import { recordAudit } from './audit.js';
import { getStatsBonus } from './statsBonus.js';
import { mlPairToWP } from './sgo.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// ── In-process done-game cache ────────────────────────────────────────────────
// Once a game completes and is fully scored, its record is frozen here.
// Subsequent calls to parseEvent (same process) return immediately — 0 Redis,
// 0 ESPN-per-game work. On restart, warmup.js pre-populates this via
// preFreezeGames() so the very first cycle is also free.
// NOTE: the warmup.js _doneGames Map is the authoritative store; this Map is
// just a fast-path for parseEvent. warmup.js is responsible for lifecycle.
const frozenGames = new Map(); // gameId → game object

// Pre-populate frozenGames from a previously saved games list (called on startup
// so the first game cycle skips full processing for already-done games).
export function preFreezeGames(games) {
  for (const game of games) {
    if (game.done && !frozenGames.has(game.id)) {
      frozenGames.set(game.id, game);
    }
  }
}

// Remove a game from frozenGames when warmup.js prunes it from _doneGames.
// Keeps both Maps in sync so stale entries don't accumulate indefinitely.
export function pruneFrozenGame(id) {
  frozenGames.delete(id);
}

// Fetch all games and upcoming games in a single ESPN pass.
// Returns { games, upcoming } where games is sorted by excitement desc
// and upcoming is sorted by start time asc.
export async function fetchAllEvents() {
  const dates = getAllDateStrings();
  const results = await Promise.all(
    Object.entries(SPORTS).map(([key, cfg]) => fetchSport(key, cfg, dates))
  );
  const seenGames    = new Set();
  const seenUpcoming = new Set();
  const games = results.flatMap(r => r.games).filter(g => {
    if (seenGames.has(g.id)) return false;
    seenGames.add(g.id);
    return true;
  });
  const upcoming = results.flatMap(r => r.upcoming).filter(g => {
    if (seenUpcoming.has(g.id)) return false;
    seenUpcoming.add(g.id);
    return true;
  });
  return {
    games:    games.sort((a, b) => b.excitement - a.excitement),
    upcoming: upcoming.sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}

// Backward-compat wrapper used by the cache-miss fallback in routes/games.js
export async function fetchAllGames() {
  const { games } = await fetchAllEvents();
  return games;
}

async function fetchSport(key, cfg, dates) {
  // The 2-3 dates are independent scoreboard fetches — run them in parallel.
  const perDate = await Promise.all(dates.map(date => fetchSportDate(key, cfg, date)));
  return {
    games:    perDate.flatMap(r => r.games),
    upcoming: perDate.flatMap(r => r.upcoming),
  };
}

// Fetch and parse a single date's scoreboard for one sport.
async function fetchSportDate(key, cfg, date) {
  const games    = [];
  const upcoming = [];
  try {
    // College leagues span multiple divisions; `conference.group` pins the
    // scoreboard to one (FBS / D-I) so lower-division games never leak in.
    const params = [];
    if (date) params.push(`dates=${date}`);
    if (cfg.conference?.group) params.push(`groups=${cfg.conference.group}`);
    const qs  = params.length ? `?${params.join('&')}` : '';
    const url = `${BASE}/${cfg.espnSport}/${cfg.espnLeague}/scoreboard${qs}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
    if (!res.ok) {
      // Drain body so the underlying socket is released.
      try { await res.text(); } catch {}
      return { games, upcoming };
    }
    let data = await res.json();
    const events = data.events || [];
    for (const ev of events) {
      const game = await parseEvent(ev, key, cfg);
      if (game) { games.push(game); continue; }
      const upcomingGame = parseUpcomingEvent(ev, key, cfg);
      if (upcomingGame) upcoming.push(upcomingGame);
    }
    // Release the parsed payload before returning.
    data = null;
  } catch (e) {
    console.error(`ESPN fetch error [${key}]:`, e.message);
  }
  return { games, upcoming };
}

async function parseEvent(ev, sportKey, cfg) {
  const co = ev.competitions?.[0];
  if (!co) return null;

  const status = co.status?.type;
  const done   = !!status?.completed;
  const live   = !done && status?.state === 'in';
  if (!done && !live) return null;

  // Filter to time window
  const gameTime = new Date(ev.date);
  const cutoff   = new Date(Date.now() - HOURS_WINDOW * 60 * 60 * 1000);
  if (gameTime < cutoff) return null;

  // ── Fast path: in-process done-game cache ────────────────────────────
  // Done games never change. If we've already processed this game in this
  // process (or warmup pre-loaded it), return immediately — 0 Redis, 0 ESPN.
  if (done) {
    const mem = frozenGames.get(ev.id);
    if (mem) return mem;
    // Not frozen yet — fall through to full processing, freeze at end.
  }

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = parseFloat(home.score) || 0;
  const awayScore = parseFloat(away.score) || 0;
  const margin    = Math.abs(homeScore - awayScore);

  const detail    = (status?.shortDetail || '').toLowerCase();
  const rawDetail = status?.shortDetail || '';
  // For soccer, ESPN increments period when ET/penalties start (period 3 = ET first half,
  // 4 = ET second half, 5 = penalty shootout). Use it as a fallback isOT signal when
  // shortDetail is just a minute marker like "91'" with no OT keyword.
  const period    = co.status?.period;

  const isOT = hasOTKeyword(detail) ||
               (isSoccer(sportKey) && period >= 3) ||
               (sportKey === 'mlb' && (/\/\d{2,}/.test(detail) || parseInning(detail) >= 10));

  // Game progress (0.0–1.0) — used to weight live excitement scores
  const progress = estimateProgress(sportKey, detail, comps, period);

  // Extract halftime scores for comeback detection
  const homeLines = home.linescores || [];
  const awayLines = away.linescores || [];
  const half      = Math.ceil(homeLines.length / 2);
  const halfHome  = homeLines.length >= 2
    ? homeLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;
  const halfAway  = awayLines.length >= 2
    ? awayLines.slice(0, half).reduce((s, p) => s + (parseFloat(p.value) || 0), 0)
    : null;

  const isComeback = done ? detectComeback(halfHome, halfAway, margin, cfg) : false;

  // Build partial game object for snapshot recording
  const partialGame = {
    id: ev.id, sport: sportKey,
    home: { score: homeScore }, away: { score: awayScore },
    progress,
    live, done,
  };

  // These four are independent cache/network operations — run them together
  // rather than serializing a round-trip per signal:
  //  • recordSnapshot          → score timeline (momentum)
  //  • fetchAndStoreWPTimeline → ESPN play-by-play WP history (no-op for soccer
  //                              / pre-game); drives upset + action signals
  //  • getOrFetchOdds          → frozen pre-game line (display + upset fallback)
  //  • getStatsBonus           → stats-activity bonus written by the stats cycle
  const [timeline, wpTimeline, odds, statsBonusRecord] = await Promise.all([
    recordSnapshot(partialGame),
    fetchAndStoreWPTimeline(partialGame, cfg.espnSport, cfg.espnLeague),
    getOrFetchOdds(ev.id, cfg.espnSport, cfg.espnLeague),
    getStatsBonus(ev.id),
  ]);

  // Analyze momentum from full scoring timeline
  const { momentumBonus, signals } = analyzeMomentum(timeline, { sport: sportKey });

  // ── Win-probability signal ──────────────────────────────────────────
  let { upsetBonus, winnerPreGameWP } = analyzeUpset(wpTimeline, {
    ...partialGame,
    home: { ...partialGame.home, score: homeScore },
    away: { ...partialGame.away, score: awayScore },
  });

  // When the WP timeline was never recorded, fall back to the pre-game money
  // line to detect upsets. mlPairToWP vig-normalises so the sides sum to 1.0.
  if (winnerPreGameWP === null && done && odds?.homeML != null && odds?.awayML != null) {
    const wp = mlPairToWP(odds.homeML, odds.awayML);
    if (wp) {
      const winnerHome = homeScore > awayScore;
      const winnerWP   = winnerHome ? wp.homeWP : wp.awayWP;
      winnerPreGameWP  = winnerWP;
      if (winnerWP < 0.5) {
        upsetBonus = Math.min(10, Math.max(0, Math.round((0.5 - winnerWP) * 20)));
      }
    }
  }

  // ── Action score from full WP history ────────────────────────────────
  // Computed across the entire WP timeline, not just a recent window.
  // Computed for both live and just-finished games so the frozen game
  // object retains the last real value rather than zero.
  const actionRaw = (live || done) ? computeActionScore(wpTimeline, sportKey) : null;
  const currentLiveActionBuzz = actionRaw?.score ?? 0;

  const statsBonus = statsBonusRecord?.score ?? 0;

  // For live games, scale by progress so early-game close scores don't rank too high
  const excitement = calcExcitement(
    margin,
    isOT,
    isComeback,
    cfg,
    momentumBonus,
    live ? progress : 1.0,
    upsetBonus,
    statsBonus,
  );

  const mkTeam = (T, score, winner) => ({ ...baseTeam(T), score, winner: !!winner });

  const game = {
    id:              ev.id,
    sport:           sportKey,
    sportName:       cfg.name,
    sportEmoji:      cfg.emoji,
    home:            mkTeam(home, homeScore, home.winner),
    away:            mkTeam(away, awayScore, away.winner),
    margin,
    isOT,
    isComeback,
    momentumBonus,
    momentumSignals: signals,
    upsetBonus,
    statsBonus,
    winnerPreGameWP,
    progress,
    gameStage:       rawDetail,
    done,
    live,
    excitement,
    desc:            excitementDesc(margin, isOT, isComeback, cfg),
    date:            ev.date,
    odds,                     // frozen pre-game line for display
    currentLiveActionBuzz,    // 0-100, computed from full WP history; retains last value after game ends
    links:           { espn: espnGamecastUrl(sportKey, ev.id) }, // server-built "cast ↗" link
  };

  // ── Audit snapshot — captures everything that affects the excitement
  // score so a stored game can be replayed and explained later.
  // No-op when AUDIT_ENABLED is false.
  if (AUDIT_ENABLED) {
    const breakdown = calcExcitementBreakdown(
      margin, isOT, isComeback, cfg, momentumBonus,
      live ? progress : 1.0, upsetBonus, statsBonus,
    );
    // Raw ESPN status fields — verbatim inputs to estimateProgress(), plus the
    // derived progress/isOT it produced, so we can replay and tune it offline.
    const statusSnapshot = {
      name:         status?.name,            // e.g. "STATUS_HALFTIME", "STATUS_FINAL_PEN"
      state:        status?.state,           // "pre" | "in" | "post"
      description:  status?.description,      // e.g. "Final Score - After Penalties"
      detail:       status?.detail,          // e.g. "FT-Pens"
      period:       co.status?.period,       // ESPN period (soccer 3+ = ET/penalties)
      displayClock: co.status?.displayClock, // e.g. "9:11", "120'+2'"
      clock:        co.status?.clock,        // numeric seconds remaining
      derivedProgress: progress,             // what estimateProgress() returned
      derivedIsOT:     isOT,                  // what isOT detection returned
    };
    await recordAudit(game, {
      momentum:   { bonus: momentumBonus, signals },
      upset:      { bonus: upsetBonus, winnerPreGameWP },
      liveAction: {
        current:   currentLiveActionBuzz,
        breakdown: actionRaw,
      },
      statsActivity: statsBonusRecord
        ? { score: statsBonusRecord.score, breakdown: statsBonusRecord.breakdown }
        : null,
      excitement: breakdown,
    }, statusSnapshot);
  }

  // ── Freeze in-process ────────────────────────────────────────────────
  // Store in the local Map so the next call to parseEvent for this game
  // short-circuits immediately. warmup.js adds it to _doneGames so it
  // survives future cycles without any ESPN or Redis work.
  if (done) {
    frozenGames.set(ev.id, game);
    console.log(`[frozen] ${game.away.abbr} @ ${game.home.abbr} (${game.sport}) — game frozen`);
  }

  return game;
}

function parseUpcomingEvent(ev, sportKey, cfg) {
  const co = ev.competitions?.[0];
  if (!co) return null;

  const status = co.status?.type;
  if (status?.state !== 'pre') return null;

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const mkTeam = (T) => ({
    ...baseTeam(T),
    record: T.records?.find(r => r.type === 'total')?.summary ?? null,
  });

  const rawOdds = co.odds?.[0];
  const odds = rawOdds ? {
    details:    rawOdds.details ?? null,
    homeML:     rawOdds.moneyline?.home?.close?.odds ?? null,
    awayML:     rawOdds.moneyline?.away?.close?.odds ?? null,
    spread:     rawOdds.spread ?? null,
    overUnder:  rawOdds.overUnder ?? null,
  } : null;

  const venue = co.venue ? {
    name:   co.venue.fullName,
    city:   co.venue.address?.city ?? null,
    state:  co.venue.address?.state ?? null,
    indoor: co.venue.indoor ?? null,
  } : null;

  const broadcasts = (co.broadcasts || []).map(b => ({ market: b.market, names: b.names }));

  return {
    id:         ev.id,
    sport:      sportKey,
    sportName:  cfg.name,
    sportEmoji: cfg.emoji,
    date:       ev.date,
    home:       mkTeam(home),
    away:       mkTeam(away),
    venue,
    broadcasts,
    odds,
    links:      { espn: espnGamecastUrl(sportKey, ev.id) }, // server-built "cast ↗" link
  };
}

// Returns date strings for tomorrow, today, and yesterday.
// Three dates covers: upcoming (tomorrow), live (today), and edge cases like
// games that started last night and finished after midnight (yesterday's date).
// Done games older than yesterday come from warmup.js's _doneGames Map —
// we never re-fetch them from ESPN.
function getAllDateStrings() {
  const dates = [];
  for (let i = -1; i <= 1; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}

// Estimates game progress 0.0–1.0 from status detail string
function estimateProgress(sportKey, detail, comps, period) {
  try {
    if (!detail || detail.includes('final') || /\bft\b/.test(detail)) return 1.0;

    // Soccer: period >= 3 means ET or penalties regardless of what shortDetail says
    // (live ET shows minute strings like "91'" that don't mention overtime)
    if (isSoccer(sportKey) && period >= 3) return 1.0;

    // Any overtime / extra time / penalties = full game played
    if (hasOTKeyword(detail)) return 1.0;

    // Intermission / end of period — treat as end of that period
    const isIntermission = detail.includes('intermission') ||
                           detail.includes('end of') ||
                           detail.includes('halftime') ||
                           detail.includes('half time') ||
                           detail.includes('ht');

    if (['nfl', 'cfb'].includes(sportKey)) {
      const qtr  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : detail.includes('4th') ? 4 : null;
      const mins = parseMinutes(detail);
      if (qtr && mins !== null && !isIntermission) {
        return Math.min(1.0, ((qtr - 1) * 15 + (15 - mins)) / 60);
      }
      if (qtr && isIntermission) return Math.min(1.0, (qtr * 15) / 60);
    }

    if (['nba', 'wnba', 'cbb', 'wcbb'].includes(sportKey)) {
      const qtr  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : detail.includes('4th') ? 4 : null;
      const mins = parseMinutes(detail);
      if (sportKey === 'nba') {
        if (qtr && mins !== null && !isIntermission) return Math.min(1.0, ((qtr - 1) * 12 + (12 - mins)) / 48);
        if (qtr && isIntermission) return Math.min(1.0, (qtr * 12) / 48);
      }
      if (sportKey === 'wnba' || sportKey === 'wcbb') {
        // 4 quarters × 10 min = 40 min total
        if (qtr && mins !== null && !isIntermission) return Math.min(1.0, ((qtr - 1) * 10 + (10 - mins)) / 40);
        if (qtr && isIntermission) return Math.min(1.0, (qtr * 10) / 40);
      }
      if (sportKey === 'cbb') {
        if (detail.includes('1st half')) return isIntermission ? 0.5 : mins != null ? (20 - mins) / 40 : 0.25;
        if (detail.includes('2nd half')) return isIntermission ? 1.0 : mins != null ? (40 - mins) / 40 : 0.75;
      }
    }

    if (sportKey === 'mlb') {
      const inning = parseInning(detail);
      if (inning) {
        const half = detail.includes('bot') ? 0.5 : 0;
        return Math.min(1.0, (inning - 1 + half) / 9);
      }
    }

    if (sportKey === 'nhl') {
      const per  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : null;
      const mins = parseMinutes(detail);
      if (per && mins !== null && !isIntermission) {
        return Math.min(1.0, ((per - 1) * 20 + (20 - mins)) / 60);
      }
      // End of any period — count it as complete
      if (per && isIntermission) return Math.min(1.0, (per * 20) / 60);
      // End of 3rd / between 3rd and OT = full regulation
      if (detail.includes('3rd') || (!per && isIntermission)) return 1.0;
    }

    if (isSoccer(sportKey)) {
      const minMatch = detail.match(/(\d+)'/);
      if (minMatch) return Math.min(1.0, parseInt(minMatch[1]) / 90);
      if (isIntermission) return 0.5;
    }
  } catch {}
  return 0.5;
}

// Shared team fields used by both the scored-game and upcoming-game shapes.
function baseTeam(T) {
  return {
    name:     T.team.shortDisplayName || T.team.displayName,
    fullName: T.team.displayName,
    abbr:     T.team.abbreviation,
    logo:     T.team.logo,
    color:    T.team.color ? `#${T.team.color}` : '#374151',
  };
}

// Shared overtime / extra-time / penalties keyword detector. Used by both the
// isOT flag and progress estimation so the two can never drift apart.
const OT_KEYWORD_RE = /\bot\b|\b\d+ot\b|overtime|extra time|penalties|pens|ft-et|aet|shootout/;
function hasOTKeyword(detail) {
  return OT_KEYWORD_RE.test(detail);
}

function parseMinutes(detail) {
  const m = detail.match(/(\d+):(\d+)/);
  if (m) return parseInt(m[1]) + parseInt(m[2]) / 60;
  // ESPN uses decimal seconds for sub-minute clock (e.g. "20.2 - 4th")
  const s = detail.match(/^(\d+\.\d+)\s*-/);
  if (s) return parseFloat(s[1]) / 60;
  return null;
}

function parseInning(detail) {
  const m = detail.match(/\b(\d+)(?:st|nd|rd|th)\b/);
  return m ? parseInt(m[1]) : null;
}
