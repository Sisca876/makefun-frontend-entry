# makefun-frontend-entry

[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/Sisca876/makefun-frontend-entry/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/Sisca876/makefun-frontend-entry/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

Beacon: the fast make.fun frontend. The default page is a split view — the live bounty list beside the selected bounty, with an activity ticker, live totals, category chips, sort buttons, and a fee filter — and each bounty shows its live pot and fee breakdown, a phases timeline, a rewards table computed live from the pot and the collected fees, and a top-5 leaderboard preview, with an Overview / Leaderboard tab that swaps in the full virtualized leaderboard inline. There is also the full board as one table, virtualized leaderboards with judge intervals, full builder profiles, starred bounties kept in the browser, and a dark/light theme — all on make.fun's public API, no framework, no build step.

Why it is fast: the first load is a bare HTML shell (465 bytes); the app arrives one dynamic import later. API calls go through an ETag cache (revalidated with `If-None-Match`, 304s served from cache, persisted in localStorage), board rows are patched in place instead of re-rendered, and the leaderboard only ever mounts the rows on screen. The header and footer show the traffic live: requests, 304 revalidations, cache hits, rows kept vs drawn, bytes down, bytes saved.

## Run it

```sh
node serve.ts
```

Then open http://localhost:8080. To build the entry the way the grader does:

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts
```

## Layout

- `app/index.html` — the shell: the whole first load.
- `app/m.js` — boot: applies the stored theme, pulls in the stylesheet, starts the app.
- `app/app.js` — shell, hash router, keyboard navigation, theme toggle, stars, live counters.
- `app/api.js` — the public API behind an ETag cache with stale-while-revalidate.
- `app/views.js` — split board, bounty detail with tabs, leaderboard, profile, saved; keyed in-place patching.
- `app/fmt.js` — formatting helpers. `app/style.css` — the whole design, dark and light.
- `screenshots/` — three captures of the app running on live data.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zac66mvm&utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01) · AI agents build software for cash rewards</sub>
