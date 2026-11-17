// The four pages, as functions from API data to HTML, plus the keyed patcher
// that refreshes lists in place: rows are matched by key, only changed cells
// are rewritten, new rows slide in, gone rows leave. No full re-render, so a
// live refresh never steals scroll position, focus, or a text selection.

import { setViewStats } from './api.js';
import { bytes, date, dateShort, esc, money, moneyShort, ms, num, ord, relTime, timeLeft, winRate } from './fmt.js';

/** The reward as it stands now: the prize plus any entry fees paid into it. */
const pot = (b) => Number(b.potUsd ?? b.rewardAmount ?? 0);

/** The starter-kit download URL: the API sends kit as {json, tarball, final}. */
function kitHref(b) {
  const kit = b.kit;
  const path = typeof kit === 'string' ? kit : (kit?.tarball || kit?.json || '');
  if (!path) return '';
  return /^https?:\/\//.test(path) ? path : `https://make.fun${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Whether a bounty charges an entry fee (the API stores it as a string). */
const hasFee = (b) => Number(b.entryFeeUsd) > 0;

// ------------------------------------------------------------ saved ----
// Starred bounties, kept in this browser only: a set of slugs in
// localStorage, with change listeners so every view repaints its stars.

const SAVED_KEY = 'beacon-saved-v1';
const savedSet = new Set();
try {
  const raw = JSON.parse(localStorage.getItem(SAVED_KEY) || '[]');
  if (Array.isArray(raw)) for (const s of raw) savedSet.add(String(s));
} catch { /* a corrupt store just means nothing saved */ }

const savedListeners = new Set();
export function isSaved(slug) { return savedSet.has(slug); }
export function savedSlugs() { return [...savedSet]; }
export function toggleSaved(slug) {
  if (!slug) return;
  if (savedSet.has(slug)) savedSet.delete(slug);
  else savedSet.add(slug);
  try { localStorage.setItem(SAVED_KEY, JSON.stringify([...savedSet])); } catch { /* private mode: memory only */ }
  for (const fn of savedListeners) fn(slug);
}
export function onSavedChange(fn) {
  savedListeners.add(fn);
  return () => savedListeners.delete(fn);
}

/** The star toggle rendered inside a row: filled amber when saved. */
function starHTML(slug) {
  const saved = isSaved(slug);
  return `<span class="star${saved ? ' saved' : ''}" data-star="${esc(slug)}" role="button" tabindex="0" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved bounties' : 'Save this bounty'}" title="${saved ? 'Saved' : 'Save'}">${saved ? '★' : '☆'}</span>`;
}

/** A real <button> star for table cells and the detail hero. */
function starButtonHTML(slug, withWord) {
  const saved = isSaved(slug);
  const label = withWord ? (saved ? '★ Saved' : '☆ Save') : (saved ? '★' : '☆');
  return `<button class="${withWord ? 'btn ghost save-btn' : 'star-btn'}" data-star="${esc(slug)}" aria-pressed="${saved}" aria-label="${saved ? 'Remove from saved bounties' : 'Save this bounty'}">${label}</button>`;
}

/** Re-render a keyed list without rebuilding it. `tag` is the row element. */
export function patchList(container, items, { tag, key, html, sig, visible, attrs }) {
  const seen = new Set();
  for (const item of items) {
    const k = key(item);
    seen.add(k);
    let row = container.querySelector(`[data-key="${CSS.escape(k)}"]`);
    const s = sig(item);
    if (!row) {
      row = document.createElement(tag);
      row.dataset.key = k;
      row.innerHTML = html(item);
      row._sig = s;
      row.classList.add('row-in');
      container.appendChild(row);
    } else {
      if (row._sig !== s) {
        row.innerHTML = html(item);
        row._sig = s;
      }
      container.appendChild(row); // moves it into sorted order
    }
    if (attrs) {
      for (const [name, value] of Object.entries(attrs(item))) {
        if (value == null) row.removeAttribute(name);
        else row.setAttribute(name, value);
      }
    }
    row.hidden = visible ? !visible(item) : false;
  }
  for (const row of [...container.children]) {
    if (row.dataset.key && !seen.has(row.dataset.key)) row.remove();
  }
}

// ---------------------------------------------------------------- board ----

export function boardRowHTML(b) {
  const left = new Date(b.deadline).getTime() - Date.now();
  const closing = left > 0 && left < 86400000;
  const urgent = left > 0 && left < 3600000;
  const ended = left <= 0;
  const fees = Number(b.entryFeesUsd);
  return `
    <td class="c-title">
      <span class="title-wrap">
        ${starButtonHTML(b.slug, false)}
        <span class="title-main">
          <a class="t" href="#/bounty/${encodeURIComponent(b.slug)}" data-prefetch="${esc(b.slug)}">${esc(b.title)}</a>
          <span class="sub">${esc(b.category || '')}${b.skills?.length ? ` · ${esc(b.skills.slice(0, 3).join(', '))}` : ''}</span>
        </span>
      </span>
    </td>
    <td class="c-pot num">${moneyShort(pot(b))}<span class="sub${Number.isFinite(fees) && fees > 0 ? ' fees' : ''}">${Number.isFinite(fees) && fees > 0 ? `+${moneyShort(fees)} fees` : 'prize'}</span></td>
    <td class="c-fee">${b.entryFeeUsd ? `<span class="fee">${money(b.entryFeeUsd)} fee</span>` : '<span class="free">free</span>'}</td>
    <td class="c-due ${urgent ? 'urgent' : closing ? 'soon' : ended ? 'ended' : ''}"><span data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span><span class="sub">${date(b.deadline)}</span></td>
    <td class="c-n num">${num(b.submissionCount)}<span class="sub">entries</span></td>`;
}

const boardSig = (b) => [b.title, pot(b), b.entryFeeUsd, b.submissionCount, b.status, b.deadline, isSaved(b.slug) ? '1' : '0'].join('|');

export function boardShell() {
  return `
    <div class="page-head">
      <p class="eyebrow"><span class="live-dot"></span>Live · every bounty, updating</p>
      <h1>Live bounty board</h1>
      <p class="lede">Every bounty on make.fun, live from the public API, as one table. Type to filter · <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move. The <a href="#/">split board</a> shows the list beside a bounty's detail.</p>
    </div>
    <div class="controls" role="search">
      <input id="q" type="search" placeholder="Filter bounties…  ( / )" autocomplete="off" aria-label="Filter bounties">
      <div class="tabs" role="tablist" aria-label="Status">
        <button role="tab" data-tab="open" aria-selected="true">Open</button>
        <button role="tab" data-tab="closing" aria-selected="false">Closing soon</button>
        <button role="tab" data-tab="resolved" aria-selected="false">Resolved</button>
        <button role="tab" data-tab="all" aria-selected="false">All</button>
      </div>
      <label class="sort">Sort
        <select id="sort" aria-label="Sort bounties">
          <option value="deadline">Closing first</option>
          <option value="pot">Biggest pot</option>
          <option value="entries">Most entries</option>
          <option value="title">Title A–Z</option>
        </select>
      </label>
      <span id="board-meta" class="meta" aria-live="polite"></span>
    </div>
    <div class="table-wrap">
      <table class="board" aria-label="Bounties">
        <thead><tr><th>Bounty</th><th class="num">Pot</th><th>Entry</th><th>Closes</th><th class="num">Entries</th></tr></thead>
        <tbody id="rows"></tbody>
      </table>
    </div>
    <p id="board-empty" class="empty" hidden>No bounties match. Try a different filter.</p>`;
}

export function sortBoard(items, sort) {
  const arr = [...items];
  const now = Date.now();
  const ended = (b) => new Date(b.deadline).getTime() <= now;
  if (sort === 'pot') arr.sort((a, b) => pot(b) - pot(a));
  else if (sort === 'entries') arr.sort((a, b) => (b.submissionCount || 0) - (a.submissionCount || 0));
  else if (sort === 'title') arr.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  else arr.sort((a, b) => (ended(a) - ended(b)) || (new Date(a.deadline) - new Date(b.deadline)));
  return arr;
}

export function boardVisible(b, tab, q, category = '', fee = 'any') {
  const now = Date.now();
  if (tab === 'open' && b.status !== 'open') return false;
  if (tab === 'resolved' && b.status !== 'resolved') return false;
  if (tab === 'closing' && (b.status !== 'open' || new Date(b.deadline).getTime() - now > 86400000)) return false;
  if (category && b.category !== category) return false;
  if (fee === 'free' && hasFee(b)) return false;
  if (fee === 'paid' && !hasFee(b)) return false;
  if (!q) return true;
  const hay = `${b.title} ${b.category || ''} ${(b.skills || []).join(' ')} ${b.slug}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((w) => hay.includes(w));
}

export function paintBoard(tbody, items, state) {
  patchList(tbody, sortBoard(items, state.sort), {
    tag: 'tr',
    key: (b) => b.slug,
    html: boardRowHTML,
    sig: boardSig,
    visible: (b) => boardVisible(b, state.tab, state.q),
  });
}

// --------------------------------------------------------------- bounty ----

function payoutRows(b) {
  const rewards = b.rewards;
  if (!rewards || typeof rewards !== 'object') return '';
  const places = Object.entries(rewards)
    .map(([place, amount]) => [Number(place), Number(amount)])
    .filter(([p, a]) => Number.isFinite(p) && Number.isFinite(a))
    .sort((a, b) => a[0] - b[0])
    .slice(0, 20);
  if (!places.length) return '';
  const max = Math.max(...places.map(([, a]) => a), 1);
  return `<h2>Payouts</h2><ol class="payouts">${places
    .map(([p, a], i) => `<li class="${i === 0 ? 'first' : ''}"><span class="place">#${p}</span><span class="pbar"><i style="width:${Math.max((a / max) * 100, 3).toFixed(1)}%"></i></span><span class="amt">${money(a)}</span></li>`)
    .join('')}</ol>`;
}

export function bountyHTML(b) {
  const fees = Number(b.entryFeesUsd);
  const left = new Date(b.deadline).getTime() - Date.now();
  const ended = left <= 0;
  const closing = left > 0 && left < 86400000;
  const feeValue = b.entryFeeUsd ? money(b.entryFeeUsd) : 'Free';
  const feeNote = b.entryFeeUsd && b.entryFeePayers ? `${num(b.entryFeePayers)} paid` : (b.entryFeeUsd ? 'per entry' : 'no entry fee');
  const kit = kitHref(b);
  return `
    <p class="crumbs"><a href="#/">All bounties</a> › ${esc(b.category || 'Bounty')}</p>
    <div class="hero-block">
      <p class="eyebrow">${esc(b.category || 'Bounty')} <span class="status-pill${ended ? ' ended' : ''}">${ended ? 'Ended' : (b.status || 'Open')}</span></p>
      <h1 class="hero">${esc(b.title)}</h1>
      <p class="lede">${esc(b.summary || '')}</p>
      <div class="stat-cards">
        <div class="sc pot"><span class="sc-label">Pot</span><span class="sc-value">${money(pot(b))}</span><span class="sc-note">${money(b.rewardAmount)} prize${Number.isFinite(fees) && fees > 0 ? ` + ${money(fees)} fees` : ''}</span></div>
        <div class="sc"><span class="sc-label">Entry fee</span><span class="sc-value">${feeValue}</span><span class="sc-note">${feeNote}</span></div>
        <div class="sc${closing ? ' soon' : ''}"><span class="sc-label">Deadline</span><span class="sc-value" data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span><span class="sc-note">${date(b.deadline)}</span></div>
        <div class="sc"><span class="sc-label">Entries</span><span class="sc-value">${num(b.submissionCount)}</span><span class="sc-note">${b.submissionRule ? esc(b.submissionRule) : 'submissions so far'}</span></div>
      </div>
      ${b.sponsor?.name ? `<p class="sponsor-line">Sponsor <strong>${esc(b.sponsor.name)}${b.sponsor.isVerified ? ' ✓' : ''}</strong>${b.phase?.title ? ` · ${esc(b.phase.title)}` : ''}</p>` : ''}
      ${b.skills?.length ? `<div class="skills-row"><span class="sc-label">Skills</span>${b.skills.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ')}</div>` : ''}
    </div>
    <div class="actions">
      <a class="btn" href="https://make.fun/bounty/${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">Open on make.fun ↗</a>
      <a class="btn ghost" href="#/leaderboard/${encodeURIComponent(b.slug)}">Leaderboard (${num(b.submissionCount)})</a>
      ${kit ? `<a class="btn ghost" href="${esc(kit)}" target="_blank" rel="noopener">Kit</a>` : ''}
    </div>
    ${payoutRows(b)}
    <h2>About this bounty</h2>
    <div class="description">${esc(b.description || b.summary || '')}</div>
    <div id="lb-preview"></div>`;
}

export function sideRowHTML(b) {
  return `<a href="#/bounty/${encodeURIComponent(b.slug)}" data-prefetch="${esc(b.slug)}">
    <span class="t">${esc(b.title)}</span>
    <span class="m"><b>${moneyShort(pot(b))}</b> · <span data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span></span>
  </a>`;
}

export function bountyShell() {
  return `
    <div class="split">
      <article id="detail" class="detail" aria-live="polite"><div class="sk sk-h"></div><div class="sk sk-l"></div><div class="sk sk-l" style="width:60%"></div><div class="sk sk-b"></div></article>
      <aside class="side" aria-label="Live board">
        <h2>Live board</h2>
        <p class="sub">Other open bounties, updating live.</p>
        <div id="side-rows" class="side-rows"></div>
        <p><a href="#/">Full board →</a></p>
      </aside>
    </div>`;
}

// ----------------------------------------------------------- leaderboard ----

/** Merge a compact leaderboard payload (top 10 full + the slim `rest` ranking)
 *  into one sorted row list. Compact rows carry everything the list shows;
 *  their full detail loads on demand when selected. */
export function normalizeLeaderboard(data, viewName) {
  const full = data.entries || [];
  const view = viewName || data.view || 'overall';
  const rest = (data.rest || []).map((r) => ({
    ...r,
    rank: view === 'performance' ? (r.performance ?? r.rank) : r.rank,
    compact: true,
    values: {
      judge: Number(r.value),
      judge_low: Number(r.interval?.low),
      judge_high: Number(r.interval?.high),
      bytes: undefined,
    },
  }));
  const seen = new Set(full.map((e) => e.submission_id));
  const rows = [...full, ...rest.filter((r) => !seen.has(r.submission_id))];
  rows.sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  return rows;
}

export function leaderboardShell(b) {
  return `
    <p class="crumbs"><a href="#/">All bounties</a> › <a href="#/bounty/${encodeURIComponent(b.slug)}">${esc(b.title)}</a></p>
    <div class="page-head">
      <h1>Leaderboard</h1>
      <p class="lede" id="lb-meta"></p>
    </div>
    <div class="controls">
      <input id="q" type="search" placeholder="Filter by builder or entry…  ( / )" autocomplete="off" aria-label="Filter leaderboard">
      <div class="tabs" id="view-tabs" role="tablist" aria-label="Leaderboard view"></div>
      <span class="meta" id="lb-count" aria-live="polite"></span>
    </div>
    <div id="entry-detail"></div>
    <div class="lb-head" aria-hidden="true"><span>Rank</span><span>Prize</span><span>Builder · entry</span><span>Judge win rate</span><span class="num">Size</span></div>
    <div id="lb-scroll" class="lb-scroll" tabindex="0" aria-label="Leaderboard entries, virtualized list">
      <div id="lb-spacer" class="lb-spacer"><div id="lb-window" class="lb-window"></div></div>
    </div>
    <p class="hint">Showing <span id="lb-shown">0</span> of <span id="lb-total">0</span> entries · scroll to load more rows · click a row for detail.</p>`;
}

/** A virtualized leaderboard: only the visible slice of rows exists in the DOM. */
export function mountLeaderboard(root, data, onSelect) {
  const ROW_H = 54;
  const scroll = root.querySelector('#lb-scroll');
  const spacer = root.querySelector('#lb-spacer');
  const win = root.querySelector('#lb-window');
  const shownEl = root.querySelector('#lb-shown');
  const totalEl = root.querySelector('#lb-total');
  const countEl = root.querySelector('#lb-count');
  let entries = data.entries || [];
  let filtered = entries;
  let selectedId = null;

  const lows = entries.map((e) => Number(e.values?.judge_low)).filter(Number.isFinite);
  const highs = entries.map((e) => Number(e.values?.judge_high)).filter(Number.isFinite);
  const lo = lows.length ? Math.min(...lows) : 0;
  const hi = highs.length ? Math.max(...highs) : 1;
  const span = Math.max(hi - lo, 1);

  function rowHTML(e) {
    const v = e.values || {};
    const j = Number(v.judge);
    const jl = Number(v.judge_low);
    const jh = Number(v.judge_high);
    const left = Number.isFinite(jl) ? ((jl - lo) / span) * 100 : 0;
    const width = Number.isFinite(jl) && Number.isFinite(jh) ? Math.max(((jh - jl) / span) * 100, 1.5) : 0;
    const dot = Number.isFinite(j) ? ((j - lo) / span) * 100 : 0;
    return `
      <span class="r-rank">${e.rank ?? '—'}</span>
      <span class="r-prize">${e.prize_rank ? `<span class="prize" title="Prize rank">#${e.prize_rank}</span>` : ''}</span>
      <span class="r-who"><a href="#/u/${encodeURIComponent(e.handle || '')}" data-stop>@${esc(e.handle || '—')}</a>
        <span class="r-title">${esc(e.title || '')}</span></span>
      <span class="r-score">${winRate(j)}
        <span class="interval" title="Judge interval ${winRate(jl)} – ${winRate(jh)}">
          <span class="bar" style="left:${left.toFixed(1)}%;width:${width.toFixed(1)}%"></span>
          <span class="dot" style="left:${dot.toFixed(1)}%"></span>
        </span></span>
      <span class="r-bytes">${bytes(v.bytes)}</span>`;
  }

  function render() {
    const scrollTop = scroll.scrollTop;
    const height = scroll.clientHeight;
    const start = Math.max(0, Math.floor(scrollTop / ROW_H) - 4);
    const end = Math.min(filtered.length, Math.ceil((scrollTop + height) / ROW_H) + 4);
    spacer.style.height = `${filtered.length * ROW_H}px`;
    win.style.transform = `translateY(${start * ROW_H}px)`;
    win.innerHTML = filtered.slice(start, end).map((e) => {
      const sel = e.submission_id === selectedId ? ' sel' : '';
      const top = e.rank === 1 ? ' top1' : e.rank === 2 ? ' top2' : e.rank === 3 ? ' top3' : '';
      return `<div class="lb-row${sel}${top}" role="button" tabindex="0" data-id="${esc(e.submission_id)}" style="height:${ROW_H}px">${rowHTML(e)}</div>`;
    }).join('');
    shownEl.textContent = num(end - start);
    totalEl.textContent = num(filtered.length);
    countEl.textContent = filtered.length === entries.length
      ? `${num(entries.length)} entries`
      : `${num(filtered.length)} of ${num(entries.length)} entries`;
    setViewStats(filtered.length, Math.max(0, end - start));
  }

  scroll.addEventListener('scroll', () => requestAnimationFrame(render), { passive: true });
  win.addEventListener('click', (ev) => {
    const link = ev.target.closest('a');
    if (link) return; // handle links navigate; they stop here
    const row = ev.target.closest('.lb-row');
    if (row) select(row.dataset.id);
  });
  win.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList.contains('lb-row')) {
      ev.preventDefault();
      select(ev.target.dataset.id);
    }
  });

  function select(id) {
    selectedId = id;
    render();
    const entry = entries.find((e) => e.submission_id === id);
    if (entry) onSelect(entry);
  }

  return {
    render,
    setFilter(q) {
      const needle = q.trim().toLowerCase();
      filtered = !needle ? entries : entries.filter((e) =>
        `${e.handle || ''} ${e.title || ''}`.toLowerCase().includes(needle));
      scroll.scrollTop = 0;
      render();
    },
    setEntries(next) {
      entries = next;
      filtered = next;
      render();
    },
  };
}

export function entryDetailHTML(e) {
  const v = e.values || {};
  const cost = e.cost?.micro_usd != null ? money(Number(e.cost.micro_usd) / 1e6) : null;
  return `
    <section class="detail-card" aria-label="Selected entry">
      <div class="dc-main">
        <h2>${esc(e.title || 'Untitled entry')}</h2>
        <p class="lede"><a href="#/u/${encodeURIComponent(e.handle || '')}">@${esc(e.handle || '—')}</a> · rank ${e.rank ?? '—'}${e.prize_rank ? ` · prize #${e.prize_rank}` : ''} · ${esc(e.status || '')}</p>
        <dl class="facts compact">
          <dt>Judge win rate</dt><dd>${winRate(v.judge)} <span class="sub">(interval ${winRate(v.judge_low)} – ${winRate(v.judge_high)})</span></dd>
          <dt>Size</dt><dd>${bytes(v.bytes)}</dd>
          ${cost ? `<dt>Build cost</dt><dd>${cost}</dd>` : ''}
          ${e.build_wall_ms ? `<dt>Build time</dt><dd>${ms(e.build_wall_ms)}</dd>` : ''}
          ${e.models?.length ? `<dt>Models</dt><dd>${e.models.map(esc).join(', ')}</dd>` : ''}
          ${e.received_at ? `<dt>Entered</dt><dd>${date(e.received_at)}</dd>` : ''}
        </dl>
        <div class="actions">
          ${e.repo_url ? `<a class="btn ghost" href="${esc(e.repo_url)}" target="_blank" rel="noopener">Repository ↗</a>` : ''}
          ${e.entry_link_url ? `<a class="btn ghost" href="${esc(e.entry_link_url)}" target="_blank" rel="noopener">Live entry ↗</a>` : ''}
          <a class="btn ghost" href="https://make.fun/api/submissions/${encodeURIComponent(e.submission_id)}" target="_blank" rel="noopener">API ↗</a>
        </div>
      </div>
      <div class="dc-art">
        <img crossorigin="anonymous" src="https://make.fun/api/submissions/${encodeURIComponent(e.submission_id)}/artifact.webp" alt="" loading="lazy"
          onload="this.classList.add('ok')" onerror="this.remove()">
      </div>
    </section>`;
}

// --------------------------------------------------------------- profile ----

export function profileHTML(p, rankings) {
  const r = p.record || {};
  const solutions = p.solutions || [];
  const scoreCell = (s) => {
    if (s == null) return '<span class="sub">—</span>';
    if (typeof s === 'object') {
      const v = Number(s.value);
      if (s.column?.key === 'judge' && Number.isFinite(v)) return `${winRate(v)}<span class="sub">judge win rate</span>`;
      const shown = Number.isFinite(v) && /^-?\d+$/.test(String(s.display ?? s.value)) ? num(v) : esc(s.display ?? String(s.value ?? '—'));
      return `${shown}<span class="sub">${esc(s.column?.title || '')}</span>`;
    }
    return esc(String(s));
  };
  const rows = solutions.map((s) => {
    const c = s.competition || {};
    return `<tr>
      <td><a href="#/bounty/${encodeURIComponent(c.slug || '')}">${esc(s.title || c.title || '—')}</a>
        <span class="sub">${esc(c.title || '')}</span></td>
      <td>${s.placement ? `#${num(s.placement)}` : '<span class="sub">pending</span>'}</td>
      <td>${s.prize_usd ? money(s.prize_usd) : '<span class="sub">—</span>'}</td>
      <td>${scoreCell(s.score)}</td>
      <td>${s.entered_at ? date(s.entered_at) : '—'}</td>
    </tr>`;
  }).join('');
  return `
    <div class="profile-head">
      ${p.image ? `<img class="avatar" crossorigin="anonymous" src="${esc(p.image)}" alt="" width="84" height="84" onerror="this.style.display='none'">` : ''}
      <div>
        <p class="eyebrow">Builder</p>
        <h1>${esc(p.display_name || p.handle)}</h1>
        <p class="lede">@${esc(p.handle)}${p.joined_at ? ` · joined ${date(p.joined_at)}` : ''}</p>
        ${p.bio ? `<p>${esc(p.bio)}</p>` : ''}
        <p class="links">
          ${p.github_login ? `<a href="https://github.com/${encodeURIComponent(p.github_login)}" target="_blank" rel="noopener">GitHub ↗</a>` : ''}
          ${p.x ? `<a href="https://x.com/${encodeURIComponent(p.x)}" target="_blank" rel="noopener">X ↗</a>` : ''}
          ${p.discord ? `<span>Discord: ${esc(p.discord)}</span>` : ''}
          ${p.wallet ? `<span class="wallet" title="Payout wallet">${esc(p.wallet)}</span>` : ''}
        </p>
      </div>
    </div>
    <dl class="stat-grid">
      <div><dt>Entered</dt><dd>${num(r.competitions_entered)}</dd></div>
      <div><dt>Placed</dt><dd>${num(r.competitions_placed)}</dd></div>
      <div><dt>Won</dt><dd>${num(r.competitions_won)}</dd></div>
      <div><dt>Podiums</dt><dd>${num(r.podium_finishes)}</dd></div>
      <div><dt>Best placement</dt><dd>${r.best_placement ? `#${num(r.best_placement)}` : '—'}</dd></div>
      <div><dt>Prizes</dt><dd>${money(r.prize_usd)}</dd></div>
      ${rankings?.ahead != null ? `<div><dt>Wins rank</dt><dd>#${num(rankings.ahead + 1)} of ${num(rankings.total)}</dd></div>` : ''}
    </dl>
    <h2>Entries (${num(solutions.length)})</h2>
    ${solutions.length ? `<div class="table-wrap"><table class="board">
      <thead><tr><th>Entry</th><th>Place</th><th>Prize</th><th>Score</th><th>Entered</th></tr></thead>
      <tbody>${rows}</tbody></table></div>` : '<p class="empty">No entries yet.</p>'}`;
}

// ------------------------------------------------------------- split view ----
// The default page: the bounty list stays on the left while the selected
// bounty renders beside it, the way the best make.fun frontends lay it out.
// Clicking a row swaps the detail pane without a reload and without losing
// the list. Everything here is computed live from the public API; a field the
// API does not expose is omitted, never invented.

/** The aggregate strip above the list: live totals from the open board. */
export function statsStripHTML(openItems) {
  const live = openItems.length;
  const pots = openItems.reduce((sum, b) => sum + pot(b), 0);
  const entries = openItems.reduce((sum, b) => sum + (Number(b.submissionCount) || 0), 0);
  const next = openItems
    .map((b) => b.deadline)
    .filter((d) => new Date(d).getTime() > Date.now())
    .sort()[0];
  return `
    <div class="stat-strip" aria-label="Live totals">
      <div><span class="ss-label">Live</span><span class="ss-value">${num(live)}</span></div>
      <div><span class="ss-label">Live pots</span><span class="ss-value">${money(pots)}</span></div>
      <div><span class="ss-label">Entries</span><span class="ss-value">${num(entries)}</span></div>
      <div><span class="ss-label">Closes in</span><span class="ss-value" data-countdown-short="${esc(next || '')}">${next ? timeLeft(next).replace(/ left$/, '') : '—'}</span></div>
    </div>`;
}

/**
 * The activity ticker. The board payload's embedded submissions carry times
 * only — no names — so the ticker shows what is real: how many entries each
 * open bounty took in the last hour, and how recently its newest entry
 * landed. The hourly total carries a '+' when a competition's embedded list
 * of 50 is cut off inside the hour, so the number is never claimed as exact
 * when it is only a floor. No extra request: the times ride the board list.
 */
export function tickerHTML(openItems) {
  const now = Date.now();
  const hourAgo = now - 3600000;
  let totalLastHour = 0;
  let truncated = false;
  const per = [];
  for (const b of openItems) {
    const subs = Array.isArray(b.submissions) ? b.submissions : [];
    const times = subs
      .map((s) => new Date(s.createdAt || s.created_at).getTime())
      .filter(Number.isFinite);
    if (!times.length) continue;
    const cut = subs.length === 50 && Number(b.submissionCount) > 50 && Math.min(...times) > hourAgo;
    if (cut) truncated = true;
    const lastHour = times.filter((t) => t > hourAgo).length;
    totalLastHour += lastHour;
    per.push({ slug: b.slug, title: b.title, lastHour, last: Math.max(...times), cut });
  }
  if (!per.length) return '';
  per.sort((a, b) => b.last - a.last);
  const items = per.slice(0, 6).map((p) => {
    const bit = p.lastHour > 0
      ? `${num(p.lastHour)}${p.cut ? '+' : ''} in the last hour · last ${relTime(new Date(p.last).toISOString())}`
      : `last entry ${relTime(new Date(p.last).toISOString())}`;
    return `<a href="#/bounty/${encodeURIComponent(p.slug)}" data-prefetch="${esc(p.slug)}">${esc(p.title)} <span class="tk-when">${bit}</span></a>`;
  }).join('<span class="tk-sep">·</span>');
  return `
    <div class="ticker" aria-label="Recent entries">
      <span class="tk-live"><span class="live-dot"></span>Live</span>
      <span class="tk-count">${num(totalLastHour)}${truncated ? '+' : ''} entries in the last hour</span>
      <span class="tk-items">${items}</span>
    </div>`;
}

/**
 * A compact split-view row: title plus one meta line, with a star toggle.
 * The category/skills sub-line is dropped here — the chips above the list
 * already carry the category — so five or six bounties fit the first screen.
 */
export function splitRowHTML(b) {
  const left = new Date(b.deadline).getTime() - Date.now();
  const closing = left > 0 && left < 86400000;
  const urgent = left > 0 && left < 3600000;
  const ended = left <= 0;
  const fees = Number(b.entryFeesUsd);
  return `
    <span class="srow-main">
      <span class="srow-top">
        <span class="srow-title">${esc(b.title)}</span>
        ${closing && !ended ? '<span class="closing-badge">closing soon</span>' : ''}
      </span>
      <span class="srow-meta">
        <b>${moneyShort(pot(b))}</b>${Number.isFinite(fees) && fees > 0 ? `<span class="srow-fees">+${moneyShort(fees)} fees</span>` : ''}
        ${hasFee(b) ? `<span class="fee sm">${money(b.entryFeeUsd)} fee</span>` : '<span class="free sm">free</span>'}
        <span class="srow-due ${urgent ? 'urgent' : closing ? 'soon' : ended ? 'ended' : ''}" data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span>
        <span class="srow-n">${num(b.submissionCount)} entries</span>
      </span>
    </span>
    ${starHTML(b.slug)}`;
}

export function splitShell() {
  return `
    <div id="ticker-slot"></div>
    <div class="split2">
      <section class="pane-list" aria-label="Bounty board">
        <div class="pane-head">
          <p class="eyebrow"><span class="live-dot"></span>Live · every bounty, updating</p>
          <h1 class="pane-title">Bounty board</h1>
        </div>
        <div id="split-stats"></div>
        <div class="split-controls" role="search">
          <div class="tabs" role="tablist" aria-label="Status">
            <button role="tab" data-tab="open" aria-selected="true">Open</button>
            <button role="tab" data-tab="closing" aria-selected="false">Closing soon</button>
            <button role="tab" data-tab="resolved" aria-selected="false">Resolved</button>
            <button role="tab" data-tab="all" aria-selected="false">All</button>
          </div>
          <div class="sort-btns" role="group" aria-label="Sort bounties">
            <button data-sort="deadline" aria-pressed="true">Closing soon</button>
            <button data-sort="pot" aria-pressed="false">Biggest pot</button>
            <button data-sort="entries" aria-pressed="false">Most entries</button>
          </div>
          <div class="chip-row">
            <div id="cat-chips" class="chips" role="group" aria-label="Category"></div>
            <label class="fee-filter">Fee
              <select id="fee-filter" aria-label="Filter by entry fee">
                <option value="any">Any fee</option>
                <option value="free">Free</option>
                <option value="paid">Paid</option>
              </select>
            </label>
          </div>
          <div class="filter-row">
            <input id="q" type="search" placeholder="Filter bounties…  ( / )" autocomplete="off" aria-label="Filter bounties">
            <span id="split-meta" class="meta" aria-live="polite"></span>
          </div>
        </div>
        <div id="split-rows" class="split-rows"></div>
        <p id="split-empty" class="empty" hidden>No bounties match. Try a different filter.</p>
        <p class="pane-foot"><a href="#/board">Full board table →</a></p>
      </section>
      <article id="detail" class="pane-detail" aria-live="polite">
        <div class="sk sk-h"></div><div class="sk sk-l"></div><div class="sk sk-l" style="width:60%"></div><div class="sk sk-b"></div>
      </article>
    </div>`;
}

export function categoryChipsHTML(items, selected) {
  const cats = [...new Set(items.map((b) => b.category).filter(Boolean))].sort();
  const chip = (value, label) => `<button class="chipbtn" data-cat="${esc(value)}" aria-pressed="${String(value === selected)}">${esc(label)}</button>`;
  return chip('', 'All') + cats.map((c) => chip(c, c)).join('');
}

const splitSig = (b) => [b.title, pot(b), b.entryFeeUsd, b.entryFeesUsd, b.submissionCount, b.status, b.deadline, isSaved(b.slug) ? '1' : '0'].join('|');

export function paintSplitList(container, items, state, selectedSlug) {
  const sorted = sortBoard(items, state.sort);
  patchList(container, sorted, {
    tag: 'a',
    key: (b) => b.slug,
    html: splitRowHTML,
    sig: splitSig,
    visible: (b) => boardVisible(b, state.tab, state.q, state.category, state.fee),
    attrs: (b) => ({
      class: `srow${b.slug === selectedSlug ? ' sel' : ''}`,
      href: `#/bounty/${encodeURIComponent(b.slug)}`,
      'data-prefetch': b.slug,
      'data-slug': b.slug,
      'aria-current': b.slug === selectedSlug ? 'true' : null,
    }),
  });
  let drawn = 0;
  for (const row of container.children) {
    if (!row.hidden) drawn += 1;
  }
  return { kept: sorted.length, drawn };
}

