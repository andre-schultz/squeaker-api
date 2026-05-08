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

// Strip invisible Unicode formatting/control characters (zero-width spaces,
// bidi controls, BOM). Pasting a handle from Notes/PDFs/web pages can carry
// these along; Bluesky treats them as part of the identifier and rejects the
// login. Also normalize whitespace and lowercase to match Bluesky's handle
// canonicalization.
function sanitizeHandle(h) {
  if (!h) return null;
  return h
    .replace(/[​-‏‪-‮⁠-⁯﻿]/g, '')
    .trim()
    .toLowerCase();
}

const HANDLE = sanitizeHandle(BLUESKY_HANDLE);
const PASSWORD = BLUESKY_APP_PASSWORD; // app passwords use ASCII; don't mangle

// Cooldown after a failed login. If creds are bad, hammering createSession
// gets the account 429-rate-limited within ~13 attempts. Cache the failure
// in-process so the rest of the cycle (and the next few cycles) skips auth
// and falls through to anonymous requests until either creds change or the
// container restarts.
const FAILURE_COOLDOWN_MS = 15 * 60 * 1000; // 15 min
let lastLoginFailureAt = 0;

// Dedup concurrent login/refresh calls so a burst of 401s doesn't fan out
// into N parallel logins (only matters if we ever parallelize the cycle).
let inflight = null;

export function authConfigured() {
  return !!(HANDLE && PASSWORD);
}

// Returns a usable access JWT or null. Pulls from cache first; logs in if
// the cache is empty AND we're not inside a post-failure cooldown window.
export async function getAccessJwt() {
  if (!authConfigured()) return null;
  const cached = await getCache(SESSION_KEY);
  if (cached?.accessJwt) return cached.accessJwt;
  if (Date.now() - lastLoginFailureAt < FAILURE_COOLDOWN_MS) return null;
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
        identifier: HANDLE,
        password: PASSWORD,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[bsky-auth] login failed: HTTP ${res.status} ${body.slice(0, 200)}`);
      // Trip the cooldown on any non-OK response. 401 = bad creds, 429 =
      // we already overshot — both call for backing off, not retrying.
      lastLoginFailureAt = Date.now();
      return null;
    }
    const data = await res.json();
    await persistSession(data);
    console.log(`[bsky-auth] logged in as ${data.handle}`);
    return data.accessJwt;
  } catch (e) {
    console.error(`[bsky-auth] login error: ${e.message}`);
    lastLoginFailureAt = Date.now();
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
