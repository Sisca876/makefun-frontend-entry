// Beacon: the shell, the router, and the live behaviour. Navigation is hash
// routing with no reloads; data arrives from the ETag cache instantly when it
// can, then refreshes in the background and patches the page in place. The
// header's counter shows the API traffic the cache is saving, live.
//
// Routes:
//   #/                     the split board: list beside the selected bounty
//   #/board                the full board as one table
//   #/bounty/<slug>        the split board with a bounty selected
//   #/leaderboard/<slug>   the virtualized leaderboard
//   #/u/<handle>           a builder's profile
//   #/saved                starred bounties, kept in this browser
//
// window.__shotReady is false while a page loads and true once its data is on
// screen, so a screenshot script knows when to capture.

import {
  getBoard, getBounty, getLeaderboardFirst, getOpenBoard, getProfile, getRankings,
  getResolvedBoard, getSubmission, onStats, prefetchBounty, setViewStats, stats, viewStats,
} from './api.js';
import { bytes, num, timeLeft } from './fmt.js';
import {
  boardShell, boardVisible, bountyDetailHTML, categoryChipsHTML, entryDetailHTML,
  isSaved, leaderboardPaneHTML, leaderboardPreviewHTML, leaderboardShell, mountLeaderboard,
  normalizeLeaderboard, onSavedChange, paintBoard, paintSplitList, profileHTML, savedShell,
  sortBoard, splitShell, statsStripHTML, tickerHTML, toggleSaved,
} from './views.js';

const mount = document.getElementById('a');
let viewCleanup = () => {};
let boardTimer = 0;

mount.innerHTML = `
  <a class="skip" href="#view">Skip to content</a>
  <header class="top">
    <a class="logo" href="#/"><span class="mark">◆</span> Beacon</a>
    <nav aria-label="Main">
      <a href="#/" data-nav="board">Board</a>
      <a href="#/saved" data-nav="saved">Saved</a>
      <span class="find">
        <input id="find-handle" type="search" placeholder="Builder @handle…" aria-label="Find a builder" autocomplete="off">
      </span>
    </nav>
    <button class="theme-btn" id="theme-btn" aria-label="Switch to light theme" title="Theme">☾</button>
    <p class="counter" id="counter" title="API requests · 304 revalidations · bytes downloaded · bytes saved by the cache"></p>
  </header>
  <main id="view" tabindex="-1"></main>
  <footer>
    <p>Beacon reads make.fun's public API live, in your browser — no account, no tracking.
    <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>Enter</kbd> open · <kbd>Esc</kbd> clear.
    Data: <a href="https://make.fun/api/openapi.json" target="_blank" rel="noopener">make.fun API</a> · Built for
    <a href="https://make.fun/bounty/makefun-frontend-01" target="_blank" rel="noopener">makefun-frontend-01</a>.</p>
    <p id="view-stats" class="view-stats"></p>
  </footer>
  <div id="live" class="sr-only" aria-live="polite"></div>`;

const view = document.getElementById('view');
const live = document.getElementById('live');
const counterEl = document.getElementById('counter');
const viewStatsEl = document.getElementById('view-stats');

// ---- theme: dark by default, light on request, remembered in this browser.
// The early bootstrap in m.js already set data-theme before the stylesheet
// arrived; here the toggle takes over, and the shell's inline dark background
// is cleared so the stylesheet's variables decide from now on.
const THEME_KEY = 'beacon-theme';
const themeBtn = document.getElementById('theme-btn');
function applyTheme(theme, { persist = true } = {}) {
  const light = theme === 'light';
  document.documentElement.dataset.theme = light ? 'light' : 'dark';
  document.body.style.background = '';
  document.body.style.color = '';
  themeBtn.textContent = light ? '☀' : '☾';
  themeBtn.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  if (persist) { try { localStorage.setItem(THEME_KEY, light ? 'light' : 'dark'); } catch { /* private mode */ } }
}
let storedTheme = 'dark';
try { storedTheme = localStorage.getItem(THEME_KEY) || 'dark'; } catch { /* private mode */ }
applyTheme(storedTheme, { persist: false });
themeBtn.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light');
});

