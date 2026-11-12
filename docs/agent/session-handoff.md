# Session Handoff

Last updated: 2026-11-12 (round20). Update this file as work lands.

## Code baseline

- Branch `v2-smart-media`. Local commits are ahead of `origin/v2-smart-media`. Nothing is merged or deployed.
- Remote backup branch: `origin/backup/v2-smart-media-20261109`. It is only ever fast-forwarded. No workflow triggers on `backup/**`: deploy runs on `main`/`dev`, acceptance on `acceptance/**`, release on `v*` tags.
- CI acceptance branch: `origin/acceptance/g29-20261110` = `687903c` (tests only; run 42746181669, all success).
- Offline backup: `/Users/huang/Documents/kiro/travel-backups/v2-smart-media-6c823dd.bundle`, a git bundle of `origin/v2-smart-media..6c823dd`.
- Last verified code: the commits below, verified in isolated copies (evidence round16/round17). The docs commit on top is the current HEAD (`git log -1`).

| Commit | Content | Status |
| --- | --- | --- |
| `83cb457` | G-21 media file access control | implemented, not accepted |
| `57eff8b` | G-24 owner/admin-only download routes | implemented, not accepted |
| `8c1dfc0` | G-27 write routes + G-29 (409 instead of crash) | implemented, not accepted |
| `bfecd3b` | `gallery.test.ts` binds test servers to 127.0.0.1 (12a) | verified |
| `4ddab02` | other 21 test files use `server/test-support/localServer.ts` | verified: 1593/1593 |
| `6c823dd` | G-21 browser acceptance on `4ddab02` recorded; first handoff | docs |
| `d34eb3c` | G-27: `GET /segments`, `GET /compile/status` owner/admin only | verified: 116/116 affected, 1604/1604 full |
| `087a4c2` | test DB isolated from the application DB (12b) | verified with a mock app DB and sentinels |
| `687903c` | docs: G-27 read routes, G-29 condition check, handoff | **the code SHA that passed CI run 42746181669** |
| `4ac669a` | G-29 marked accepted; handoff (round18) | docs only, after CI; not itself CI-tested |
| `24e81a9` | G-27 browser regression on `4ac669a` recorded (round19) | docs only |
| `fc37c4e` | G-26 fix: CompilationPreview preview player uses `authorized` (one line, client only) | verified: client tsc, 289/289, build; browser 25/25 (round20); **not CI-tested** |
| round20 docs commit | round20 results; this handoff | docs only |

## Working-tree changes that must stay uncommitted

These 10 items predate this work, or were explicitly kept out of commits. Do not stage them. Do not use `git add .`. Stage paths one by one; for mixed files, write the intended blob with `git update-index --cacheinfo`.

- `.kiro/specs/multi-user-system/requirements.md`: the registrations G-23, G-25, G-26 and G-28 only (26 lines).
- `client/src/pages/AdminUserTripsPage.tsx`, `client/src/pages/UserSpacePage.tsx`: wording "不公开" → "仅通过链接访问" only.
- `client/src/pages/SettingsPage.tsx`, `client/src/pages/UploadPage.tsx`: the user's earlier wording changes.
- Untracked: `.kiro/specs/_check_api_contract.py`, `.kiro/steering/risk-levels.md`, `client/src/pages/SettingsPage.test.tsx`, `client/src/pages/UploadPage.test.tsx`, `docs/ec2-new-resource-alert.md`.

Six protected files must keep their working-tree content: `AdminUserTripsPage.tsx`, `SettingsPage.tsx`, `UploadPage.tsx`, `UserSpacePage.tsx`, `SettingsPage.test.tsx`, `UploadPage.test.tsx`. SHA-1 reference: `travel-album-acceptance/g21/20261102T023422Z/round13-planb-commit/snapshot/protected-sha1-after.txt`.

Avoid: `git add .`, force push, rewriting reviewed commits, pushing to `main`/`v2-smart-media`/`acceptance/**` without explicit approval, deploys, printing `.env`/secrets.

## Commands that work

- Server: `cd server && npx tsc --noEmit`, `npm run build`, `npm test`.
  - Since `087a4c2`, `npm test` uses a fresh per-run database under `os.tmpdir()/travel-album-vitest-<pid>`, with its own `TEMP_DIR` and `JWT_SECRET`. It refuses to open `server/data/travel-album.db`.
  - Tests still create and delete `server/uploads/<test trip id>` directories (known-issues 12b). Prefer an isolated copy for long runs.
