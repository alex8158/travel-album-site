# Session Handoff

Last updated: 2026-11-12 (round22). Update this file as work lands.

## Code baseline

- Branch `v2-smart-media`. Local commits are ahead of `origin/v2-smart-media`. Nothing is merged or deployed.
- Remote backup branch: `origin/backup/v2-smart-media-20261109`. It is only ever fast-forwarded. No workflow triggers on `backup/**`: deploy runs on `main`/`dev`, acceptance on `acceptance/**`, release on `v*` tags.
- CI acceptance branches (tests only, never moved after the run):
  - `origin/acceptance/g29-20261110` = `687903c` (run 42746181669, all success; history);
  - `origin/acceptance/final-3aa8581-20261112` = `3aa8581a98d505d521acf65fbef1b1129344d9db` (run 43151750642, all success; contains the G-26 fix `fc37c4e`).
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
| round22 docs commit | round21 CI recorded; this handoff | docs only, after CI; not itself CI-tested |

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
| G-27 | POST routes: server tests 31/31; GET routes: server tests 11/11 (round17; both in CI run 42746181669 @ `687903c`); local browser acceptance of owner editing flows: round19 on `4ac669a` 23/25 with O7-T1/T2 blocked by G-26; round20 on `fc37c4e` (G-26 fixed) 25/25; post-fix CI: run 43151750642 @ `3aa8581` (3× server 1604/1604, client 289/289, typecheck and build; round21) | S3, production |
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
- round22: byte-level proof that the kept G-23/G-25/G-28 paragraphs are unchanged; S3 and production acceptance plan.

## Next steps for a new session

1. G-27: the post-fix CI condition is met by run 43151750642 @ `3aa8581`; S3 and production remain. G-21/G-24: status unchanged by this round; their S3 and production items still block acceptance.
2. G-26 was confirmed in the browser (round19 O7: no token, 401) and fixed in `fc37c4e` (approved 2026-11-12; round20 O7 25/25). Its registration was updated and committed in round21 (status: fixed, local browser re-check passed; full acceptance still follows the original conditions).
3. S3 and production acceptance: plan and read-only findings in `<evidence>/round22-docs-s3-prod-plan/S3-PROD-PLAN.md`. S3 must use a new dedicated bucket: the app has no key-prefix setting and `7181-travel-album` holds data. Production host and running SHA are unconfirmed; the last successful auto-deploy was `f071202` (2026-04-22, before all fixes). Needs approval: test bucket and credentials, production host identity plus read-only SSH, and a deploy of the fixed code. Do not create resources or deploy without approval.
4. Decisions needed before code: 12g thumbnail source; G-23, G-25, G-26, G-28, G-30; the test uploads directory (12b, still open).
