# C2 real-browser acceptance record

Date recorded: 2026-10-28. Runs: part A 2026-10-27 15:02–15:03Z, part B 2026-10-28 02:41–03:02Z.

## Result

All 54 rows PASS. An independent review of the raw evidence verified every row (verdict APPROVED, 0 failed checks).

C2 (需求 9 AC 15, tier slideshow read rule), BL-3 and the tier slideshow part of G-20 are accepted as of 2026-10-28.

| Rows | Scope | Result |
|---|---|---|
| A1–A4 | owner, `/my/trips` and `/trips`, public and unlisted: play and seek | PASS |
| A5–A8 | admin, same four cases | PASS |
| A9–A10 | ordinary non-owner, `/trips`, public and unlisted | PASS |
| A11–A12 | anonymous, `/trips`, public and unlisted | PASS |
| Bn.1 ×6 | before each operation: valid video plays and seeks (anonymous) | PASS |
| Bn.2 ×6 | operation on source photo: private, trash, permanent delete (each on its own public and unlisted trip) | PASS |
| Bn.3 ×6 | after, anonymous: re-fetch gives `slideshowUrls: {}`, no video requested, old URL 404 in new tab and fetch | PASS |
| Bn.4 ×6 | after, ordinary non-owner: same as anonymous, fetch with token 404 | PASS |
| Bn.5 ×6 | after, owner: published row only, plays and seeks (AC 5) | PASS |
| Bn.6 ×6 | after, admin: same as owner | PASS |
| Bn.7 ×6 | no fallback to an older or historical file | PASS |

Owner and admin keep the published row after the operation, as 需求 9 AC 5 and AC 12 and the 2026-10-09 C2 note allow. Those cells were judged against the contract.

## Environment

- Code under test: clean clone at `c17be3040f6b007d20caa8ec9f629d9e999da4ee`.
- CI at the same SHA: https://github.com/alex8158/travel-album-site/actions/runs/38045557514 (success; Node v18.20.8, ffmpeg 6.1.1).
- Browser: Google Chrome headless (`--headless=new`), driven over the DevTools protocol. Part A Chrome 156.0.8078.48, part B 156.0.8078.49. Fresh profile per session, cache disabled, hard reload.
- Node (driver and isolated server): v25.2.1.
- Client mode: production build from the clone, served by the isolated server on `http://127.0.0.1:3001` (no Vite).
- Data: isolated DB, uploads and TEMP_DIR under `/tmp/kiro-browser-acceptance/`. The repo DB and `server/uploads` were not used.

## Notes

- The private operation used the app's own `PUT /api/media/:id/visibility` from the owner's logged-in page, because the client has no per-photo private control.
- Failed driver attempts and the data restore between them are recorded in the evidence `results.md`.

## Evidence

Raw evidence (screenshots, network logs, playback JSON, DB snapshots, server logs) is kept outside the repo:

- `/tmp/kiro-browser-acceptance/evidence/20261024T040116Z/` (`results.md`, `results-A.md`, `review.md`, `review.json`)
- `/tmp/kiro-browser-acceptance/review/`

## Not covered

G-22 stays "应用层已修复、部署配置未核实". G-21, merged-video visibility, orphan cleanup and the performance items stay open.
