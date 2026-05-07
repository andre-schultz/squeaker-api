// Uses native global fetch (Node 18+). node-fetch v3 was previously implicated
// in a slow memory leak via undici pool retention; native fetch hits the
// same undici layer but without the wrapper.
import { SPORTS, HOURS_WINDOW, AUDIT_ENABLED, REDDIT_ENABLED } from '../config.js';
import { calcExcitement, calcExcitementBreakdown, detectComeback, excitementDesc } from './algorithm.js';
import { recordSnapshot, getTimeline, analyzeMomentum } from './timeline.js';
import {
  recordWPSnapshot,
  analyzeWPDrama,
  analyzeUpset,
  computeLiveActionBuzz,
} from './probabilities.js';
import { getOrFetchOdds } from './odds.js';
import { recordAudit } from './audit.js';
import { getCache } from './cache.js';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports';

// Fetch all games across all sports within the time window
export async function fetchAllGames() {
  const dates = getDateStrings();
  const results = await Promise.all(
    Object.entries(SPORTS).map(([key, cfg]) => fetchSport(key, cfg, dates))
  );
  const seen  = new Set();
  const games = results.flat().filter(g => {
    if (seen.has(g.id)) return false;
    seen.add(g.id);
    return true;
  });
  return games.sort((a, b) => b.excitement - a.excitement);
}

async function fetchSport(key, cfg, dates) {
  const games = [];
  for (const date of dates) {
    try {
      const url = `${BASE}/${cfg.espnSport}/${cfg.espnLeague}/scoreboard${date ? `?dates=${date}` : ''}`;
      const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
      if (!res.ok) {
        // Drain body so the underlying socket is released.
        try { await res.text(); } catch {}
        continue;
      }
      let data = await res.json();
      const events = data.events || [];
      for (const ev of events) {
        const game = await parseEvent(ev, key, cfg);
        if (game) games.push(game);
      }
      // Release the parsed payload before iterating to the next date.
      data = null;
    } catch (e) {
      console.error(`ESPN fetch error [${key}]:`, e.message);
    }
  }
  return games;
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

  const comps = co.competitors || [];
  const home  = comps.find(c => c.homeAway === 'home');
  const away  = comps.find(c => c.homeAway === 'away');
  if (!home || !away) return null;

  const homeScore = parseFloat(home.score) || 0;
  const awayScore = parseFloat(away.score) || 0;
  const margin    = Math.abs(homeScore - awayScore);

  const detail    = (status?.shortDetail || '').toLowerCase();
  const rawDetail = status?.shortDetail || '';

  const isOT = detail.includes('ot') ||
               detail.includes('overtime') ||
               detail.includes('extra time') ||
               detail.includes('penalties') ||
               (sportKey === 'mlb' && /f\/1[0-9]/.test(detail));

  // Game progress (0.0–1.0) — used to weight live excitement scores
  const progress = estimateProgress(sportKey, detail, comps);

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
    live, done,
  };

  // Record score snapshot for momentum tracking
  const timeline = await recordSnapshot(partialGame);

  // Analyze momentum from full scoring timeline
  const { momentumBonus, signals } = analyzeMomentum(timeline, { sport: sportKey });

  // ── Win-probability signal ──────────────────────────────────────────
  // Append to the per-game WP timeline (no-op for soccer / pre-game).
  // Then run sport-windowed drama + upset analysis on the full timeline.
  const wpTimeline = await recordWPSnapshot(partialGame, cfg.espnSport, cfg.espnLeague);
  const { dramaBonus, signals: wpSignals, maxSwing } = analyzeWPDrama(wpTimeline, sportKey);
  const { upsetBonus, winnerPreGameWP } = analyzeUpset(wpTimeline, {
    ...partialGame,
    home: { ...partialGame.home, score: homeScore },
    away: { ...partialGame.away, score: awayScore },
  });

  // ── Frozen odds (one-shot fetch on first sighting, cached for display) ─
  // ESPN's /odds endpoint returns the closing line and doesn't update during
  // live play, so polling is wasted. We grab once and embed on the game.
  const odds = await getOrFetchOdds(ev.id, cfg.espnSport, cfg.espnLeague);

  // ── Live-action score from recent WP volatility ──────────────────────
  // The "betting buzz" replacement: same intent ("game is exciting right
  // now"), free, derived from data we already collect. 0 when not live.
  const liveActionRaw = live ? computeLiveActionBuzz(wpTimeline) : null;
  const liveActionBuzz = liveActionRaw?.score ?? 0;

  // For live games, scale by progress so early-game close scores don't rank too high
  const excitement = calcExcitement(
    margin,
    isOT,
    isComeback,
    cfg,
    momentumBonus,
    live ? progress : 1.0,
    dramaBonus,
    upsetBonus,
  );

  const mkTeam = (T, score, winner) => ({
    name:     T.team.shortDisplayName || T.team.displayName,
    fullName: T.team.displayName,
    abbr:     T.team.abbreviation,
    logo:     T.team.logo,
    color:    T.team.color ? `#${T.team.color}` : '#374151',
    score,
    winner:   !!winner,
  });

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
    wpDramaBonus:    dramaBonus,
    wpDramaSignals:  wpSignals,
    wpMaxSwing:      maxSwing,
    upsetBonus,
    winnerPreGameWP,
    progress,
    gameStage:       rawDetail,
    done,
    live,
    excitement,
    desc:            excitementDesc(margin, isOT, isComeback, cfg),
    date:            ev.date,
    subreddit:       cfg.sub,
    odds,                  // frozen pre-game line for display
    liveActionBuzz,        // 0-100, real-time WP-volatility score
  };

  // ── Audit snapshot — captures everything that affects the excitement
  // score so a stored game can be replayed and explained later.
  // No-op when AUDIT_ENABLED is false.
  //
  // Articles are intentionally NOT in the audit — they don't feed the
  // excitement score. The buzz read only happens when Reddit is on (and
  // therefore there's actual buzz data to capture); skipping it when
  // disabled saves a per-game cache hit each cycle.
  if (AUDIT_ENABLED) {
    const breakdown = calcExcitementBreakdown(
      margin, isOT, isComeback, cfg, momentumBonus,
      live ? progress : 1.0, dramaBonus, upsetBonus,
    );
    const cachedBuzz = REDDIT_ENABLED ? await getCache(`buzz:${ev.id}`) : null;
    await recordAudit(game, {
      momentum:   { bonus: momentumBonus, signals },
      wp:         { bonus: dramaBonus, signals: wpSignals, maxSwing },
      upset:      { bonus: upsetBonus, winnerPreGameWP },
      // Full liveAction breakdown so we can later see exactly which
      // component (totalSwing, max swing, reversals) drove the score.
      liveAction: liveActionRaw,
      buzz:       cachedBuzz
        ? { peak: cachedBuzz.buzz, sentiment: cachedBuzz.sentiment, matchedPosts: cachedBuzz.matchedPosts }
        : null,
      excitement: breakdown,
    });
  }

  return game;
}

