# Session Handoff

Last updated: 2026-11-18 (round31). Update this file as work lands.

## Code baseline

- Branch `v2-smart-media`. Local commits are ahead of `origin/v2-smart-media`. Nothing is merged or deployed.
- Remote backup branch: `origin/backup/v2-smart-media-20261109`. It is only ever fast-forwarded. No workflow triggers on `backup/**`: deploy runs on `main`/`dev`, acceptance on `acceptance/**`, release on `v*` tags.
- CI acceptance branches (tests only, never moved after the run):
  - `origin/acceptance/g29-20261110` = `687903c` (run 42746181669, all success; history);
  - `origin/acceptance/final-3aa8581-20261112` = `3aa8581a98d505d521acf65fbef1b1129344d9db` (run 43151750642, all success; contains the G-26 fix `fc37c4e`);
  - `origin/acceptance/dedup-58a08cd-20261115` = `58a08cd692523f7742cf9daa98427f388e9b0895` (run 43725014890, all success; round27);
  - `origin/acceptance/node24-4693af0-20261117` = `7666ba83d540cc9b9a594b6831669f62d7fc0d1b` (Node 24 acceptance runs: 44078879196 @ `caf8c1a`, 44126066201 @ `b4fdaf9` (round30), 44223270585 @ `7666ba8` (round31), all success; fast-forward only).
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
| `fc37c4e` | G-26 fix: CompilationPreview preview player uses `authorized` (one line, client only) | verified: client tsc, 289/289, build; browser 25/25 (round20, run on this SHA) |
| `a92f60e` | round20 results; handoff | docs only |
| `3aa8581` | G-26 registration updated (round21) | docs only; **the code SHA that passed CI run 43151750642** (same code as `fc37c4e`) |
| `e1fea54` | round21 CI recorded; handoff (round22) | docs only, after CI; not itself CI-tested |
| `9cfe8ac` | isolated S3 results recorded (round23) | docs only; S3 runs used code `3aa8581` |
| `49e7c1e` | round24 fact corrections, round25 near-end status | docs only |
| `58a08cd` | in-flight de-dup of on-demand video thumbnail generation (`server/src/routes/mediaServing.ts` + `mediaServing.thumbnailDedup.test.ts`) | verified locally: tsc, mediaServing tests 40/40, server 1608/1608 (isolated clone, 3aa8581 + this change); **CI run 43725014890 success** (client 289/289, 3× server 1608/1608); near-end c7i.large 25/25 (round27) |
| `ee67690` | round26 handoff | docs only |
| `656c76e` | round27 handoff | docs only |
| `e8f4e55` | round28: G-27 S3 part recorded as passed; production read-only check; handoff | docs only |
| `4693af0` | round29: G-21/G-24 CI items closed; click finding; Node 24 local result; handoff | docs only |
| `caf8c1a` | acceptance.yml server and client jobs on Node 24 (verification only; deploy.yml and release.yml still 18) | CI run 44078879196 success (Ubuntu 26.04.1 x64, node v24.22.2, 3× 1608/1608, client 289/289) |
| `adffa3b` | VideoPlayer reserves a 16:9 box (max 60vh, contain) before the file arrives: fixes the regenerate-button layout shift | probe before 0/8 with 300-400 ms video delay, after 24/24 (landscape and portrait); round20 driver 25/25 |
| `b4fdaf9` | AC 21 headers on the 500 branches of /thumbnail, /original, /raw (2 tests, real router + globalErrorHandler, mutation-checked) | **CI run 44126066201 success on Node 24** (3× 1610/1610, client 289/289) |
| `f161bc4` | round30 status and handoff | docs only |
| `8945c56` | 12g: non-owner video thumbnails only from the current compiled file (`/api/media` thumbnail and `/uploads`); every compiled_path writer clears the pointer; real-ffmpeg colour test | reproduced on `f161bc4` (4/5 fail: red), after fix 5/5; mutation (no pointer clear) -> stale |
| `a30f1b6` | AC 24 error-branch headers: download-compiled 500 ×2, compile/download 404 (it has no 500 branch) | mutation-checked |
| `7666ba8` | owner video modal scrolls to its top when taller than the screen (narrow-screen finding) | **CI run 44223270585 success on Node 24** (3× 1618/1618, client 289/289) |
| round31 docs commit | status, known-issues 12g, this handoff | docs only |

