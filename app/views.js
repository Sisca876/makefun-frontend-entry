// The four pages, as functions from API data to HTML, plus the keyed patcher
// that refreshes lists in place: rows are matched by key, only changed cells
// are rewritten, new rows slide in, gone rows leave. No full re-render, so a
// live refresh never steals scroll position, focus, or a text selection.

import { bytes, date, esc, money, moneyShort, ms, num, timeLeft, winRate } from './fmt.js';

/** The reward as it stands now: the prize plus any entry fees paid into it. */
const pot = (b) => Number(b.potUsd ?? b.rewardAmount ?? 0);

/** Re-render a keyed list without rebuilding it. `tag` is the row element. */
export function patchList(container, items, { tag, key, html, sig, visible }) {
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
      <a class="t" href="#/bounty/${encodeURIComponent(b.slug)}" data-prefetch="${esc(b.slug)}">${esc(b.title)}</a>
      <span class="sub">${esc(b.category || '')}${b.skills?.length ? ` · ${esc(b.skills.slice(0, 3).join(', '))}` : ''}</span>
    </td>
    <td class="c-pot num">${moneyShort(pot(b))}<span class="sub${Number.isFinite(fees) && fees > 0 ? ' fees' : ''}">${Number.isFinite(fees) && fees > 0 ? `+${moneyShort(fees)} fees` : 'prize'}</span></td>
    <td class="c-fee">${b.entryFeeUsd ? `<span class="fee">${money(b.entryFeeUsd)} fee</span>` : '<span class="free">free</span>'}</td>
    <td class="c-due ${urgent ? 'urgent' : closing ? 'soon' : ended ? 'ended' : ''}"><span data-countdown="${esc(b.deadline)}">${timeLeft(b.deadline)}</span><span class="sub">${date(b.deadline)}</span></td>
    <td class="c-n num">${num(b.submissionCount)}<span class="sub">entries</span></td>`;
}

const boardSig = (b) => [b.title, pot(b), b.entryFeeUsd, b.submissionCount, b.status, b.deadline].join('|');

export function boardShell() {
  return `
    <div class="page-head">
      <p class="eyebrow"><span class="live-dot"></span>Live · every bounty, updating</p>
      <h1>Live bounty board</h1>
      <p class="lede">Every bounty on make.fun, live from the public API. Type to filter · <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> move.</p>
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

export function boardVisible(b, tab, q) {
  const now = Date.now();
  if (tab === 'open' && b.status !== 'open') return false;
  if (tab === 'resolved' && b.status !== 'resolved') return false;
  if (tab === 'closing' && (b.status !== 'open' || new Date(b.deadline).getTime() - now > 86400000)) return false;
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
      ${b.kit ? `<a class="btn ghost" href="${esc(b.kit)}" target="_blank" rel="noopener">Kit</a>` : ''}
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
      ${p.image ? `<img class="avatar" src="${esc(p.image)}" alt="" width="84" height="84" onerror="this.style.display='none'">` : ''}
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