// Returns date strings for today and the past 4 days (5 days total)
function getDateStrings() {
  const dates = [];
  for (let i = 0; i <= 4; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().slice(0, 10).replace(/-/g, ''));
  }
  return dates;
}

// Estimates game progress 0.0–1.0 from status detail string
function estimateProgress(sportKey, detail, comps) {
  try {
    if (!detail || detail.includes('final') || detail.includes('ft')) return 1.0;

    // Any overtime / extra time / penalties = full game played
    if (detail.includes('ot') || detail.includes('overtime') ||
        detail.includes('extra time') || detail.includes('penalties') ||
        detail.includes('shootout')) return 1.0;

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
      if (detail.includes('2nd') && isIntermission) return 0.5;
    }

    if (['nba', 'cbb'].includes(sportKey)) {
      const qtr  = detail.includes('1st') ? 1 : detail.includes('2nd') ? 2
                 : detail.includes('3rd') ? 3 : detail.includes('4th') ? 4 : null;
      const mins = parseMinutes(detail);
      if (sportKey === 'nba' && qtr && mins !== null && !isIntermission) {
        return Math.min(1.0, ((qtr - 1) * 12 + (12 - mins)) / 48);
      }
      if (sportKey === 'nba' && qtr && isIntermission) return Math.min(1.0, (qtr * 12) / 48);
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

    if (['mls', 'epl', 'ucl'].includes(sportKey)) {
      const minMatch = detail.match(/(\d+)'/);
      if (minMatch) return Math.min(1.0, parseInt(minMatch[1]) / 90);
      if (isIntermission) return 0.5;
    }
  } catch {}
  return 0.5;
}

function parseMinutes(detail) {
  const m = detail.match(/(\d+):(\d+)/);
  return m ? parseInt(m[1]) + parseInt(m[2]) / 60 : null;
}

function parseInning(detail) {
  const words = ['1st','2nd','3rd','4th','5th','6th','7th','8th','9th','10th','11th','12th'];
  for (let i = 0; i < words.length; i++) {
    if (detail.includes(words[i])) return i + 1;
  }
  return null;
}