## Working-tree changes that must stay uncommitted

These 10 items predate this work, or were explicitly kept out of commits. Do not stage them. Do not use `git add .`. Stage paths one by one; for mixed files, write the intended blob with `git update-index --cacheinfo`.

- `.kiro/specs/multi-user-system/requirements.md`: the registrations G-23, G-25 and G-28 only (20 lines; G-26 was committed in round21 with user approval).
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
- Kept-paragraph check (G-23/G-25/G-28 bytes): `node <evidence>/round22-docs-s3-prod-plan/reserved-proof/r22-para-bytes.js <evidence>/round22-docs-s3-prod-plan/reserved-proof/requirements.worktree-before-round21.md .kiro/specs/multi-user-system/requirements.md G-23 G-25 G-28` (expect 3 × IDENTICAL; the earlier `/tmp/g26-r20/out` copies no longer exist). Reserved-lines hash: `git diff <requirements.md> | grep '^+[^+]' | shasum` = `28cf47d6…`, 20 added lines.
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
| G-21 | server tests; local-storage browser matrix on `4ddab02` (51/51 no-cache; 50/51 normal-cache plus R2 accepted limitation); isolated S3 on `3aa8581` passed (round23: direct matrix, cross-origin fetch after 302, playback, revocation) | production check; 12g thumbnail source ruled and fixed in round31 (`8945c56`); `/uploads` exposure of originals/proxies is a separate open decision. (CI item closed in round29 on run 43725014890 @ `58a08cd`, per-clause mapping in `round29-node24-ci-click/RESULTS.md` §1) |
| G-24 | server tests (17/17), local-storage browser (round3); isolated S3 on `3aa8581` passed (round23); CI item closed in round29 (`compiledDownload` 17/17 in run 43725014890 @ `58a08cd`) | production |
| G-27 | POST routes: server tests 31/31; GET routes: server tests 11/11 (round17; both in CI run 42746181669 @ `687903c`); local browser acceptance of owner editing flows: round19 on `4ac669a` 23/25 with O7-T1/T2 blocked by G-26; round20 on `fc37c4e` (G-26 fixed) 25/25; post-fix CI: run 43151750642 @ `3aa8581` (3× server 1604/1604, client 289/289, typecheck and build; round21); S3: round23 isolated run **not passed** (22/25, then 15/21 + blocked; timeouts waiting for server-side S3 transfers); round25 t3 near-end 19/25 (CPU-credit throttled, inconclusive); round27 near-end on c7i.large: 25/25 on both `3aa8581` and `58a08cd` (isolated bucket, us-east-1); **S3 part passed** (round28 item-by-item check against the original requirements, `round28-s3-ruling-prod-readonly/S3-RULING.md`) | production (G-27 overall still implemented, not accepted) |
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
- round21: G-26 registration commit `3aa8581` and its CI run 43151750642 (run.json, job logs, artifacts).
- round22: byte-level proof that the kept G-23/G-25/G-28 paragraphs are unchanged; S3 and production acceptance plan (production wording corrected in round23 `PLAN-CORRECTION.md`).
- round23: isolated S3 acceptance (dedicated bucket + bucket-only role session, both deleted afterwards; `RESULTS.md`, `resources/`, `cleanup/`).
- round24: S3 timeout diagnosis (`FINDINGS.md`, `ROUND23-CORRECTION.md`, `analysis/`, `bench/`): direct Node/SDK path from this machine ~13-21 KB/s per stream vs 2-8 MB/s through the macOS system proxy that the AWS CLI uses; thumbnail-generation download amplification in round23 (attributed by temp-file time and size).
- round26: de-dup review and commit `58a08cd` (`REVIEW-DEDUP.md`, `verify/`), option 3 design v2 (`DESIGN-OPTION3.v2.md`), next near-end rerun plan (`NEAR-END-RERUN-PLAN.md`).
- round27: CI run 43725014890 @ `58a08cd` (`ci/`); near-end re-test on c7i.large us-east-1 (`RESULTS.md`, `results/`, `aws/`): base `3aa8581` 25/25, cand `58a08cd` 25/25 with driver v2; two earlier base attempts were harness faults (residue grep matched itself; coordinate click did not open the SegmentAdjuster), kept; cost ~US$0.045; all resources deleted, real bucket unchanged.
- round31: `round31-12g-g24-500-narrow/RESULTS.md`: 12g write-path inventory, reproduction and fix evidence (§2), G-24 error-branch tests (§3), narrow-screen probe incl. the modal-scroll fix (§4, `probe/`), CI `ci-7666ba8/`.
- round30: `round30-node24-ci-layout-500/RESULTS.md`: Node 24 CI runs (`ci1-caf8c1a/`, `ci2-b4fdaf9/`), layout fix before/after probe (`probe/SUMMARY.txt`), AC 21 500 tests and mutation log, 12g facts and recommendation (§4).
- round29: `round29-node24-ci-click/RESULTS.md`: G-21/G-24 CI clause mapping (closed); SegmentAdjuster pointer-click probe (`probe/`, cause: layout shift when the owner video arrives); Node 24.22.3 isolated run (`node24/`, `logs/`, `browser-r20-node24/`); migration proposal `node24-migration-proposal.patch` (not applied).
- round28: `S3-RULING.md` (original AC → 25 items → candidate logs/screenshots; S3 part passed), `PROD-READONLY.md` (production domain, host, SHA, Node and storage all unconfirmed), `NODE-RUNTIME-PLAN.md` (Node 24 check; better-sqlite3 11.10.0 has no Node 24 prebuild). Note: round27 `remote/drivers/*-vs-round23.diff` are round25 leftovers; correct diffs are in round28 `s3-ruling/`.
- round25: near-end re-test on a t3.medium in us-east-1 (all resources deleted; `RESULTS.md`): 26 MB direct download ~1 s; G-27 25 items 19 pass on both baseline `3aa8581` and the thumbnail de-dup candidate (uncommitted), O6-T2 compile timed out and 5 items did not run; the instance was CPU-credit throttled to 20 %, so the run does not isolate the app. Option 3 design in `DESIGN-OPTION3.md`.

