// Uses native global fetch (Node 18+). node-fetch v3 was previously implicated
// in a slow memory leak via undici pool retention; native fetch hits the
// same undici layer but without the wrapper.
import { SPORTS, HOURS_WINDOW, AUDIT_ENABLED, isSoccer, espnGamecastUrl } from '../config.js';
import { calcExcitementBreakdown, excitementDesc } from './algorithm.js';
import { recordSnapshot, analyzeMomentum, analyzeComeback } from './timeline.js';
import {
  fetchAndStoreWPTimeline,
  analyzeUpset,
  computeActionScore,
  mlPairToWP,
} from './probabilities.js';
import { getOrFetchOdds } from './odds.js';
import { recordAudit } from './audit.js';
import { getStatsBonus } from './statsBonus.js';

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
  _pregameMeta.delete(id);
}

// ── Pre-game record / rank snapshots ──────────────────────────────────────────
// ESPN's `records` on a FINAL game is POST-game: the day after a win, the
// scoreboard shows the same record the final card showed, so the result is
// already baked in. Rendering that on a completed card would leak the outcome
// to a user who saw the same matchup pre-game (52-48 → 53-48 = home won),
// which breaks the app's spoiler-free contract.
//
// So we snapshot record + rank on every sighting where the game is NOT done,
// and serve that frozen snapshot once it finishes. Overwriting on each pre-game
// sighting means the last write before the game ends is the closest to tipoff.
// The snapshot rides along on the done-game object into _doneGames → games:all,
// so it survives a restart even though this Map does not.
const _pregameMeta = new Map(); // gameId → { home: {record, rank}, away: {record, rank} }

// Seed from a cached games:upcoming list on boot so a game that is already live
// when the process starts still has a pre-game record to freeze.
export function seedPregameMeta(upcoming) {
  for (const g of upcoming) {
    if (_pregameMeta.has(g.id)) continue;
    _pregameMeta.set(g.id, {
      home: { record: g.home?.record ?? null, rank: g.home?.rank ?? null },
      away: { record: g.away?.record ?? null, rank: g.away?.rank ?? null },
    });
  }
}

function snapshotPregame(id, home, away) {
  _pregameMeta.set(id, {
    home: { record: teamRecord(home), rank: teamRank(home) },
    away: { record: teamRecord(away), rank: teamRank(away) },
  });
}

// ── Out-of-season league suppression ──────────────────────────────────────────
// A league that returns zero games — live, done, OR upcoming — across every
// fetched date is almost certainly out of season. We mark it dormant for the
// remainder of the current day (ET) and stop querying ESPN for it, then re-check
// on the next day so it automatically comes back online when its season starts.
//
// Only a CONFIRMED-empty fetch marks dormancy: at least one date must have
// responded OK. A league whose requests all errored is left active so a
// transient ESPN outage can't suppress a whole league for the rest of the day.
// The map is keyed by league and holds the ET date it's dormant FOR, so once the
// day rolls over the stale entry no longer matches and the league is queried again.
const _dormantForDate = new Map(); // leagueKey → ET date string ('YYYY-MM-DD')

// ET calendar date, matching warmup.js's isOffHours() timezone basis. en-CA
// formats as YYYY-MM-DD so string equality is a clean same-day check.
function etDateString() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

// Fetch all games and upcoming games in a single ESPN pass.
// Returns { games, upcoming } where games is sorted by excitement desc
// and upcoming is sorted by start time asc.
export async function fetchAllEvents() {
  const dates = getAllDateStrings();
  const today = etDateString();

  // Skip leagues already confirmed empty earlier today; query everything else.
  const active = Object.entries(SPORTS).filter(([key]) => _dormantForDate.get(key) !== today);
  const results = await Promise.all(
    active.map(([key, cfg]) => fetchSport(key, cfg, dates))
  );

  // Update dormancy from this pass: confirmed-empty → dormant for today;
  // any games found → clear (back in season). Errored-and-empty → leave as-is.
  active.forEach(([key], i) => {
    const r = results[i];
    const total = r.games.length + r.upcoming.length;
    if (total > 0) {
      _dormantForDate.delete(key);
    } else if (r.ok) {
      _dormantForDate.set(key, today);
    }
  });

  const dormant = Object.keys(SPORTS).filter(key => _dormantForDate.get(key) === today);
  if (dormant.length) {
    console.log(`[espn] ${active.length} leagues queried, ${dormant.length} dormant today: ${dormant.join(', ')}`);
  }

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
  // The dates are independent scoreboard fetches — run them in parallel.
  const perDate = await Promise.all(dates.map(date => fetchSportDate(key, cfg, date)));
  return {
    // ok = at least one date responded OK, so an all-empty result is a genuine
    // "no games" rather than an outage. Drives out-of-season suppression.
    ok:       perDate.some(r => r.ok),
    games:    perDate.flatMap(r => r.games),
    upcoming: perDate.flatMap(r => r.upcoming),
  };
}

