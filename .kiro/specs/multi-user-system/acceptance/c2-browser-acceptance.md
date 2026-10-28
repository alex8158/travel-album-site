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

## Evidence archive (2026-10-28)

Both evidence directories above have been archived outside `/tmp` and outside every git work tree to:

`/Users/huang/Documents/kiro/travel-album-acceptance/c2/20261024T040116Z/`

- Layout: `evidence/` comes from `/tmp/kiro-browser-acceptance/evidence/20261024T040116Z/` (319 files) and `review/` from `/tmp/kiro-browser-acceptance/review/` (2 files). The archive root also holds `MANIFEST.sha256` (SHA-256 of all 321 archived files) and `ARCHIVE-REPORT.md` (inventory, method, redaction and exclusion tables, verification).
- Counts: 321 source files = 319 archived byte-identical + 2 archived as redacted copies + 0 excluded. Sizes: 9,667,526 bytes in the sources and 9,667,546 bytes in the archive; the 20-byte difference comes from the redaction markers.
- Integrity: `shasum -a 256 -c MANIFEST.sha256` gave 321 OK, 0 FAILED. Every unchanged file has the same SHA-256 as its source. The sources were re-hashed after copying, and both hash lists match the pre-copy lists, so the originals were not modified.
- Redaction: 2 files, 1 replacement each, kind `seeded-password`: `evidence/seeded.json` (still valid JSON) and `evidence/seed-A.log`. The network records already masked every Authorization header as `Bearer <redacted>`. No JWT, token value, `JWT_SECRET`, AWS key, private key, cookie or `.env` content was found. The re-scan of the archive is clean.
- Exclusions: none were needed. The sources contain no database files, no media files from the isolated `data/` or `uploads/`, no `.env*` and no keys. The `blocking/db-*.json` files are read-only JSON row snapshots and are kept.
- Missing files: none. Every evidence path cited by `results.md`, `results-A.md`, `review.md` and `review.json` resolves inside the archive. A few files referenced from outside the two source directories (`CHECKLIST.md`, `evidence/CURRENT_RUN.txt`, the driver directory, the clone's bundle and `routes/trash.ts`) were not in scope; they still exist under `/tmp/kiro-browser-acceptance/`, and their hashes are in `ARCHIVE-REPORT.md`.
- The `/tmp` originals are unmodified, but the OS may delete them. The archive above is the durable copy. Screenshots, network records, logs and the manifest are not committed to git.

Acceptance boundaries recorded above stay as written:
- The driver's failed attempts and the data restore between them are recorded in the archived `evidence/results.md` ("Driver attempts and data restore").
- "Set private" was done through the app's owner API (`PUT /api/media/:id/visibility`) because the client has no per-media visibility UI.
- Seek was tested inside the blob: `AuthorizedVideo` downloads the whole file without a Range request (trade-off O1, see `evidence/results-A.md`).

UI defect found during this acceptance and registered separately, outside C2: on highlighted photos in `/my/trips/<id>`, `HighlightBadge` covers the 🗑 delete button, so a click at the button's centre does nothing. This is registered as [`.kiro/specs/highlight-badge-delete-overlap/`](../../highlight-badge-delete-overlap/bugfix.md) with status 「已登记、未修复」, and its evidence references point at the archive above. It is not a C2 defect and does not change any row or verdict.

Spec tooling after this registration: 新增一个 bugfix spec，产物数 23→24；校验说明中的旧预期待单独更新。

Status is unchanged by the archive. C2 and BL-3 are accepted and closed. G-20 is closed only for the tier slideshow part. G-21, G-22 ("应用层已修复、部署配置未核实"), merged-video visibility, orphan cleanup and the performance items are unchanged.

## Not covered

G-22 stays "应用层已修复、部署配置未核实". G-21, merged-video visibility, orphan cleanup and the performance items stay open.