// ---- stars: one capture-phase handler owns every [data-star] toggle, so a
// star inside a row link never also opens the row. Views repaint their lists
// on change; this sync keeps every visible star's glyph in step at once.
function syncStars(slug) {
  const saved = isSaved(slug);
  for (const el of document.querySelectorAll(`[data-star="${CSS.escape(slug)}"]`)) {
    el.setAttribute('aria-pressed', String(saved));
    el.classList.toggle('saved', saved);
    el.textContent = el.classList.contains('save-btn') ? (saved ? '★ Saved' : '☆ Save') : (saved ? '★' : '☆');
    el.setAttribute('aria-label', saved ? 'Remove from saved bounties' : 'Save this bounty');
  }
}
onSavedChange((slug) => syncStars(slug));
document.addEventListener('click', (ev) => {
  const star = ev.target.closest?.('[data-star]');
  if (!star) return;
  ev.preventDefault();
  ev.stopPropagation();
  toggleSaved(star.dataset.star);
}, true);
document.addEventListener('keydown', (ev) => {
  const star = ev.target.closest?.('[data-star]');
  if (!star || star.tagName === 'BUTTON') return; // buttons fire click natively
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    ev.stopPropagation();
    toggleSaved(star.dataset.star);
  }
}, true);

function paintCounter() {
  counterEl.textContent = `${stats.requests} req · ${stats.revalidated} 304 · ${bytes(stats.bytesDown)} down · ${bytes(stats.bytesSaved)} saved`;
  viewStatsEl.textContent = `This view: ${num(stats.requests)} API requests · ${num(stats.revalidated)} unchanged (304) · ${num(stats.cached)} from cache · ${num(viewStats.kept)} rows kept, ${num(viewStats.drawn)} drawn — 465 B first load · ETag cache · rows patched in place · virtual leaderboard`;
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
  for (const el of document.querySelectorAll('[data-countdown-short]')) {
    const next = timeLeft(el.dataset.countdownShort).replace(/ left$/, '');
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
  const rows = [...view.querySelectorAll('#rows tr:not([hidden]), #split-rows .srow:not([hidden])')];
  if (!rows.length) return;
  if (ev.key === 'Enter' && selIndex >= 0) {
    const el = rows[selIndex];
    if (el) (el.matches('a') ? el : el.querySelector('a'))?.click();
    return;
  }
  ev.preventDefault();
  selIndex = ev.key === 'j'
    ? Math.min(selIndex + 1, rows.length - 1)
    : Math.max(selIndex - 1, 0);
  rows.forEach((r, i) => r.classList.toggle('kb', i === selIndex));
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
    setViewStats(items().length, shown);
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
  const unsubSaved = onSavedChange(() => paint());
  viewCleanup = () => { clearInterval(boardTimer); unsubSaved(); };

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

// -------------------------------------------------------------- split ----
// The default page: the bounty list on the left, the selected bounty beside
// it. Clicking a row swaps the detail pane in place — the list, its scroll
// position, and the filters all survive.

async function showSplit(slug) {
  setNav('board');
  selIndex = -1;
  view.innerHTML = splitShell();
  const state = { tab: 'open', q: '', sort: 'deadline', category: '', fee: 'any' };
  const rowsEl = view.querySelector('#split-rows');
  const meta = view.querySelector('#split-meta');
  const empty = view.querySelector('#split-empty');
  const chipsEl = view.querySelector('#cat-chips');
  const statsEl = view.querySelector('#split-stats');
  const tickerSlot = view.querySelector('#ticker-slot');
  const detail = view.querySelector('#detail');
  let openItems = [];
  let resolvedItems = [];
  let resolvedLoaded = false;
  let resolvedLoading = false;
  let selected = slug || '';
  let detailToken = 0;
  let chipsSig = '';
  let cancelled = false;
  const unsubSaved = onSavedChange(() => { if (!cancelled) paint(); });
  viewCleanup = () => { cancelled = true; unsubSaved(); };
  const items = () => [...openItems, ...resolvedItems];

  const paint = () => {
    const { kept, drawn } = paintSplitList(rowsEl, items(), state, selected);
    setViewStats(kept, drawn);
    meta.textContent = resolvedLoading && (state.tab === 'resolved' || state.tab === 'all')
      ? 'Loading resolved bounties…'
      : `${num(drawn)} shown · ${num(items().length)} loaded`;
    empty.hidden = drawn !== 0;
    const sig = [...new Set(items().map((b) => b.category).filter(Boolean))].sort().join('|');
    if (sig !== chipsSig) {
      chipsSig = sig;
      chipsEl.innerHTML = categoryChipsHTML(items(), state.category);
      for (const btn of chipsEl.querySelectorAll('.chipbtn')) {
        btn.addEventListener('click', () => { state.category = btn.dataset.cat; paint(); });
      }
    } else {
      for (const btn of chipsEl.querySelectorAll('.chipbtn')) {
        btn.setAttribute('aria-pressed', String(btn.dataset.cat === state.category));
      }
    }
  };

  const paintStats = () => {
    const open = items().filter((b) => b.status === 'open');
    statsEl.innerHTML = statsStripHTML(open);
    tickerSlot.innerHTML = tickerHTML(open);
  };

  const selectBounty = async (next, { replace = false } = {}) => {
    if (!next) return;
    selected = next;
    for (const row of rowsEl.children) {
      const isSel = row.dataset.slug === next;
      row.classList.toggle('sel', isSel);
      if (isSel) row.setAttribute('aria-current', 'true');
      else row.removeAttribute('aria-current');
    }
    if (replace) history.replaceState(null, '', `#/bounty/${encodeURIComponent(next)}`);
    const token = ++detailToken;
    try {
      const b = await getBounty(next);
      if (cancelled || token !== detailToken) return;
      detail.innerHTML = bountyDetailHTML(b);
      document.title = `${b.title} · Beacon`;
      live.textContent = b.title;
      // Overview / Leaderboard tabs: the leaderboard mounts lazily, once, and
      // is re-rendered when its tab is shown again (it has no size while hidden).
      const tabs = detail.querySelectorAll('[data-ptab]');
      const overview = detail.querySelector('#pane-overview');
      const lbPane = detail.querySelector('#pane-leaderboard');
      let lbCtl = null;
      let lbLoading = false;
      const openLbTab = async () => {
        if (lbCtl) { lbCtl.render(); return; }
        if (lbLoading) return;
        lbLoading = true;
        lbPane.innerHTML = '<p class="hint">Loading leaderboard…</p>';
        try {
          const data = await getLeaderboardFirst(next);
          if (cancelled || token !== detailToken) return;
          lbPane.innerHTML = leaderboardPaneHTML(b);
          lbCtl = wirePaneLeaderboard(lbPane, next, data, () => !cancelled && token === detailToken);
          lbCtl.render();
        } catch {
          if (!cancelled && token === detailToken) lbPane.innerHTML = '<p class="hint">Could not load the leaderboard.</p>';
        } finally { lbLoading = false; }
      };
      for (const tab of tabs) {
        tab.addEventListener('click', () => {
          const toLb = tab.dataset.ptab === 'leaderboard';
          for (const t of tabs) t.setAttribute('aria-selected', String(t === tab));
          overview.hidden = toLb;
          lbPane.hidden = !toLb;
          if (toLb) openLbTab();
        });
      }
      // Leaderboard preview: the top 5, beside the rewards table.
      try {
        const lb = await getLeaderboardFirst(next);
        if (cancelled || token !== detailToken) return;
        const top = normalizeLeaderboard(lb, lb.view);
        const slot = detail.querySelector('#lb-preview');
        if (slot) slot.innerHTML = leaderboardPreviewHTML(top, b, next);
      } catch { /* the preview is a bonus; the bounty stands without it */ }
      if (!cancelled && token === detailToken) window.__shotReady = true;
    } catch (err) {
      if (cancelled || token !== detailToken) return;
      detail.innerHTML = errorHTML(`Could not load “${next.replace(/</g, '&lt;')}”.`, () => {});
      const retry = detail.querySelector('#retry');
      if (retry) retry.addEventListener('click', () => selectBounty(next));
      window.__shotReady = true;
    }
  };

  const refreshOpen = async () => {
    try {
      openItems = (await getOpenBoard()).map((b) => ({ ...b, status: 'open' }));
      if (cancelled) return;
      paintStats();
      paint();
    } catch (err) {
      if (!openItems.length && !cancelled) {
        detail.innerHTML = errorHTML('Could not load the bounty board.', () => {});
        window.__shotReady = true;
      }
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
    if (!cancelled) { paintStats(); paint(); }
  };

  rowsEl.addEventListener('click', (ev) => {
    const row = ev.target.closest('[data-slug]');
    if (!row) return;
    ev.preventDefault();
    selectBounty(row.dataset.slug, { replace: true });
  });
  view.querySelector('#q').addEventListener('input', (ev) => { state.q = ev.target.value; selIndex = -1; paint(); });
  view.querySelector('#fee-filter').addEventListener('change', (ev) => { state.fee = ev.target.value; paint(); });
  for (const tab of view.querySelectorAll('[data-tab]')) {
    tab.addEventListener('click', () => {
      state.tab = tab.dataset.tab;
      for (const t of view.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
      if ((state.tab === 'resolved' || state.tab === 'all') && !resolvedLoaded) loadResolved();
      paint();
    });
  }
  for (const btn of view.querySelectorAll('[data-sort]')) {
    btn.addEventListener('click', () => {
      state.sort = btn.dataset.sort;
      for (const b of view.querySelectorAll('[data-sort]')) b.setAttribute('aria-pressed', String(b === btn));
      paint();
    });
  }

  await refreshOpen();
  if (cancelled) return;
  if (!selected) {
    const sorted = sortBoard(items(), state.sort);
    selected = (sorted.find((b) => b.slug === 'makefun-frontend-01') || sorted[0])?.slug || '';
  }
  selectBounty(selected);
  loadResolved();
  const timer = setInterval(async () => {
    if (cancelled || document.visibilityState !== 'visible') return;
    await refreshOpen(); // the list, stats, and ticker refresh; the detail pane is left alone so a selection is never stolen
  }, 30000);
  viewCleanup = () => { cancelled = true; unsubSaved(); clearInterval(timer); };
  live.textContent = 'Live bounty board';
  document.title = 'Beacon · make.fun bounties';
}

// ------------------------------------------------------------ leaderboard --

/**
 * The virtualized leaderboard inside a detail pane's Leaderboard tab: view
 * tabs, filter, row detail — the same behaviour as the full page, mounted
 * into the pane's shell. `valid()` guards every async step so a stale fetch
 * never writes into a pane that moved on to another bounty.
 */
function wirePaneLeaderboard(root, slug, firstData, valid) {
  const tabs = root.querySelector('#view-tabs');
  const detailBox = root.querySelector('#entry-detail');
  let current = null;

  const showView = async (viewName, data) => {
    const payload = data || await getLeaderboardFirst(slug, viewName);
    if (!valid()) return;
    const rows = normalizeLeaderboard(payload, viewName);
    const views = payload.views || ['overall'];
    const active = viewName || payload.view;
    tabs.innerHTML = views.map((v) => `<button role="tab" data-view="${v}" aria-selected="${String(v === active)}">${v}</button>`).join('');
    for (const tab of tabs.querySelectorAll('[data-view]')) {
      tab.addEventListener('click', () => showView(tab.dataset.view));
    }
    if (current) current.setEntries(rows);
    else {
      current = mountLeaderboard(root, { entries: rows }, async (entry) => {
        detailBox.innerHTML = entryDetailHTML(entry);
        detailBox.scrollIntoView({ block: 'nearest' });
        if (entry.compact) {
          try {
            const full = await getSubmission(entry.submission_id);
            const s = full.submission ?? full;
            if (valid() && s) {
              detailBox.innerHTML = entryDetailHTML({
                ...entry, ...s,
                rank: entry.rank, prize_rank: entry.prize_rank ?? s.prize_rank,
                values: s.values ?? entry.values,
              });
            }
          } catch { /* the compact card already shows the essentials */ }
        }
      });
    }
    current.render();
  };

  root.querySelector('#q').addEventListener('input', (ev) => current?.setFilter(ev.target.value));
  showView(null, firstData).catch(() => { /* the tab shows its loading line */ });
  return { render() { current?.render(); } };
}

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
  view.innerHTML = '<div class="sk sk-h" style="width:220px"></div><div class="sk sk-l"></div><div class="sk sk-b"></div>';
  try {
    const [p, rankings] = await Promise.all([
      getProfile(handle),
      getRankings(handle).catch(() => null),
    ]);
    view.innerHTML = profileHTML(p, rankings);
    setViewStats(p.solutions?.length || 0, p.solutions?.length || 0);
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

// ----------------------------------------------------------------- saved --

async function showSaved() {
  setNav('saved');
  selIndex = -1;
  window.__shotReady = false;
  view.innerHTML = savedShell();
  const rowsEl = view.querySelector('#saved-rows');
  const empty = view.querySelector('#saved-empty');
  let items = [];
  let cancelled = false;
  const paint = () => {
    const saved = sortBoard(items.filter((b) => isSaved(b.slug)), 'deadline');
    paintSplitList(rowsEl, saved, { tab: 'all', q: '', sort: 'deadline', category: '', fee: 'any' }, '');
    setViewStats(saved.length, saved.length);
    empty.hidden = saved.length !== 0;
    rowsEl.hidden = saved.length === 0;
  };
  const unsubSaved = onSavedChange(() => { if (!cancelled) paint(); });
  viewCleanup = () => { cancelled = true; unsubSaved(); };
  try {
    const { open, resolved } = await getBoard();
    if (cancelled) return;
    items = [...open.map((b) => ({ ...b, status: 'open' })), ...resolved.map((b) => ({ ...b, status: 'resolved' }))];
  } catch (err) {
    if (!items.length) { mountError(err, showSaved); return; }
  }
  paint();
  live.textContent = 'Saved bounties';
  document.title = 'Saved bounties · Beacon';
  window.__shotReady = true;
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
  const board = hash === '#/board';
  const saved = hash === '#/saved';
  try {
    if (bounty) await showSplit(decodeURIComponent(bounty[1]));
    else if (leaderboard) await showLeaderboard(decodeURIComponent(leaderboard[1]));
    else if (profile) await showProfile(decodeURIComponent(profile[1]));
    else if (board) await showBoard();
    else if (saved) await showSaved();
    else await showSplit('');
  } catch (err) {
    mountError(err, render);
  }
  window.scrollTo(0, 0);
}

window.addEventListener('hashchange', render);
render();
