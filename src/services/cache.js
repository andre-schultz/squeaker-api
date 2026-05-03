import { Redis } from '@upstash/redis';

// Upstash Redis client — credentials from environment variables
const redis = new Redis({
  url:   process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export async function getCache(key) {
  try {
    const val = await redis.get(key);
    return val || null;
  } catch (e) {
    console.error('Cache GET error:', e.message);
    return null;
  }
}

export async function setCache(key, value, ttlSeconds) {
  try {
    await redis.set(key, value, { ex: ttlSeconds });
  } catch (e) {
    console.error('Cache SET error:', e.message);
  }
}

export async function deleteCache(key) {
  try {
    await redis.del(key);
  } catch (e) {
    console.error('Cache DEL error:', e.message);
  }
}
