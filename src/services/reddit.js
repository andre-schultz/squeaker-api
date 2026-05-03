import fetch from 'node-fetch';
import { SPORTS, EXCITEMENT_WORDS, BORING_WORDS } from '../config.js';
import { calcBuzz } from './algorithm.js';

const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };

// Main entry — fetch buzz for a game, combining game thread + post-game thread
export async function fetchGameBuzz(game) {
  const { subreddit, home, away, live } = game;

  const searchTerms = [
    `${away.abbr} ${home.abbr}`,
    `${away.name.split(' ').pop()} ${home.name.split(' ').pop()}`,
  ];

  // Find both game thread and post-game thread
  const [gameThread, postThread] = await Promise.all([
    findThread(subreddit, searchTerms, ['game thread']),
    findThread(subreddit, searchTerms, ['post match', 'post-match', 'postgame', 'post game', 'final score']),
  ]);

  if (!gameThread && !postThread) return null;

  // Fetch comments from whichever threads we found
  const [gameComments, postComments] = await Promise.all([
    gameThread  ? fetchComments(gameThread.permalink)  : Promise.resolve([]),
    postThread  ? fetchComments(postThread.permalink)  : Promise.resolve([]),
  ]);

  // Combine all comments, dedupe
  const allComments = [...gameComments, ...postComments];
  const sentiment   = scoreSentiment(allComments);

  // Velocity from game thread (meaningful for live, less so after)
  const now     = Date.now() / 1000;
  const primary = gameThread || postThread;
  const hrs     = Math.max(0.25, (now - primary.created_utc) / 3600);
  const totalComments = (gameThread?.num_comments || 0) + (postThread?.num_comments || 0);
  const velocity      = Math.round(totalComments / hrs);

  const buzz = calcBuzz({
    comments:  totalComments,
    upvotes:   (gameThread?.score || 0) + (postThread?.score || 0),
    velocity,
    sentiment,
    isLive:    live,
  }, findSportCfg(subreddit));

  return {
    buzz,
    comments:   totalComments,
    velocity,
    sentiment,
    threadUrl:  postThread
      ? `https://reddit.com${postThread.permalink}`
      : gameThread
        ? `https://reddit.com${gameThread.permalink}`
        : null,
  };
}

// Find a Reddit thread matching type keywords
async function findThread(subreddit, searchTerms, typeKeywords) {
  for (const term of searchTerms) {
    try {
      const query = `${typeKeywords[0]} ${term}`;
      const url   = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=10&t=week`;
      const res   = await fetch(url, { headers: HEADERS });
      if (!res.ok) continue;
      const data  = await res.json();

      const match = (data.data?.children || []).find(p => {
        const title = p.data.title.toLowerCase();
        const hasType = typeKeywords.some(kw => title.includes(kw));
        const hasTeam = (
          title.includes(home(term)) ||
          title.includes(away(term))
        );
        return hasType && hasTeam;
      });

      if (match) return match.data;
    } catch (e) {
      console.error('Reddit search error:', e.message);
    }
  }
  return null;
}

// Helper to extract team name from search term
function home(term) { return term.split(' ')[1]?.toLowerCase() || ''; }
function away(term) { return term.split(' ')[0]?.toLowerCase() || ''; }

// Fetch top comments from a thread
async function fetchComments(permalink) {
  try {
    const url = `https://www.reddit.com${permalink}.json?limit=150&sort=top`;
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return [];
    const data = await res.json();
    return (data[1]?.data?.children || [])
      .map(c => c.data?.body || '')
      .filter(b => b.length > 5);
  } catch { return []; }
}

// Score sentiment from comment array
function scoreSentiment(comments) {
  if (comments.length === 0) return 50;
  let excited = 0, boring = 0;
  for (const body of comments.slice(0, 100)) {
    const b = body.toLowerCase();
    const isExcited = EXCITEMENT_WORDS.some(w => b.includes(w));
    const isBoring  = BORING_WORDS.some(w => b.includes(w));
    if (isExcited) excited++;
    else if (isBoring) boring++;
  }
  const total = excited + boring;
  if (total === 0) return 50;
  return Math.round((excited / total) * 100);
}

// Match subreddit back to sport config for buzz normalization
function findSportCfg(subreddit) {
  return Object.values(SPORTS).find(s => s.sub === subreddit) || {
    base: { comments: 1000, upvotes: 200, velocity: 200 }
  };
}
