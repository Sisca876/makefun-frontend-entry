// make.fun's public API: read-only GETs, open to any origin (CORS). Every call
// goes through an ETag cache: a stored ETag is revalidated with If-None-Match,
// a 304 answers from the cache without a byte of body, and entries persist in
// localStorage so a return visit renders instantly and then refreshes in the
// background (stale-while-revalidate). The header's live counter reads the
// stats this module keeps: requests, 304s, bytes downloaded, bytes saved.

const API = 'https://make.fun/api';
const STORE_KEY = 'beacon-cache-v1';
const MAX_STORE_ENTRIES = 60;

export const stats = { requests: 0, revalidated: 0, cached: 0, bytesDown: 0, bytesSaved: 0 };

/** Rows the current view keeps in memory vs rows actually drawn in the DOM. */
export const viewStats = { kept: 0, drawn: 0 };
export function setViewStats(kept, drawn) {
  viewStats.kept = kept;
  viewStats.drawn = drawn;
  emit();
}
const listeners = new Set();
export const onStats = (fn) => listeners.add(fn);
const emit = () => listeners.forEach((fn) => fn(stats));

/** path -> { etag, body (parsed JSON), at } */
const cache = new Map();
try {
  const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '[]');
  for (const [path, entry] of saved) cache.set(path, entry);
} catch { /* a corrupt store just means a cold start */ }

function persist() {
  try {
    const entries = [...cache.entries()].slice(-MAX_STORE_ENTRIES);
    localStorage.setItem(STORE_KEY, JSON.stringify(entries));
  } catch { /* storage full or unavailable: the memory cache still works */ }
}

/** The cached body for a path, if any, with its age in ms. */
export function peek(path) {
  const entry = cache.get(path);
  return entry ? { data: entry.body, age: Date.now() - entry.at } : null;
}

async function request(path, { signal } = {}) {
  const entry = cache.get(path);
  const headers = {};
  if (entry?.etag) headers['If-None-Match'] = entry.etag;
  stats.requests += 1;
  let res;
  try {
    res = await fetch(API + path, { headers, signal });
  } catch (err) {
    // The network failed (offline, a dropped revalidation, a blocked
    // preflight): serve the cached body instead of failing the page. Only a
    // cold start with no cache at all still throws.
    if (entry) {
      stats.cached += 1;
      stats.bytesSaved += entry.bytes || 0;
      emit();
      return entry.body;
    }
    throw err;
  }
  if (res.status === 304 && entry) {
    stats.revalidated += 1;
    stats.cached += 1;
    stats.bytesSaved += entry.bytes || 0;
    entry.at = Date.now();
    emit();
    return entry.body;
  }
  if (!res.ok) throw new Error(`make.fun API ${res.status} for ${path}`);
  const text = await res.text();
  stats.bytesDown += text.length;
  const body = JSON.parse(text);
  cache.set(path, { etag: res.headers.get('ETag'), body, bytes: text.length, at: Date.now() });
  persist();
  emit();
  return body;
}

/** GET with revalidation. A cached body is returned on 304; fresh JSON otherwise. */
export const get = (path, opts) => request(path, opts);

/** GET that prefers a fresh-enough cached body and revalidates in the background. */
export async function getSWR(path, { maxAge = 30000, onFresh } = {}) {
  const hit = peek(path);
  if (hit && hit.age < maxAge) {
    stats.cached += 1;
    emit();
    request(path).then(onFresh, () => {}); // background refresh; the UI patches in place
    return hit.data;
  }
  return request(path);
}

/** All pages of a cursor-paginated list endpoint, concatenated. */
export async function getAll(path) {
  const items = [];
  let cursor = null;
  do {
    const page = await get(path + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''));
    items.push(...(page.items ?? []));
    cursor = page.next_cursor ?? null;
  } while (cursor);
  return items;
}

/** The open board: every open bounty. Small, fast, painted first. */
export const getOpenBoard = () => getAll('/competitions?status=open&activity=times');

/** The resolved board: fetched lazily, only when the user asks for it. */
export const getResolvedBoard = () => getAll('/competitions?status=resolved&activity=times');

/** The board: every open bounty, then every resolved one, in two cached sweeps. */
export const getBoard = async () => {
  const [open, resolved] = await Promise.all([getOpenBoard(), getResolvedBoard()]);
  return { open, resolved };
};

export const getBounty = (slug) => get(`/competitions/${encodeURIComponent(slug)}`);
export const getLeaderboard = (slug, view) =>
  get(`/competitions/${encodeURIComponent(slug)}/leaderboard${view ? `?view=${view}` : ''}`);

/**
 * The leaderboard's compact form: the top 10 in full plus every other entry in
 * a slim shape (rank, handle, title, score, interval) — about a seventh of the
 * full payload. Rows render from this; a selected row's full detail loads
 * on demand from /api/submissions/{id}.
 */
export const getLeaderboardFirst = (slug, view) =>
  get(`/competitions/${encodeURIComponent(slug)}/leaderboard?rows=first${view ? `&view=${view}` : ''}`);
export const getSubmission = (id) => get(`/submissions/${encodeURIComponent(id)}`);
export const getResults = (slug) => get(`/competitions/${encodeURIComponent(slug)}/results`);
export const getProfile = (handle) => get(`/profiles/${encodeURIComponent(handle)}`);
export const getRankings = (handle) => get(`/rankings/${encodeURIComponent(handle)}`);

/** Warm the cache for a bounty page before the user opens it (hover/focus). */
export function prefetchBounty(slug) {
  const path = `/competitions/${encodeURIComponent(slug)}`;
  if (!peek(path)) request(path).catch(() => {});
}
