import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import gamesRouter from './src/routes/games.js';

const app  = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: ['https://squeaker.app', 'https://www.squeaker.app', 'http://localhost:5173'] }));
app.use(express.json());

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'Squeaker API' }));

// Routes
app.use('/api/games', gamesRouter);

app.listen(PORT, () => console.log(`Squeaker API running on port ${PORT}`));
