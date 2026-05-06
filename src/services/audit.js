// Algorithm audit log. When AUDIT_ENABLED, we capture a snapshot per game
// per cycle of every input the score depended on plus the per-bonus
// breakdown of the final excitement number. Lets us go back days later
// and ask "why did this game score what it did?"
//
// Off by default — flip the AUDIT_ENABLED env var on Railway when actively
// tuning. Existing audit keys naturally TTL out after 3 days.

import { setCache, getCache } from './cache.js';
import { CACHE_TTL, AUDIT_ENABLED } from '../config.js';

const MAX_SNAPSHOTS = 200;

let auditWriteCount = 0;

// Append a snapshot for this game. No-op when AUDIT_ENABLED is false.
// Skips the write if the new snapshot is identical to the previous one
// (common for finished games whose state doesn't change between cycles).
export async function recordAudit(game, signals) {
  if (!AUDIT_ENABLED) return;

  const key = `audit:${game.id}`;
  const existing = (await getCache(key)) || [];

  const snap = {
    t: Date.now(),
    game: {
      sport:     game.sport,
      home:      game.home.abbr,
      away:      game.away.abbr,
      homeScore: game.home.score,
      awayScore: game.away.score,
      margin:    game.margin,
      isOT:      game.isOT,
      progress:  game.progress,
      gameStage: game.gameStage,
      live:      game.live,
      done:      game.done,
    },
    signals,
  };

  // Dedup against last entry, ignoring the timestamp
  const last = existing[existing.length - 1];
  if (last && deepEqualIgnoringTime(last, snap)) return;

  existing.push(snap);
  if (existing.length > MAX_SNAPSHOTS) {
    existing.splice(0, existing.length - MAX_SNAPSHOTS);
  }
  await setCache(key, existing, CACHE_TTL.audit);
  auditWriteCount++;
  // Log every 100th write so we can see audit is alive without spamming.
  if (auditWriteCount % 100 === 1) {
    console.log(`[audit] ${auditWriteCount} snapshots written (latest: ${game.away.abbr} vs ${game.home.abbr})`);
  }
}

export async function getAudit(gameId) {
  return (await getCache(`audit:${gameId}`)) || [];
}

function deepEqualIgnoringTime(a, b) {
  // Stringify with timestamps zeroed; cheap and good enough for dedup.
  return JSON.stringify({ ...a, t: 0 }) === JSON.stringify({ ...b, t: 0 });
}