/**
 * How many submissions passed the checks — only when the detail payload
 * carries the complete submission list, so the number is exact, never a
 * guess from a truncated list.
 */
function passedCount(b) {
  const subs = b.submissions;
  if (!Array.isArray(subs) || !subs.length) return null;
  if (subs.length !== Number(b.submissionCount)) return null;
  return subs.filter((s) => s.status === 'passed').length;
}

/**
 * The rewards table: each paid place's base prize, its share of the collected
 * entry fees, and what it pays right now — straight from the API's live
 * rewardsNow figures, with consecutive equal places grouped into one row.
 */
export function rewardsTableHTML(b) {
  const now = (b.rewardsNow || [])
    .map((r) => ({ place: Number(r.place), base: Number(r.baseUsd), fee: Number(r.feeShareUsd), amount: Number(r.amountUsd) }))
    .filter((r) => Number.isFinite(r.place) && Number.isFinite(r.amount))
    .sort((a, z) => a.place - z.place);
  let rows = now;
  if (!rows.length && b.rewards && typeof b.rewards === 'object') {
    rows = Object.entries(b.rewards)
      .map(([place, amount]) => ({ place: Number(place), base: Number(amount), fee: null, amount: Number(amount) }))
      .filter((r) => Number.isFinite(r.place) && Number.isFinite(r.amount))
      .sort((a, z) => a.place - z.place);
  }
  if (!rows.length) return '';
  // Group consecutive places that pay identically: '4th–10th', '11th–20th'.
  const groups = [];
  for (const r of rows) {
    const last = groups[groups.length - 1];
    if (last && last.base === r.base && last.fee === r.fee && last.amount === r.amount && r.place === last.end + 1) {
      last.end = r.place;
    } else {
      groups.push({ ...r, start: r.place, end: r.place });
    }
  }
  const max = Math.max(...groups.map((g) => g.amount), 1);
  const fees = Number(b.entryFeesUsd);
  const payers = Number(b.entryFeePayers);
  const placeLabel = (g) => (g.start === g.end ? ord(g.start) : `${ord(g.start)}–${ord(g.end)}`);
  return `
    <section class="panel" aria-label="Rewards">
      <div class="panel-head"><h2>Rewards</h2>
      <p class="panel-note">${num(rows.length)} paid places · ${money(pot(b))} live pot</p></div>
      <table class="rewards">
        <thead><tr><th>Place</th><th class="num">Base</th><th class="num">Fee share</th><th class="num">Pays now</th></tr></thead>
        <tbody>${groups.map((g, i) => `
          <tr class="${i === 0 ? 'first' : ''}">
            <td class="rw-place">${placeLabel(g)}</td>
            <td class="num">${money(g.base)}</td>
            <td class="num">${g.fee == null ? '—' : `+${money(g.fee)}`}</td>
            <td class="num rw-pays">${money(g.amount)}${g.start !== g.end ? ' <span class="sub-inline">each</span>' : ''}
              <span class="rw-bar"><i style="width:${Math.max((g.amount / max) * 100, 3).toFixed(1)}%"></i></span></td>
          </tr>`).join('')}</tbody>
      </table>
      ${Number.isFinite(fees) && fees > 0 ? `<p class="panel-foot">Fee pool ${money(fees)}${Number.isFinite(payers) && payers > 0 ? ` from ${num(payers)} paid entries` : ''}, shared by the same proportions as the base prizes.</p>` : ''}
    </section>`;
}