// Fetch and parse a single date's scoreboard for one sport.
async function fetchSportDate(key, cfg, date) {
  const games    = [];
  const upcoming = [];
  let   ok       = false;
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
      return { ok, games, upcoming };
    }
    const data = await res.json();
    ok = true; // parseable 200 — this date's emptiness (if any) is real, not an error
    const events = data.events || [];
    for (const ev of events) {
      const game = await parseEvent(ev, key, cfg);
      if (game) { games.push(game); continue; }
      const upcomingGame = parseUpcomingEvent(ev, key, cfg);
      if (upcomingGame) upcoming.push(upcomingGame);
    }
  } catch (e) {
    console.error(`ESPN fetch error [${key}]:`, e.message);
  }
  return { ok, games, upcoming };
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

  // Still in progress — refresh the pre-game snapshot. ESPN has not folded this
  // game into either team's record yet, so what it reports now is still pre-game.
  if (!done) snapshotPregame(ev.id, home, away);

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

  // Penalty shootout / hockey SO — soccer marks it as period 5 (3 = ET first
  // half, 4 = ET second half, 5 = shootout); detail keywords catch the rest.
  // A subset of isOT, so a shootout game earns both bonuses.
  const isShootout = hasShootoutKeyword(detail) || (isSoccer(sportKey) && period >= 5);

  // Game progress (0.0–1.0) — used to weight live excitement scores
  const progress = estimateProgress(sportKey, detail, comps, period);

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

  // Analyze momentum from full scoring timeline. Basketball scoring runs are
  // pre-computed from play-by-play in the stats cycle (stored on the stats-bonus
  // record); pass them through so they share momentum's cap.
  const runs = statsBonusRecord?.runs;
  const { momentumBonus, signals } = analyzeMomentum(timeline, { sport: sportKey }, {
    done, progress,
    runBonus:    runs?.runBonus ?? 0,
    runSignals:  runs?.signals ?? [],
  });

  // Trajectory-aware comeback bonus from the same timeline (0–15, can fire more
  // than once). Replaces the old halftime-vs-final boolean.
  const { comebackBonus, signals: comebackSignals } = analyzeComeback(timeline, cfg, { done, progress, sportKey });

  // ── Empty-net-adjusted closeness margin ──────────────────────────────────
  // Empty-net goals (trailing team pulls the goalie) inflate the final margin
  // but aren't a sign of a one-sided game. ESPN flags them; the stats cycle
  // counts them per side onto the stats-bonus record. Strip them from the
  // margin used for closeness ONLY — the displayed score and every other signal
  // (momentum, comeback, stats) still use the real score.
  const engHome = statsBonusRecord?.emptyNet?.home ?? 0;
  const engAway = statsBonusRecord?.emptyNet?.away ?? 0;
  const closenessMargin = Math.abs((homeScore - engHome) - (awayScore - engAway));

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

  // For live games, scale by progress so early-game close scores don't rank too
  // high. The breakdown is computed once and reused by the audit snapshot below.
  const excitementBreakdown = calcExcitementBreakdown({
    margin:   closenessMargin,
    sport:    cfg,
    isOT,
    isShootout,
    comebackBonus,
    momentumBonus,
    upsetBonus,
    statsBonus,
    progress: live ? progress : 1.0,
  });
  const excitement = excitementBreakdown.final;

  // Frozen pre-game record + rank. Never read from `T` here: on a done game
  // ESPN's own values already include this result and would spoil it. A game
  // first seen after it finished has no snapshot and simply reports null.
  const pre = _pregameMeta.get(ev.id);
  const mkTeam = (T, score, winner, side) => ({
    ...baseTeam(T),
    score,
    winner: !!winner,
    record: pre?.[side]?.record ?? null,
    rank:   pre?.[side]?.rank   ?? null,
  });

  const game = {
    id:              ev.id,
    sport:           sportKey,
    sportName:       cfg.name,
    sportEmoji:      cfg.emoji,
    home:            mkTeam(home, homeScore, home.winner, 'home'),
    away:            mkTeam(away, awayScore, away.winner, 'away'),
    margin,
    isOT,
    isShootout,
    comebackBonus,
    comebackSignals,
    isComeback:      comebackBonus > 0, // derived flag, kept for display/back-compat
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
    desc:            excitementDesc(closenessMargin, isOT, comebackBonus > 0, cfg),
    date:            ev.date,
    odds,                     // frozen pre-game line for display
    currentLiveActionBuzz,    // 0-100, computed from full WP history; retains last value after game ends
    links:           { espn: espnGamecastUrl(sportKey, ev.id) }, // server-built "cast ↗" link
  };

  // ── Audit snapshot — captures everything that affects the excitement
  // score so a stored game can be replayed and explained later.
  // No-op when AUDIT_ENABLED is false.
  if (AUDIT_ENABLED) {
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
      comeback:   { bonus: comebackBonus, signals: comebackSignals },
      emptyNet:   { home: engHome, away: engAway, closenessMargin },
      upset:      { bonus: upsetBonus, winnerPreGameWP },
      liveAction: {
        current:   currentLiveActionBuzz,
        breakdown: actionRaw,
      },
      statsActivity: statsBonusRecord
        ? { score: statsBonusRecord.score, breakdown: statsBonusRecord.breakdown }
        : null,
      excitement: excitementBreakdown,
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

  // Pre-game by definition, so ESPN's live values are safe to read directly —
  // and worth snapshotting, since this is the last shape we see before tipoff.
  snapshotPregame(ev.id, home, away);

  const mkTeam = (T) => ({
    ...baseTeam(T),
    record: teamRecord(T),
    rank:   teamRank(T),
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

// Number of days ahead (beyond today) to fetch upcoming games for.
// today + UPCOMING_DAYS_AHEAD = a 5-day upcoming window.
const UPCOMING_DAYS_AHEAD = 4;

// Returns date strings spanning yesterday through UPCOMING_DAYS_AHEAD days out.
// The forward range (today … +4) feeds the 5-day upcoming list; today also
// covers live games. Yesterday is kept for the edge case where a game starts
// late and finishes after midnight, so it still carries yesterday's ESPN date.
// Done games older than yesterday come from warmup.js's _doneGames Map —
// we never re-fetch them from ESPN.
//
// Anchored on the ET calendar date (ESPN's scoreboard dates are ET-based, as
// is everything else here). Anchoring on UTC shifted the whole window forward
// every ET evening, silently dropping the "yesterday" coverage.
function getAllDateStrings() {
  const [y, m, d] = etDateString().split('-').map(Number);
  const dates = [];
  for (let i = UPCOMING_DAYS_AHEAD; i >= -1; i--) {
    const dt = new Date(Date.UTC(y, m - 1, d + i));
    dates.push(dt.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}

// Regulation format for the period-clock sports: progress = minutes elapsed /
// total regulation minutes, derived from "MM:SS - Nth" detail strings. CBB
// (halves), MLB (innings), and soccer (match minute) have their own paths in
// estimateProgress below.
const PERIOD_FORMAT = {
  nfl:  { periods: 4, minutes: 15 },
  cfb:  { periods: 4, minutes: 15 },
  nba:  { periods: 4, minutes: 12 },
  wnba: { periods: 4, minutes: 10 },
  wcbb: { periods: 4, minutes: 10 },
  nhl:  { periods: 3, minutes: 20 },
};

const PERIOD_WORDS = ['1st', '2nd', '3rd', '4th'];
function periodFromDetail(detail, maxPeriods) {
  for (let p = 1; p <= maxPeriods; p++) {
    if (detail.includes(PERIOD_WORDS[p - 1])) return p;
  }
  return null;
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

    const fmt = PERIOD_FORMAT[sportKey];
    if (fmt) {
      const per   = periodFromDetail(detail, fmt.periods);
      const mins  = parseMinutes(detail);
      const total = fmt.periods * fmt.minutes;
      if (per && mins !== null && !isIntermission) {
        return Math.min(1.0, ((per - 1) * fmt.minutes + (fmt.minutes - mins)) / total);
      }
      if (per && isIntermission) return Math.min(1.0, (per * fmt.minutes) / total);
      // NHL: "3rd" with no clock, or an intermission with no parsable period,
      // means regulation is effectively over (end of 3rd / before OT).
      if (sportKey === 'nhl' && (detail.includes('3rd') || (!per && isIntermission))) return 1.0;
    }

    if (sportKey === 'cbb') {
      const mins = parseMinutes(detail);
      if (detail.includes('1st half')) return isIntermission ? 0.5 : mins != null ? (20 - mins) / 40 : 0.25;
      if (detail.includes('2nd half')) return isIntermission ? 1.0 : mins != null ? (40 - mins) / 40 : 0.75;
    }

    if (sportKey === 'mlb') {
      const inning = parseInning(detail);
      if (inning) {
        const half = detail.includes('bot') ? 0.5 : 0;
        return Math.min(1.0, (inning - 1 + half) / 9);
      }
    }

    if (isSoccer(sportKey)) {
      const minMatch = detail.match(/(\d+)'/);
      if (minMatch) return Math.min(1.0, parseInt(minMatch[1]) / 90);
      if (isIntermission) return 0.5;
    }
  } catch {}
  return 0.5;
}

// Overall W-L summary, e.g. "53-48" (NHL "W-L-OTL", soccer "W-D-L").
function teamRecord(T) {
  return T.records?.find(r => r.type === 'total')?.summary ?? null;
}

// Poll rank, college leagues only (CFB / CBB / WCBB). ESPN uses 99 as the
// "unranked" sentinel, and some pro leagues (NHL) return a blanket 99 for every
// team while others (NFL, NBA, MLB) omit curatedRank entirely — so 99 and
// missing both collapse to null and nothing renders outside college.
function teamRank(T) {
  const r = T.curatedRank?.current;
  return Number.isFinite(r) && r > 0 && r < 99 ? r : null;
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

// Shootout detector — a penalty shootout (soccer) or hockey SO is a subset of OT
// that earns an extra bonus stacked on top of it. Kept separate from
// OT_KEYWORD_RE so the two bonuses can be reasoned about independently.
const SHOOTOUT_RE = /penalt|pens|shootout/;
function hasShootoutKeyword(detail) {
  return SHOOTOUT_RE.test(detail);
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