## Next steps for a new session

1. G-27: the post-fix CI condition is met by run 43151750642 @ `3aa8581` (and run 43725014890 @ `58a08cd`); the S3 part passed in round28; production remains. G-21/G-24: S3 passed in round23, CI items closed in round29; production still blocks acceptance (12g fixed in round31).
2. G-26 was confirmed in the browser (round19 O7: no token, 401) and fixed in `fc37c4e` (approved 2026-11-12; round20 O7 25/25). Its registration was updated and committed in round21 (status: fixed, local browser re-check passed; full acceptance still follows the original conditions).
3. S3: round23 done (`<evidence>/round23-s3/RESULTS.md`): G-21 and G-24 S3 passed; G-27 owner flows did not pass in S3 mode. What is known now:
   - local evidence supports the de-dup behaviour (`58a08cd`: 5 concurrent requests -> 1 original download instead of 5; failures retried; per process only);
   - round25 near-end (us-east-1) had fast downloads (~1 s for 26 MB) but ran on a CPU-credit-throttled t3 (20 %) with a leftover ffmpeg from the base run at the start of the cand run, so it cannot show whether G-27 passes with sufficient CPU; 19/25 on both versions, O6-T2 failed, O7-T2, O8-T2, O9, O10, O11 never ran;
   - round27 near-end (c7i.large, Node 20.18.1, same driver/media/300 s waits for both): 25/25 on base and cand; the driver flow has no concurrent same-original thumbnail requests, so it does not evaluate de-dup (20 S3 downloads on both);
   - round28: G-27 S3 part recorded as passed after the item-by-item check (no gap; limitation noted: SegmentAdjuster clicks use `element.click()`, which skips hit-testing; the coordinate-click miss on the instance was not root-caused);
   - round29: cause of that miss located locally: the regenerate button sits under the owner `<video>`, which has no reserved height until its file arrives; when it arrives (~0.3-0.4 s later in the probe, as on the instance in S3 mode) the button moves ~215 px down and a pointer click aimed at the old position hits the video (0/4 with 300-400 ms video delay, 9/9 at local speed). UI layout shift, not access control; S3 ruling unchanged;
   - round30: fixed in `adffa3b` (16:9 frame); verified with the same pointer-click steps (after: 24/24 incl. portrait, button position unchanged when the video arrives);
   - option 3 (timeouts, cancellation): the six env names and defaults of design v2 are adopted ("0 = off"), **not implemented**. Constraints for the future implementation: shared thumbnail task not cancelled when a waiter disconnects; the two direct download routes cancel on client disconnect; accepted background tasks not cancelled; no bare `Promise.race`; isolate late results of sharp/save if they cannot be aborted; AbortError not retried and post-timeout cleanup + successful re-request must be proven by tests against the locked SDK;
   - Node 18 vs 20 (locked SDK declares `node >=20`; deploy.yml and release.yml still run 18, acceptance.yml runs 24 since `caf8c1a`) is a separate open question. Node 20 is EOL since 2026-04-30; 20.18.1 stays recorded as the round27 environment.
   - Node 24 (round28 read-only): pins in 3 workflows, `deploy/setup.sh`, `Dockerfile`; better-sqlite3 11.10.0 has no Node 24 prebuild (source build needed; first prebuild in 12.1.0, a dependency change). Plan and verification steps: `round28-s3-ruling-prod-readonly/NODE-RUNTIME-PLAN.md`. Not upgraded.
   - Node 24 (round29 isolated, macOS arm64, local storage): v24.22.3 / npm 11.19.1, locked `npm ci`; better-sqlite3 compiled from source (node-gyp ok), bcrypt and sharp used prebuilds; server tsc/build ok, tests 1608/1608 (per file = CI); client tsc/build ok, 289/289; round20 browser driver 25/25. Not proven locally: Linux x64, S3, Docker, CI, production.
   - Node 24 (round30 CI, Linux): acceptance runs 44078879196 and 44126066201 on Ubuntu 26.04.1 x64, node v24.22.2 / npm 11.19.1, all success; corrected in round31: install duration is not evidence of how better-sqlite3 was built; the log prints no build output, so the build method on CI is **unconfirmed** (only install + tests succeeding is confirmed). Round31 run 44223270585 @ `7666ba8` also success. Still not proven: S3 mode on Linux, Docker, production. The rest of `node24-migration-proposal.patch` (deploy.yml, release.yml, setup.sh, Dockerfile) is not applied.
4. Production (round28 read-only, `PROD-READONLY.md`): domain, host, running SHA, Node version and storage mode all **unconfirmed**. No album domain in the repo or Route 53; no running instance attributable to the album. The stopped `ai-agent-test` (`i-08306352b9f6f54c4`, created 2026-03-31 with `travel-album-key`, user-data = `deploy/setup.sh` at `ec0fed6`, last started 2026-07-14, the day of the real bucket's last write) is the likely original host, not proven. `keycloak` is not treated as the album host (502). `EC2_HOST` was updated 2026-05-15, after the last successful deploy (`f071202`, 2026-04-22). Needs: user confirmation of the host/domain, approval to start or inspect it, a deploy decision (outline in `PROD-READONLY.md`), production test accounts. Do not log into unconfirmed instances.
5. Decisions needed before code: whether AC 18 also applies to `/uploads` (it still serves a public compiled video's original upload and preview proxy to non-owners who know the path; 12g itself was ruled and fixed in round31); G-23, G-25, G-26, G-28, G-30; the test uploads directory (12b, still open).
