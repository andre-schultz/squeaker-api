import fetch from 'node-fetch';
import { SPORTS, EXCITEMENT_WORDS, BORING_WORDS } from '../config.js';
import { calcBuzz } from './algorithm.js';

const HEADERS = { 'User-Agent': 'Squeaker/1.0 (squeaker.app)' };

export async function fetchGameBuzz(game) {
  const { subreddit, live } = game;

  // Build team name variants for matching
  const homeLast = game.home.name.split(' ').pop().toLowerCase();
  const awayLast = game.away.name.split(' ').pop().toLowerCase();
  const homeFull = game.home.name.toLowerCase();
  const awayFull = game.away.name.toLowerCase();
  const homeAbbr = game.home.abbr.toLowerCase();
  const awayAbbr = game.away.abbr.toLowerCase();

  // Multiple search queries in order of specificity
  const searchTerms = [
    `${awayFull} ${homeFull}`,
    `${awayLast} ${homeLast}`,
    `${awayAbbr} ${homeAbbr}`,
    `${homeFull} ${awayFull}`,
    `${homeLast} ${awayLast}`,
  ];

  // Require BOTH teams to appear in the thread title
  const matchesTeam = (title) =>
    (title.includes(homeLast) || title.includes(homeAbbr) || title.includes(homeFull)) &&
    (title.includes(awayLast) || title.includes(awayAbbr) || title.includes(awayFull));

  // Soccer uses "match thread", others use "game thread"
  const isSoccer = ['mls', 'epl', 'ucl'].includes(game.sport);
  const gameThreadKws = isSoccer ? ['match thread', 'game thread'] : ['game thread'];
  const postGameKws   = isSoccer
    ? ['post match', 'post-match']
    : ['post game thread', 'postgame thread', 'post match', 'post-match', 'final score'];

  // Find both game thread and post-game thread
  const [gameThread, postThread] = await Promise.all([
    findThread(subreddit, searchTerms, gameThreadKws, matchesTeam),
    findThread(subreddit, searchTerms, postGameKws, matchesTeam),
  ]);

  if (!gameThread && !postThread) return null;

  // Fetch comments from whichever threads we found
  const [gameComments, postComments] = await Promise.all([
    gameThread ? fetchComments(gameThread.permalink) : Promise.resolve([]),
    postThread ? fetchComments(postThread.permalink) : Promise.resolve([]),
  ]);

  const allComments   = [...gameComments, ...postComments];
  const sentiment     = scoreSentiment(allComments);

  const now           = Date.now() / 1000;
  const primary       = gameThread || postThread;
  const hrs           = Math.max(0.25, (now - primary.created_utc) / 3600);
  const totalComments = (gameThread?.num_comments || 0) + (postThread?.num_comments || 0);
  const velocity      = Math.round(totalComments / hrs);

  const sportCfg = Object.values(SPORTS).find(s => s.sub === subreddit) ||
    { base: { comments: 1000, upvotes: 200, velocity: 200 } };

  const buzz = calcBuzz({
    comments:  totalComments,
    upvotes:   (gameThread?.score || 0) + (postThread?.score || 0),
    velocity,
    sentiment,
    isLive:    live,
  }, sportCfg);

  return {
    buzz,
    comments:   totalComments,
    velocity,
    sentiment,
    threadUrl:  postThread
      ? `https://reddit.com${postThread.permalink}`
      : `https://reddit.com${gameThread.permalink}`,
  };
}

async function findThread(subreddit, searchTerms, typeKeywords, matchesTeam) {
  for (const term of searchTerms) {
    for (const typeKw of typeKeywords) {
      try {
        const query = `${typeKw} ${term}`;
        const url   = `https://www.reddit.com/r/${subreddit}/search.json?q=${encodeURIComponent(query)}&restrict_sr=1&sort=new&limit=15&t=week`;
        const res   = await fetch(url, { headers: HEADERS });
        if (!res.ok) {
          console.log(`[reddit] HTTP ${res.status} for: ${query}`);
          continue;
        }
        const data  = await res.json();
        const posts = data.data?.children || [];
        console.log(`[reddit] "${query}" → ${posts.length} results`);
        posts.slice(0, 3).forEach(p => console.log(`  - ${p.data.title}`));

        const match = posts.find(p => {
          const title   = p.data.title.toLowerCase();
          const hasType = typeKeywords.some(kw => title.includes(kw));
          return hasType && matchesTeam(title);
        });

        if (match) {
          console.log(`[reddit] ✓ ${match.data.title}`);
          return match.data;
        }
      } catch (e) {
        console.error('[reddit] Error:', e.message);
      }
    }
  }
  console.log(`[reddit] ✗ No thread found in r/${subreddit}`);
  return null;
}

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
