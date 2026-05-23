import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import gamesRouter from './src/routes/games.js';
import { startWarmupSchedule } from './src/services/warmup.js';

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['https://squeaker.app', 'https://www.squeaker.app', 'http://localhost:5173'] }));
app.use(express.json());

function requireApiKey(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next();
  if (req.headers['x-api-key'] !== secret) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Squeaker API' }));

// Routes
app.use('/api/games', requireApiKey, gamesRouter);

app.listen(PORT, () => {
  console.log(`Squeaker API running on port ${PORT}`);
  startWarmupSchedule();
});
