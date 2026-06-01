// Team rosters + logos, sourced dynamically from ESPN's own teams API and cached
// in Redis. Nothing about teams is hardcoded here — adding a league to SPORTS in
// config.js is enough for /api/teams?league=<key> to start serving it, logos and
// all. ESPN already returns a CDN logo URL per team, so the clients never build
// logo URLs themselves.
import { SPORTS } from '../config.js';
import { getCache, setCache } from './cache.js';

const BASE          = 'https://site.api.espn.com/apis/site/v2/sports';
const STANDINGS_BASE = 'https://site.web.api.espn.com/apis/v2/sports';
const TEAMS_TTL     = 24 * 3600; // rosters change rarely — refresh daily

const team = t => ({
  n:    t?.shortDisplayName || t?.name || t?.displayName || '',
  abbr: t?.abbreviation || '',
  id:   t?.id || null,
  logo: t?.logos?.[0]?.href || null,
});
const valid    = t => t.n && (t.abbr || t.id);
const byName   = (a, b) => a.n.localeCompare(b.n);

// ── Conference-grouped leagues (college) ──────────────────────────────────────
// One standings call returns every conference and its teams for the league's
// division (FBS / D-I), so a 700+ all-divisions roster collapses to ~12–18 teams
// per conference. Cached as a single object: { conferences, teamsByConf, all }.
async function getCollegeData(key) {
  const cfg = SPORTS[key];
  const cacheKey = `college:${key}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  const empty = { conferences: [], teamsByConf: {}, all: [] };
  try {
    const url = `${STANDINGS_BASE}/${cfg.espnSport}/${cfg.espnLeague}/standings?level=${cfg.conference.level}`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
    if (!res.ok) { try { await res.text(); } catch {} return empty; }
    const data = await res.json();

    const conferences = [];
    const teamsByConf = {};
    const all         = [];
    for (const c of data.children || []) {
      const teams = (c.standings?.entries || []).map(e => team(e.team)).filter(valid).sort(byName);
      if (!teams.length) continue;
      const id = String(c.id);
      conferences.push({ id, name: c.name || c.shortName });
      teamsByConf[id] = teams;
      all.push(...teams);
    }
    conferences.sort((a, b) => a.name.localeCompare(b.name));
    const out = { conferences, teamsByConf, all: all.sort(byName) };
    if (conferences.length) await setCache(cacheKey, out, TEAMS_TTL);
    return out;
  } catch (e) {
    console.error(`college standings error [${key}]:`, e.message);
    return empty;
  }
}

// Conferences for a league — [{ id, name }]. Empty for non-college leagues.
export async function getConferences(key) {
  const cfg = SPORTS[key];
  if (!cfg) return null;
  if (!cfg.conference) return [];
  return (await getCollegeData(key)).conferences;
}

// One league's teams, sorted by name. For college leagues a `conference` id
// narrows to that conference; omitting it returns the whole division (used by
// the cross-league search index). Returns null for an unknown league key.
export async function getTeamsForLeague(key, conference) {
  const cfg = SPORTS[key];
  if (!cfg) return null;

  if (cfg.conference) {
    const data = await getCollegeData(key);
    return conference ? (data.teamsByConf[String(conference)] || []) : data.all;
  }

  const cacheKey = `teams:${key}`;
  const cached = await getCache(cacheKey);
  if (cached) return cached;

  try {
    const url = `${BASE}/${cfg.espnSport}/${cfg.espnLeague}/teams?limit=1000`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Squeaker/1.0' } });
    if (!res.ok) { try { await res.text(); } catch {} return []; }
    const data  = await res.json();
    const teams = (data?.sports?.[0]?.leagues?.[0]?.teams || []).map(x => team(x.team)).filter(valid).sort(byName);
    if (teams.length) await setCache(cacheKey, teams, TEAMS_TTL);
    return teams;
  } catch (e) {
    console.error(`teams fetch error [${key}]:`, e.message);
    return [];
  }
}

// Cross-league name search. Backed by a once-per-day combined index so a search
// never fans out a fetch per league on the hot path.
export async function searchTeams(q) {
  const query = (q || '').trim().toLowerCase();
  if (query.length < 2) return [];
  const index = await getTeamsIndex();
  return index.filter(t => t.n.toLowerCase().includes(query)).slice(0, 50);
}

async function getTeamsIndex() {
  const cached = await getCache('teams:index');
  if (cached) return cached;

  const all = [];
  for (const key of Object.keys(SPORTS)) {
    const teams = await getTeamsForLeague(key); // each is itself cached
    for (const t of teams || []) all.push({ ...t, sport: key });
  }
  if (all.length) await setCache('teams:index', all, TEAMS_TTL);
  return all;
}