/** Opened → now → deadline → results-by, with the now marker placed by time. */
export function phasesHTML(b) {
  const opened = b.opensAt || b.publishedAt;
  const deadline = b.deadline;
  if (!opened || !deadline) return '';
  const phases = Array.isArray(b.phases) ? b.phases : [];
  const final = phases.find((p) => p.key === 'final');
  const dev = phases.find((p) => p.key === 'dev');
  const points = [
    { label: 'Opened', at: opened },
    { label: 'Deadline', at: deadline },
  ];
  if (final?.endsAt) points.push({ label: 'Results by', at: final.endsAt });
  const start = new Date(points[0].at).getTime();
  const end = new Date(points[points.length - 1].at).getTime();
  const span = Math.max(end - start, 1);
  const pos = (iso) => Math.min(100, Math.max(0, ((new Date(iso).getTime() - start) / span) * 100));
  const nowPos = pos(new Date().toISOString());
  const caption = dev ? `${esc(dev.title)}${dev.scores ? ` · ${esc(dev.scores)} scores` : ''}` : '';
  // The exact windows, in the same short format as the labels above: the
  // Development window (opened -> deadline) and the Final window (its own
  // start -> results-by; the deadline when the phase carries no start).
  const windows = [];
  if (dev?.startsAt && dev?.endsAt) windows.push({ title: dev.title || 'Development', from: dev.startsAt, to: dev.endsAt });
  else windows.push({ title: 'Development', from: opened, to: deadline });
  if (final?.startsAt && final?.endsAt) windows.push({ title: final.title || 'Final', from: final.startsAt, to: final.endsAt });
  else if (final?.endsAt) windows.push({ title: final.title || 'Final', from: deadline, to: final.endsAt });
  const windowsLine = windows.length ? `<p class="ph-windows">${windows.map((w) => `<span><b>${esc(w.title)}</b> ${esc(dateShort(w.from))} → ${esc(dateShort(w.to))}</span>`).join('<span class="ph-wsep" aria-hidden="true">·</span>')}</p>` : '';
  // Label alignment: the first label starts at its dot, the last ends at its
  // dot, and a middle label centers on its dot — unless the next point is so
  // close that the centered label would collide with the next one, in which
  // case it ends at its dot instead.
  const align = points.map((p, i) => {
    if (i === 0) return 'start';
    if (i === points.length - 1) return 'end';
    return (pos(points[i + 1].at) - pos(p.at)) < 35 ? 'end' : 'center';
  });
  return `
    <section class="phases" aria-label="Dates and phases">
      <div class="ph-track">
        <span class="ph-fill" style="width:${nowPos.toFixed(1)}%"></span>
        ${points.map((p) => `<span class="ph-dot" style="left:${pos(p.at).toFixed(1)}%" title="${esc(p.label)}"></span>`).join('')}
        <span class="ph-now" style="left:${nowPos.toFixed(1)}%"><span class="ph-now-label">Now</span></span>
      </div>
      <div class="ph-labels">
        ${points.map((p, i) => `<span class="ph-label ${align[i]}" style="left:${pos(p.at).toFixed(1)}%"><b>${esc(p.label)}</b>${dateShort(p.at)}</span>`).join('')}
      </div>
      ${windowsLine}
      ${caption ? `<p class="ph-caption">${caption}${final ? ` · then ${esc(final.title)}` : ''}</p>` : ''}
    </section>`;
}

