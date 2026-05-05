import fetch from 'node-fetch';
import { SPORTS, EXCITEMENT_WORDS, BORING_WORDS } from '../config.js';
import { calcBuzz } from './algorithm.js';

const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };
const DELAY   = 1500; // ms between Reddit API calls

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function fetchGameBuzz(game) {
  const { subreddit, live } = game;

  const homeFull = game.home.name.toLowerCase();
  const awayFull = game.away.name.toLowerCase();
  const homeAbbr = game.home.abbr.toLowerCase();
  const awayAbbr = game.away.abbr.toLowerCase();
  const homeLast = game.home.name.split(' ').pop().toLowerCase();
  const awayLast = game.away.name.split(' ').pop().toLowerCase();

  const matchesTeam = (title) =>
    (title.includes(homeLast) || title.includes(homeAbbr) || title.includes(homeFull)) &&
    (title.includes(awayLast) || title.includes(awayAbbr) || title.includes(awayFull));

  const isSoccer = ['mls', 'epl', 'ucl'].includes(game.sport);
  const typeKw   = isSoccer ? 'match thread' : 'game thread';
  const query    = `${typeKw} ${awayFull} ${homeFull}`;

  await sleep(DELAY);
  const thread = await findThread(subreddit, query, typeKw, matchesTeam);
  if (!thread) return null;

  const comments  = await fetchComments(thread.permalink);
  const sentiment = scoreSentiment(comments);

  const now      = Date.now() / 1000;
  const hrs      = Math.max(0.25, (now - thread.created_utc) / 3600);
  const velocity = Math.round((thread.num_comments || 0) / hrs);

  const sportCfg = Object.values(SPORTS).find(s => s.sub === subreddit) ||
    { base: { comments: 1000, upvotes: 200, velocity: 200 } };

  const buzz = calcBuzz({
    comments:  thread.num_comments || 0,
    upvotes:   thread.score || 0,
    velocity,
    sentiment,
    isLive:    live,
  }, sportCfg);

  return {
    buzz,
    comments:  thread.num_comments || 0,
    velocity,
    sentiment,
    threadUrl: `https://reddit.com${thread.permalink}`,
  };
}

async function findThread(subreddit, query, typeKw, matchesTeam) {
  try {
    const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=10&t=week`;
    const res = await fetch(url, { headers: HEADERS });

    if (res.status === 429) {
      console.log(`[reddit] 429 — backing off 10s`);
      await sleep(10000);
      return null;
    }
    if (!res.ok) return null;

    const data  = await res.json();
    const posts = data.data?.children || [];
    console.log(`[reddit] "${query}" → ${posts.length} results`);

    const match = posts.find(p => {
      const title = p.data.title.toLowerCase();
      return title.includes(typeKw) && matchesTeam(title);
    });

    if (match) console.log(`[reddit] ✓ ${match.data.title}`);
    else console.log(`[reddit] ✗ No match in r/${subreddit}`);

    return match?.data || null;
  } catch (e) {
    console.error('[reddit] Error:', e.message);
    return null;
  }
}

async function fetchComments(permalink) {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=100&sort=top`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data[1]?.data?.children || [])
      .map(c => c.data?.body || '')
      .filter(b => b.length > 5);
  } catch { return []; }
}

function scoreSentiment(comments) {
  if (comments.length === 0) return 50;
  let excited = 0, boring = 0;
  for (const body of comments.slice(0, 100)) {
    const b = body.toLowerCase();
    if (EXCITEMENT_WORDS.some(w => b.includes(w))) excited++;
    else if (BORING_WORDS.some(w => b.includes(w))) boring++;
  }
  const total = excited + boring;
  if (total === 0) return 50;
  return Math.round((excited / total) * 100);
}
