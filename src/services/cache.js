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

export async function setCache(key, value, ttlSeconds) {
  try {
    _track('SET', key);
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (e) {
    console.error('Cache SET error:', e.message);
  }
}

export async function deleteCache(key) {
  try {
    _track('DEL', key);
    await redis.del(key);
  } catch (e) {
    console.error('Cache DEL error:', e.message);
  }
}
