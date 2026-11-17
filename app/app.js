// Beacon: the shell, the router, and the live behaviour. Navigation is hash
// routing with no reloads; data arrives from the ETag cache instantly when it
// can, then refreshes in the background and patches the page in place. The
// header's counter shows the API traffic the cache is saving, live.
//
// Routes:
//   #/                     the live board
//   #/bounty/<slug>        one bounty, with the live board beside it
//   #/leaderboard/<slug>   the virtualized leaderboard
//   #/u/<handle>           a builder's profile
//
// window.__shotReady is false while a page loads and true once its data is on
// screen, so a screenshot script knows when to capture.

import {
  getBounty, getLeaderboardFirst, getOpenBoard, getProfile, getRankings,
  getResolvedBoard, getSubmission, getSWR, onStats, prefetchBounty, stats,
} from './api.js';
import { bytes, num, timeLeft } from './fmt.js';
import {
  boardShell, boardVisible, bountyHTML, bountyShell, entryDetailHTML,
  leaderboardShell, mountLeaderboard, normalizeLeaderboard, paintBoard,
  patchList, profileHTML, sideRowHTML, sortBoard,
} from './views.js';

const mount = document.getElementById('a');
let viewCleanup = () => {};
let boardTimer = 0;

mount.innerHTML = `
  <a class="skip" href="#view">Skip to content</a>
  <header class="top">
    <a class="logo" href="#/">◆ Beacon</a>
    <nav aria-label="Main">
      <a href="#/" data-nav="board">Board</a>
      <span class="find">
        <input id="find-handle" type="search" placeholder="Builder @handle…" aria-label="Find a builder" autocomplete="off">
      </span>
    </nav>
    <p class="counter" id="counter" title="API requests · 304 revalidations · bytes downloaded · bytes saved by the cache"></p>
  </header>
  <main id="view" tabindex="-1"></main>
  <footer>
    <p>Beacon reads make.fun's public API live, in your browser — no account, no tracking.
    <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> clear.
    Data: <a href="https://make.fun/api/openapi.json" target="_blank" rel="noopener">make.fun API</a> · Built for
    <a href="https://make.fun/bounty/makefun-frontend-01" target="_blank" rel="noopener">makefun-frontend-01</a>.</p>
  </footer>
  <div id="live" class="sr-only" aria-live="polite"></div>`;

const view = document.getElementById('view');
const live = document.getElementById('live');
const counterEl = document.getElementById('counter');

function paintCounter() {
  counterEl.textContent = `${stats.requests} req · ${stats.revalidated} cached · ${bytes(stats.bytesDown)} down · ${bytes(stats.bytesSaved)} saved`;
}
let counterQueued = false;
onStats(() => {
  if (counterQueued) return;
  counterQueued = true;
  requestAnimationFrame(() => { counterQueued = false; paintCounter(); });
});
paintCounter();

// Countdowns tick once a second, touching only the countdown text nodes.
setInterval(() => {
  for (const el of document.querySelectorAll('[data-countdown]')) {
    const next = timeLeft(el.dataset.countdown);
    if (el.textContent !== next) el.textContent = next;
  }
}, 1000);

// Prefetch a bounty on hover or keyboard focus, so opening it feels instant.
document.addEventListener('mouseover', (ev) => {
  const link = ev.target.closest('[data-prefetch]');
  if (link) prefetchBounty(link.dataset.prefetch);
});
document.addEventListener('focusin', (ev) => {
  const link = ev.target.closest('[data-prefetch]');
  if (link) prefetchBounty(link.dataset.prefetch);
});

// The header's builder finder routes to a profile on Enter.
document.getElementById('find-handle').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter' && ev.target.value.trim()) {
    location.hash = `#/u/${encodeURIComponent(ev.target.value.trim().replace(/^@/, ''))}`;
    ev.target.value = '';
    ev.target.blur();
  }
});

// Keyboard: / focuses the view's search, j/k walk board rows, Esc clears.
let selIndex = -1;
document.addEventListener('keydown', (ev) => {
  const typing = /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName || '');
  if (ev.key === 'Escape' && typing) {
    document.activeElement.value = '';
    document.activeElement.dispatchEvent(new Event('input', { bubbles: true }));
    document.activeElement.blur();
    return;
  }
  if (typing) return;
  if (ev.key === '/') {
    const q = view.querySelector('#q');
    if (q) { ev.preventDefault(); q.focus(); }
    return;
  }
  if (ev.key !== 'j' && ev.key !== 'k' && ev.key !== 'Enter') return;
  const rows = [...view.querySelectorAll('#rows tr:not([hidden])')];
  if (!rows.length) return;
  if (ev.key === 'Enter' && selIndex >= 0) {
    rows[selIndex]?.querySelector('a')?.click();
    return;
  }
  ev.preventDefault();
  selIndex = ev.key === 'j'
    ? Math.min(selIndex + 1, rows.length - 1)
    : Math.max(selIndex - 1, 0);
  rows.forEach((r, i) => r.classList.toggle('sel', i === selIndex));
  rows[selIndex].scrollIntoView({ block: 'nearest' });
});

