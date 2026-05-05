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

  // Use short names for the search query (better Reddit search results)
  // but match against all name variants for accuracy
  const isSoccer = ['mls', 'epl', 'ucl'].includes(game.sport);
  const typeKw   = isSoccer ? 'match thread' : 'game thread';
  const query    = `${typeKw} ${awayLast} ${homeLast}`;

  await sleep(DELAY);
  const thread = await findThread(subreddit, query, typeKw, matchesTeam, game.date);
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

async function findThread(subreddit, query, typeKw, matchesTeam, gameDate) {
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

    // Game window: thread must be created within 1 hour before
    // game start and up to 5 hours after (covers long games/OT)
    const gameStart  = new Date(gameDate).getTime() / 1000;
    const windowStart = gameStart - 3600;      // 1 hour before tipoff
    const windowEnd   = gameStart + 18000;     // 5 hours after tipoff

    const match = posts.find(p => {
      const title   = p.data.title.toLowerCase();
      const created = p.data.created_utc;
      const inWindow = created >= windowStart && created <= windowEnd;
      const hasType  = title.includes(typeKw);
      const hasTeam  = matchesTeam(title);
      return inWindow && hasType && hasTeam;
    });

    if (match) {
      console.log(`[reddit] ✓ ${match.data.title}`);
    } else {
      // Log why we didn't match — useful for debugging
      const timeMatches = posts.filter(p =>
        p.data.created_utc >= windowStart && p.data.created_utc <= windowEnd
      );
      console.log(`[reddit] ✗ No match (${timeMatches.length}/${posts.length} in time window)`);
    }

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
