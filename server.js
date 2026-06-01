import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { Ratelimit } from '@upstash/ratelimit';
import { Redis } from '@upstash/redis';
import gamesRouter from './src/routes/games.js';
import metaRouter from './src/routes/meta.js';
import { startWarmupSchedule } from './src/services/warmup.js';

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['https://squeaker.app', 'https://www.squeaker.app', 'http://localhost:5173'] }));
app.use(express.json());

// 60 requests per minute per IP — invisible to real users, blocks scrapers
const ratelimit = process.env.UPSTASH_REDIS_REST_URL
  ? new Ratelimit({
      redis: new Redis({
        url:   process.env.UPSTASH_REDIS_REST_URL,
        token: process.env.UPSTASH_REDIS_REST_TOKEN,
      }),
      limiter: Ratelimit.slidingWindow(60, '1 m'),
      prefix: 'rl',
    })
  : null;

function requireApiKey(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  if (req.headers['x-api-key'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

async function applyRateLimit(req, res, next) {
  if (!ratelimit) return next();
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const { success, limit, remaining, reset } = await ratelimit.limit(ip);
  res.setHeader('X-RateLimit-Limit',     limit);
  res.setHeader('X-RateLimit-Remaining', remaining);
  res.setHeader('X-RateLimit-Reset',     reset);
  if (!success) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
  next();
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Squeaker API' }));

// Routes
app.use('/api/games', requireApiKey, applyRateLimit, gamesRouter);
// /api/leagues, /api/teams, /api/teams/search
app.use('/api', requireApiKey, applyRateLimit, metaRouter);

app.listen(PORT, () => {
  console.log(`Squeaker API running on port ${PORT}`);
  startWarmupSchedule();
});