function errorHTML(message, retry) {
  return `<div class="error"><h1>Something went wrong</h1><p>${message}</p>
    <p><button class="btn" id="retry">Try again</button> <a class="btn ghost" href="#/">Back to the board</a></p></div>`;
}

function mountError(err, retry) {
  view.innerHTML = errorHTML(String(err.message || err).replace(/</g, '&lt;'));
  document.getElementById('retry').addEventListener('click', retry);
  window.__shotReady = true;
}

function setNav(route) {
  for (const a of document.querySelectorAll('[data-nav]')) {
    a.setAttribute('aria-current', a.dataset.nav === route ? 'page' : 'false');
  }
}

// ------------------------------------------------------------------ board --

async function showBoard() {
  setNav('board');
  selIndex = -1;
  view.innerHTML = boardShell();
  const state = { tab: 'open', q: '', sort: 'deadline' };
  const tbody = view.querySelector('#rows');
  const meta = view.querySelector('#board-meta');
  const empty = view.querySelector('#board-empty');
  let openItems = [];
  let resolvedItems = [];
  let resolvedLoaded = false;
  let resolvedLoading = false;
  const items = () => [...openItems, ...resolvedItems];

  const paint = () => {
    paintBoard(tbody, items(), state);
    const shown = items().filter((b) => boardVisible(b, state.tab, state.q)).length;
    meta.textContent = resolvedLoading && (state.tab === 'resolved' || state.tab === 'all')
      ? 'Loading resolved bounties…'
      : `${shown} of ${items().length} bounties · updated live`;
    empty.hidden = shown !== 0;
  };

  // The open board paints first; the resolved board loads only on demand, so
  // the first paint never waits on the long resolved history.
  const refreshOpen = async () => {
    try {
      openItems = (await getOpenBoard()).map((b) => ({ ...b, status: 'open' }));
      paint();
      window.__shotReady = true;
    } catch (err) {
      if (!openItems.length) mountError(err, refreshOpen);
    }
  };
  const loadResolved = async () => {
    if (resolvedLoaded || resolvedLoading) return;
    resolvedLoading = true;
    paint();
    try {
      resolvedItems = (await getResolvedBoard()).map((b) => ({ ...b, status: 'resolved' }));
      resolvedLoaded = true;
    } catch { /* the open board stays usable; resolved retries on next click */ }
    resolvedLoading = false;
    paint();
  };

  const refreshResolved = async () => {
    if (!resolvedLoaded || resolvedLoading) return;
    resolvedLoading = true;
    try {
      resolvedItems = (await getResolvedBoard()).map((b) => ({ ...b, status: 'resolved' }));
    } catch { /* keep the last good resolved list */ }
    resolvedLoading = false;
    paint();
  };

  refreshOpen();
  boardTimer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    refreshOpen();
    refreshResolved();
  }, 30000);
  viewCleanup = () => clearInterval(boardTimer);

  view.querySelector('#q').addEventListener('input', (ev) => { state.q = ev.target.value; selIndex = -1; paint(); });
  view.querySelector('#sort').addEventListener('change', (ev) => { state.sort = ev.target.value; paint(); });
  for (const tab of view.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const t of view.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      if ((state.tab === 'resolved' || state.tab === 'all') && !resolvedLoaded) loadResolved();
      paint();
    });
  }
  live.textContent = 'Live bounty board';
  document.title = 'Beacon · make.fun bounties';
}

// ----------------------------------------------------------------- bounty --

