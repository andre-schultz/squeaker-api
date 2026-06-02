import { Redis } from '@upstash/redis';

// Upstash Redis client — credentials from environment variables
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// ── Per-cycle command counters ─────────────────────────────────────────────────
// Tracks GET/SET/DEL counts by key prefix so each cycle can log exactly what
// it touched. Drain with drainCacheCounters() at the end of each cycle.
// Format: { 'GET.timeline': 128, 'SET.games': 2, … }
const _counters = {};

function _track(op, key) {
  // Use the part before the first colon as the prefix (e.g. "timeline" from "timeline:401234")
  const prefix = key.split(':')[0];
  const label  = `${op}.${prefix}`;
  _counters[label] = (_counters[label] || 0) + 1;
}

// Return a snapshot of current counts and reset for the next cycle.
export function drainCacheCounters() {
  const snap = { ..._counters };
  for (const k of Object.keys(_counters)) delete _counters[k];
  return snap;
}

export async function getCache(key) {
  try {
    _track('GET', key);
    const val = await redis.get(key);
    return val || null;
  } catch (e) {
    console.error('Cache GET error:', e.message);
    return null;
  }
}

// Batch GET — fetch many keys in a single round trip via MGET. Returns values
// in the same order as `keys`, with missing keys as null. Lets callers serve a
// per-game collection (e.g. betting for every game) without N separate GETs.
export async function getCacheMany(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return [];
  try {
    keys.forEach(k => _track('GET', k));
    const vals = await redis.mget(...keys);
    return vals.map(v => v || null);
  } catch (e) {
    console.error('Cache MGET error:', e.message);
    return keys.map(() => null);
  }
}

export async function setCache(key, value, ttlSeconds) {
  try {
    _track('SET', key);
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (e) {
    console.error('Cache SET error:', e.message);
  }
}