- Client: `cd client && npx tsc -b`, `npm run build`, `npm test`.
- No lint script and no smoke script exist.
- Isolated copy: `git clone --no-hardlinks <repo> /tmp/<dir> && git -C /tmp/<dir> remote remove origin`, check out the commit, then symlink `server/node_modules` and `client/node_modules`. Alternatively, `<evidence>/round16-batch-local/tools/sync-isolated.sh /tmp/<dir>` copies the working tree, including the 10 kept changes.
- Tools (persistent copies in `<evidence>/round16-batch-local/tools/`):
  - `run.py <limit_s> <log> -- <cmd>`: run with a time limit and listener snapshots;
  - `diag-setup.ts` + `vitest.g21diag.config.ts`: request-arrival probe;
  - `classify-failures.py`: failure classification.
- Supplementary test type check: an isolated `tsconfig.*.json` that extends `server/tsconfig.json` with an explicit `include` list. The baseline is 286 pre-existing errors; compare new against baseline, and never widen excludes.
- G-27 browser regression: `<evidence>/round20-g26-fix-browser/scripts/` (latest; O7 only observes the CompilationPreview player) or `<evidence>/round19-g27-browser/scripts/` (`seed-r19.js`, `g27-r19.js`, `cdp.js`); environment and commands in `round19-g27-browser/RUN.txt`. Expects `/tmp/g21-r19/env` (clean clone, built, own data/uploads/.tmp), media in `/tmp/g21-r19/media` (keyframes every 1 s; merges use `-c copy`) and a server on 127.0.0.1:3131. Seeded `overall_score` must use the 0-100 scale (selector drops < 30).
- G-21 browser matrix: `<evidence>/round16-batch-local/g21-browser/` (`seed-env.js`, `g21.js`, `cdp.js`). The scripts expect `/tmp/g21-r2/env` (committed code, built, `server/public` = client dist), media in `/tmp/g21-r2/media` and a server on 127.0.0.1:3131.

## Acceptance status (2026-11-12)

| Item | Done, with evidence | Still missing |
| --- | --- | --- |
| G-21 | server tests; local-storage browser matrix on `4ddab02` (51/51 no-cache; 50/51 normal-cache plus R2 accepted limitation) | S3 (incl. AuthorizedImage CORS after 302), production check, CI run on the SHA; 12g thumbnail source is pending a decision and is not counted as passed |
| G-24 | server tests (17/17), local-storage browser (round3) | S3, production, CI on the SHA |
| G-27 | POST routes: server tests 31/31; GET routes: server tests 11/11 (round17; both in CI run 42746181669 @ `687903c`); local browser acceptance of owner editing flows: round19 on `4ac669a` 23/25 with O7-T1/T2 blocked by G-26; round20 on `fc37c4e` (G-26 fixed) 25/25 | S3, production, CI on the final SHA after the fix (run 42746181669 tested `687903c` and is history only) |
| G-29 | **accepted 2026-11-10**: reproduction (round6), process probe (round7), 18 concurrent bursts (round9), regression + cleanup (round10), full 1604/1604 (round17), CI run 42746181669 @ `687903c` (3× server 1604/1604, client 289/289; round18) | nothing for its scope; items listed as out of scope in the G-29 entry stay open |

R2 decision source: `.kiro/specs/multi-user-system/requirements.md`, G-21 entry, paragraph "**2026-11-02 R2 裁定**", and `<evidence>/README.md` § "结论与裁定（2026-11-02）". The ruling was made by the user in the session of 2026-11-02 and recorded in both places. It covers the same-document reuse only; new requests after revocation must still be refused.

## Evidence

Root: `/Users/huang/Documents/kiro/travel-album-acceptance/g21/20261102T023422Z/`. It contains `README.md` (per-round index) and `MANIFEST.sha256` (re-generate after adding files; never rewrite historical files).

- round9: G-29 concurrency.
- round10–13: plan-B commits.
- round14–15: port collision and the gallery fix.
- round16: localServer batch, G-21 browser, tools.
- round17: read routes and test DB isolation, push and backup records.
- round18: G-29 CI run (run.json, job logs, artifacts with vitest-results.json).
- round19: G-27 browser regression on current code (attempt1/2 = driver and test-data problems, kept; attempt3 = final, 23/25, O7 blocked by G-26).
- round20: G-26 fix `fc37c4e` and the same 25 items re-run: 25/25.

## Next steps for a new session

1. G-21/G-24/G-27 also need a CI run on their final SHA; `687903c` contains their code and passed CI run 42746181669, but the client fix `fc37c4e` has not been through CI. Their other missing items (S3, production) still block acceptance.
2. G-26 was confirmed in the browser (round19 O7: no token, 401) and fixed in `fc37c4e` (approved 2026-11-12; round20 O7 25/25). Its registration text sits in the 26 kept working-tree lines of `requirements.md` and still reads "代码推断、未实测"; updating it needs the user to decide on those kept lines.
3. S3 acceptance for G-21/G-24 and the production nginx/CDN check for G-22. These need a real isolated bucket and host access; do not create paid resources without approval.
4. Decisions needed before code: 12g thumbnail source; G-23, G-25, G-26, G-28, G-30; the test uploads directory (12b, still open).
