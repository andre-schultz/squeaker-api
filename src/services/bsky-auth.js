// Bluesky session management. Logs in with an app password to get an
// access/refresh JWT pair, caches both in Upstash so a container restart
// doesn't trigger a fresh login. Callers ask for the access JWT; on a 401
// they ask for a refreshed one. No proactive expiry checking — we let
// failed requests drive renewal, which keeps the logic simple and resets
// itself if a token gets invalidated server-side.
//
// Falls back gracefully when creds aren't configured: every getter returns
// null, callers send unauthenticated requests, behavior matches the prior
// code path.

import { getCache, setCache } from './cache.js';
import { BLUESKY_HANDLE, BLUESKY_APP_PASSWORD } from '../config.js';

const PDS = 'https://bsky.social/xrpc';
const SESSION_KEY = 'bsky:session';
const SESSION_TTL = 7 * 24 * 3600; // 7 days — refresh JWT lives this long

// Dedup concurrent login/refresh calls so a burst of 401s doesn't fan out
// into N parallel logins (only matters if we ever parallelize the cycle).
let inflight = null;

export function authConfigured() {
  return !!(BLUESKY_HANDLE && BLUESKY_APP_PASSWORD);
}

// Returns a usable access JWT or null. Pulls from cache first; logs in if
// the cache is empty.
export async function getAccessJwt() {
  if (!authConfigured()) return null;
  const cached = await getCache(SESSION_KEY);
  if (cached?.accessJwt) return cached.accessJwt;
  return await login();
}

// Forces renewal: tries the refresh token first (cheap, no password), falls
// back to a full login if that fails (token revoked, expired past refresh
// window, etc.). Returns the new access JWT or null.
export async function refreshAccessJwt() {
  if (!authConfigured()) return null;
  const cached = await getCache(SESSION_KEY);
  if (cached?.refreshJwt) {
    const refreshed = await tryRefresh(cached.refreshJwt);
    if (refreshed) return refreshed;
  }
  return await login();
}

// ── Internals ────────────────────────────────────────────────────────────────

async function login() {
  if (inflight) return inflight;
  inflight = doLogin().finally(() => { inflight = null; });
  return inflight;
}

async function doLogin() {
  try {
    const res = await fetch(`${PDS}/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        identifier: BLUESKY_HANDLE,
        password: BLUESKY_APP_PASSWORD,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[bsky-auth] login failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      return null;
    }
    const data = await res.json();
    await persistSession(data);
    console.log(`[bsky-auth] logged in as ${data.handle}`);
    return data.accessJwt;
  } catch (e) {
    console.error(`[bsky-auth] login error: ${e.message}`);
    return null;
  }
}

async function tryRefresh(refreshJwt) {
  try {
    const res = await fetch(`${PDS}/com.atproto.server.refreshSession`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${refreshJwt}` },
    });
    if (!res.ok) {
      console.warn(`[bsky-auth] refresh failed: HTTP ${res.status} — falling back to full login`);
      return null;
    }
    const data = await res.json();
    await persistSession(data);
    console.log(`[bsky-auth] refreshed session for ${data.handle}`);
    return data.accessJwt;
  } catch (e) {
    console.error(`[bsky-auth] refresh error: ${e.message}`);
    return null;
  }
}

async function persistSession(data) {
  await setCache(
    SESSION_KEY,
    {
      accessJwt:  data.accessJwt,
      refreshJwt: data.refreshJwt,
      did:        data.did,
      handle:     data.handle,
    },
    SESSION_TTL
  );
}