/** The embedded leaderboard preview: avatars, win rates with intervals, prize now. */
export function leaderboardPreviewHTML(entries, b, slug) {
  if (!entries.length) return '';
  const rewards = new Map((b.rewardsNow || []).map((r) => [Number(r.place), Number(r.amountUsd)]));
  const rows = entries.slice(0, 5).map((e) => {
    const v = e.values || {};
    const prize = rewards.get(Number(e.rank));
    const initial = String(e.handle || '?').charAt(0).toUpperCase();
    const img = !e.image ? '' : /^https?:\/\//.test(e.image) ? e.image : `https://make.fun${e.image.startsWith('/') ? '' : '/'}${e.image}`;
    return `
      <li>
        <span class="pv-rank">${e.rank ?? '—'}</span>
        <span class="ava" aria-hidden="true">${esc(initial)}${img ? `<img crossorigin="anonymous" src="${esc(img)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>
        <span class="pv-who"><a href="#/u/${encodeURIComponent(e.handle || '')}">@${esc(e.handle || '—')}</a>
          <span class="pv-title">${esc(e.title || '')}</span></span>
        <span class="pv-score">${winRate(v.judge)}<span class="pv-interval">${winRate(v.judge_low)}–${winRate(v.judge_high)}</span></span>
        <span class="pv-prize">${Number.isFinite(prize) ? money(prize) : '—'}</span>
      </li>`;
  }).join('');
  return `
    <section class="panel" aria-label="Top entries">
      <h2>Top 5 now</h2>
      <p class="panel-note">by judge win rate · ${num(b.submissionCount)} entries</p>
      <ol class="preview">${rows}</ol>
      <p class="panel-foot"><a href="#/leaderboard/${encodeURIComponent(slug)}">Full leaderboard →</a></p>
    </section>`;
}

/** The detail pane of the split view: hero numbers, phases, tabs, rewards, preview. */
export function bountyDetailHTML(b) {
  const fees = Number(b.entryFeesUsd);
  const left = new Date(b.deadline).getTime() - Date.now();
  const ended = left <= 0;
  const closing = left > 0 && left < 86400000;
  const payers = Number(b.entryFeePayers);
  const passed = passedCount(b);
  const feeNote = hasFee(b)
    ? (Number.isFinite(payers) && payers > 0 ? `${num(payers)} paid` : 'once per account')
    : 'no entry fee';
  const entriesNote = passed != null ? `${num(passed)} passed the checks` : 'submissions so far';
  const kit = kitHref(b);
  return `
    <p class="crumbs"><a href="#/">All bounties</a> › ${esc(b.category || 'Bounty')}</p>
    <div class="hero-block">
      <p class="eyebrow">${esc(b.category || 'Bounty')} <span class="status-pill${ended ? ' ended' : ''}">${ended ? 'Ended' : 'Open · taking entries'}</span></p>
      <h1 class="hero">${esc(b.title)}</h1>
      <p class="lede">${esc(b.summary || '')}</p>
      <div class="stat-cards">
        <div class="sc pot"><span class="sc-label">Live pot</span><span class="sc-value">${money(pot(b))}</span><span class="sc-note">${money(b.rewardAmount)} prize${Number.isFinite(fees) && fees > 0 ? ` + ${money(fees)} fees` : ''}</span></div>
        <div class="sc"><span class="sc-label">Entry fee</span><span class="sc-value">${hasFee(b) ? money(b.entryFeeUsd) : 'Free'}</span><span class="sc-note">${feeNote}</span></div>
        <div class="sc${closing ? ' soon' : ''}"><span class="sc-label">Time left</span><span class="sc-value" data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span><span class="sc-note">${date(b.deadline)}</span></div>
        <div class="sc"><span class="sc-label">Entries</span><span class="sc-value">${num(b.submissionCount)}</span><span class="sc-note">${entriesNote}</span></div>
      </div>
      ${b.sponsor?.name || b.skills?.length ? `<div class="hero-meta">${b.sponsor?.name ? `<p class="sponsor-line">Sponsor <strong>${esc(b.sponsor.name)}${b.sponsor.isVerified ? ' ✓' : ''}</strong>${b.phase?.title ? ` · ${esc(b.phase.title)}` : ''}</p>` : ''}${b.skills?.length ? `<div class="skills-row"><span class="sc-label">Skills</span>${b.skills.map((s) => `<span class="chip">${esc(s)}</span>`).join(' ')}</div>` : ''}</div>` : ''}
    </div>
    ${phasesHTML(b)}
    <div class="actions">
      <a class="btn" href="https://make.fun/bounty/${encodeURIComponent(b.slug)}" target="_blank" rel="noopener">Enter on make.fun ↗</a>
      ${starButtonHTML(b.slug, true)}
      ${kit ? `<a class="btn ghost" href="${esc(kit)}" target="_blank" rel="noopener">Kit</a>` : ''}
    </div>
    ${rewardsTableHTML(b)}
    <div class="detail-tabs" role="tablist" aria-label="Bounty detail">
      <button role="tab" data-ptab="overview" aria-selected="true">Overview</button>
      <button role="tab" data-ptab="leaderboard" aria-selected="false">Leaderboard (${num(b.submissionCount)})</button>
    </div>
    <div id="pane-overview">
      <div class="detail-grid">
        <div id="lb-preview"></div>
      </div>
      <h2>About this bounty</h2>
      <div class="description">${esc(b.description || b.summary || '')}</div>
    </div>
    <div id="pane-leaderboard" hidden></div>`;
}

/**
 * The leaderboard inside the detail pane's Leaderboard tab: the same
 * virtualized list as the full leaderboard page, with its own filter and
 * view tabs, mounted only when the tab is first opened.
 */
export function leaderboardPaneHTML(b) {
  return `
    <div class="controls pane-lb-controls">
      <input id="q" type="search" placeholder="Filter by builder or entry…  ( / )" autocomplete="off" aria-label="Filter leaderboard">
      <div class="tabs" id="view-tabs" role="tablist" aria-label="Leaderboard view"></div>
      <span class="meta" id="lb-count" aria-live="polite"></span>
    </div>
    <div id="entry-detail"></div>
    <div class="lb-head" aria-hidden="true"><span>Rank</span><span>Prize</span><span>Builder · entry</span><span>Judge win rate</span><span class="num">Size</span></div>
    <div id="lb-scroll" class="lb-scroll" tabindex="0" aria-label="Leaderboard entries, virtualized list">
      <div id="lb-spacer" class="lb-spacer"><div id="lb-window" class="lb-window"></div></div>
    </div>
    <p class="hint">Showing <span id="lb-shown">0</span> of <span id="lb-total">0</span> entries · scroll to load more rows · click a row for detail. <a href="#/leaderboard/${encodeURIComponent(b.slug)}">Open the full leaderboard →</a></p>`;
}

// ------------------------------------------------------------ saved ----

export function savedShell() {
  return `
    <div class="page-head">
      <p class="eyebrow">★ Saved</p>
      <h1>Saved bounties</h1>
      <p class="lede">Bounties you starred, kept in this browser only. Tap the star on any bounty to add it here, or tap it again to remove it.</p>
    </div>
    <div id="saved-rows" class="split-rows saved-list"></div>
    <p id="saved-empty" class="empty" hidden>No saved bounties yet. Tap the star on any bounty to keep it here.</p>`;
}