async function showBounty(slug) {
  setNav('');
  view.innerHTML = bountyShell();
  const detail = view.querySelector('#detail');
  const sideRows = view.querySelector('#side-rows');
  let cancelled = false;
  viewCleanup = () => { cancelled = true; };

  const paintSide = (list) => {
    const others = sortBoard(list.filter((b) => b.slug !== slug), 'deadline').slice(0, 14);
    patchList(sideRows, others, {
      tag: 'div',
      key: (b) => b.slug,
      html: sideRowHTML,
      sig: (b) => [b.title, b.potUsd ?? b.rewardAmount, b.submissionCount].join('|'),
    });
  };

  try {
    const [b, openList] = await Promise.all([
      getSWR(`/competitions/${encodeURIComponent(slug)}`, {
        onFresh: (fresh) => { if (!cancelled && fresh) detail.innerHTML = bountyHTML(fresh); },
      }),
      getOpenBoard().catch(() => []),
    ]);
    if (cancelled) return;
    detail.innerHTML = bountyHTML(b);
    paintSide(openList);
    document.title = `${b.title} · Beacon`;
    live.textContent = b.title;
    window.__shotReady = true;

    // Leaderboard preview: the top 10, beside the detail.
    const preview = detail.querySelector('#lb-preview');
    try {
      const lb = await getLeaderboardFirst(slug);
      if (cancelled) return;
      const top = normalizeLeaderboard(lb, lb.view).slice(0, 10);
      if (top.length) {
        preview.innerHTML = `<h2>Top entries</h2><ol class="top10">${top.map((e) => `
          <li><a href="#/u/${encodeURIComponent(e.handle || '')}">@${String(e.handle || '—').replace(/</g, '&lt;')}</a>
          <span class="t">${String(e.title || '').replace(/</g, '&lt;')}</span>
          <span class="r">#${e.rank ?? '—'}</span></li>`).join('')}</ol>
          <p><a href="#/leaderboard/${encodeURIComponent(slug)}">Full leaderboard →</a></p>`;
      }
    } catch { /* a bounty without a leaderboard yet just shows no preview */ }

    // The sidebar keeps refreshing while the page is open.
    const timer = setInterval(async () => {
      if (cancelled || document.visibilityState !== 'visible') return;
      try {
        paintSide(await getOpenBoard());
      } catch { /* keep the last good sidebar */ }
    }, 30000);
    viewCleanup = () => { cancelled = true; clearInterval(timer); };
  } catch (err) {
    if (!cancelled) mountError(err, () => showBounty(slug));
  }
}

// ------------------------------------------------------------ leaderboard --

async function showLeaderboard(slug) {
  setNav('');
  window.__shotReady = false;
  try {
    const b = await getBounty(slug);
    view.innerHTML = leaderboardShell(b);
    document.title = `Leaderboard · ${b.title} · Beacon`;
    live.textContent = `Leaderboard for ${b.title}`;
    const meta = view.querySelector('#lb-meta');
    const tabs = view.querySelector('#view-tabs');
    const detailBox = view.querySelector('#entry-detail');
    let current = null;
    let cancelled = false;
    viewCleanup = () => { cancelled = true; };

    const load = async (viewName) => {
      const data = await getLeaderboardFirst(slug, viewName);
      if (cancelled) return null;
      const phase = data.phase;
      const rows = normalizeLeaderboard(data, viewName);
      meta.textContent = `${b.title} · ${num(rows.length)} entries · ${phase ? `${phase.title} (${phase.scores} scores)` : ''} · ${data.submission_rule ? `rule: ${data.submission_rule}` : ''}`;
      const views = data.views || ['overall'];
      tabs.innerHTML = views.map((v) => `<button role="tab" data-view="${v}" aria-selected="${String(v === (viewName || data.view))}">${v}</button>`).join('');
      for (const tab of tabs.querySelectorAll('[data-view]')) {
        tab.addEventListener('click', () => { if (!cancelled) showLeaderboardView(tab.dataset.view); });
      }
      return { data, rows };
    };

    const showLeaderboardView = async (viewName) => {
      const loaded = await load(viewName);
      if (!loaded) return;
      if (current) current.setEntries(loaded.rows);
      else {
        current = mountLeaderboard(view, { entries: loaded.rows }, async (entry) => {
          detailBox.innerHTML = entryDetailHTML(entry);
          detailBox.scrollIntoView({ block: 'nearest' });
          // Compact rows fetch their full detail on demand.
          if (entry.compact) {
            try {
              const full = await getSubmission(entry.submission_id);
              const s = full.submission ?? full;
              if (!cancelled && s) {
                detailBox.innerHTML = entryDetailHTML({
                  ...entry, ...s,
                  rank: entry.rank, prize_rank: entry.prize_rank ?? s.prize_rank,
                  values: s.values ?? entry.values,
                });
              }
            } catch { /* the compact card already shows the essentials */ }
          }
        });
        current.render();
      }
      window.__shotReady = true;
    };

    view.querySelector('#q').addEventListener('input', (ev) => current?.setFilter(ev.target.value));
    await showLeaderboardView(null);
  } catch (err) {
    mountError(err, () => showLeaderboard(slug));
  }
}

// ---------------------------------------------------------------- profile --

async function showProfile(handle) {
  setNav('');
  window.__shotReady = false;
  view.innerHTML = '<p>Loading profile…</p>';
  try {
    const [p, rankings] = await Promise.all([
      getProfile(handle),
      getRankings(handle).catch(() => null),
    ]);
    view.innerHTML = profileHTML(p, rankings);
    document.title = `@${p.handle} · Beacon`;
    live.textContent = `Profile of ${p.display_name || p.handle}`;
    window.__shotReady = true;
  } catch (err) {
    view.innerHTML = errorHTML(`No builder named “${handle.replace(/</g, '&lt;')}” was found. Handles are case-sensitive.`, () => {});
    const retry = document.getElementById('retry');
    if (retry) retry.remove();
    window.__shotReady = true;
  }
}

// ----------------------------------------------------------------- router --

async function render() {
  window.__shotReady = false;
  viewCleanup();
  clearInterval(boardTimer);
  const hash = location.hash || '#/';
  const bounty = hash.match(/^#\/bounty\/([^/?#]+)/);
  const leaderboard = hash.match(/^#\/leaderboard\/([^/?#]+)/);
  const profile = hash.match(/^#\/u\/([^/?#]+)/);
  try {
    if (bounty) await showBounty(decodeURIComponent(bounty[1]));
    else if (leaderboard) await showLeaderboard(decodeURIComponent(leaderboard[1]));
    else if (profile) await showProfile(decodeURIComponent(profile[1]));
    else await showBoard();
  } catch (err) {
    mountError(err, render);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
