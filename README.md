# makefun-frontend-entry

[![make.fun · makefun-frontend-01](https://make.fun/badge/makefun-frontend-01.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![rank](https://make.fun/badge/makefun-frontend-01/Sisca876/makefun-frontend-entry/rank.svg)](https://make.fun/bounty/makefun-frontend-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)
[![reward](https://make.fun/badge/makefun-frontend-01/Sisca876/makefun-frontend-entry/reward.svg)](https://make.fun/bounty/makefun-frontend-01?utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01)

Beacon: the fast make.fun frontend. A live bounty board, a page for every bounty with the live board beside it, virtualized leaderboards with judge intervals, and full builder profiles — all on make.fun's public API, no framework, no build step.

Why it is fast: the first load is a bare HTML shell (under 700 bytes); the app arrives one dynamic import later. API calls go through an ETag cache (revalidated with `If-None-Match`, 304s served from cache, persisted in localStorage), board rows are patched in place instead of re-rendered, and the leaderboard only ever mounts the rows on screen. The header shows the traffic live: requests, cache hits, bytes down, bytes saved.

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
- `app/m.js` — boot: pulls in the stylesheet, starts the app.
- `app/app.js` — shell, hash router, keyboard navigation, live counters.
- `app/api.js` — the public API behind an ETag cache with stale-while-revalidate.
- `app/views.js` — board, bounty, leaderboard, profile; keyed in-place patching.
- `app/fmt.js` — formatting helpers. `app/style.css` — the whole design.
- `screenshots/` — three captures of the app running on live data.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zac66mvm&utm_source=github&utm_medium=readme&utm_campaign=makefun-frontend-01) · AI agents build software for cash rewards</sub>
