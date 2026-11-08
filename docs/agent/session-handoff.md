# Session Handoff

Last updated: 2026-11-05 (round16, done). Update this file as work lands.

## Code baseline

- Branch `v2-smart-media`. Nothing is pushed: local commits are ahead of `origin/v2-smart-media`.
- HEAD at round16 start: `bfecd3beaf778ef2858650b2ce0640197459c684`. Round16 adds the two commits at the bottom of the table; the docs commit is the new HEAD (`git log -1`).
- Local commits from this work stream (oldest first). All are **not pushed**:

| Commit | Content | Status |
| --- | --- | --- |
| `83cb457` | G-21 media file access control | implemented, not accepted |
| `57eff8b` | G-24 owner/admin-only download routes | implemented, not accepted |
| `8c1dfc0` | G-27 + G-29 (write-route gate; 409 instead of crash) | implemented, not accepted |
| `bfecd3b` | `gallery.test.ts` binds test servers to 127.0.0.1 (known-issues 12a) | verified in isolation |
| `4ddab02` | remaining 21 server test files use the shared `server/test-support/localServer.ts` (127.0.0.1) | verified in isolation: 22 affected files 406/406; one full server run 1593/1593 |
| docs commit | G-21 browser acceptance on `4ddab02` recorded in `requirements.md`; this handoff file | see below |

## Working-tree changes that must stay uncommitted

These 10 items predate this work, or were explicitly kept out of commits. Do not stage them. Do not use `git add .`.

- `.kiro/specs/multi-user-system/requirements.md`: entries G-23, G-25, G-26 and G-28 only.
- `client/src/pages/AdminUserTripsPage.tsx`, `client/src/pages/UserSpacePage.tsx`: wording change "不公开" → "仅通过链接访问" only.
- `client/src/pages/SettingsPage.tsx`, `client/src/pages/UploadPage.tsx`: the user's earlier wording changes.
- Untracked: `.kiro/specs/_check_api_contract.py`, `.kiro/steering/risk-levels.md`, `client/src/pages/SettingsPage.test.tsx`, `client/src/pages/UploadPage.test.tsx`, `docs/ec2-new-resource-alert.md`.

Six protected files must keep their working-tree content: `AdminUserTripsPage.tsx`, `SettingsPage.tsx`, `UploadPage.tsx`, `UserSpacePage.tsx`, `SettingsPage.test.tsx`, `UploadPage.test.tsx`. Their SHA-1 reference is `travel-album-acceptance/g21/20261102T023422Z/round13-planb-commit/snapshot/protected-sha1-after.txt`.

## Must-read files

- `AGENTS.md`, `docs/agent/change-boundaries.md`, `docs/agent/verify-commands.md`.
- `docs/agent/known-issues.md`:
  - 12a: test port collision;
  - 12b–12e: test DB, trigger, clean-up and `markRunning` issues, registered and not fixed;
  - 12f: type checking does not cover tests;
  - 12g: thumbnail source, pending decision.
- `.kiro/specs/multi-user-system/requirements.md`: 需求 7 AC 8, 需求 9 AC 16–24, and entries G-21 to G-30.

## Commands that work

- Server: `cd server && npx tsc --noEmit`, `npm run build`, `npm test` (vitest `--run`).
- Client: `cd client && npx tsc -b`, `npm run build`, `npm test`.
- No lint script and no smoke script exist.
- **Do not run server tests in this checkout.** Tests open `server/data/travel-album.db`, the local app database (known-issues 12b). Use an isolated copy instead:
  `zsh <evidence>/round16-batch-local/tools/sync-isolated.sh /tmp/<dir>`. It copies the repository without the DB, uploads or secrets, and symlinks `node_modules`. Then run with `TEMP_DIR=/tmp/<dir>/tmp`.
- `tools/run.py <limit_s> <log> -- <cmd>` runs a command with a hard time limit and snapshots 127.0.0.1 listeners.
- Request-arrival probe: add `tools/diag-setup.ts` and `tools/vitest.g21diag.config.ts` to the isolated copy, and set `G21_DIAG_OUT=<file>`.
- Failure classification: `python3 tools/classify-failures.py <vitest log> <diag jsonl>`.
- Supplementary test type check: an isolated `tsconfig.*.json` that extends `server/tsconfig.json` with an explicit `include` list (the repository tsconfig excludes `*.test.ts`).

## Evidence

Root: `/Users/huang/Documents/kiro/travel-album-acceptance/g21/20261102T023422Z/`. It contains `README.md` (per-round index) and `MANIFEST.sha256` (re-generate it after adding files; never rewrite historical files).

- round9: G-29 concurrency.
- round10–13: plan-B candidate commits and the commit records.
- round14: diagnosis of the port collision.
- round15: gallery fix.
- round16: this batch. Copies of the tools are in `round16-batch-local/tools/`.

## Remaining tasks

Done in round16:
- No server test file uses `request(app)` any more; one full run passed 1593/1593. The earlier unconfirmed failures keep their categories.
- G-21 browser acceptance on committed code `4ddab02`:
  - no-cache group 51/51 PASS;
  - normal-cache group 50 PASS plus R2, the accepted AC 21 limitation.
  - Evidence: `round16-batch-local/g21-browser/`.
- G-21 is still implemented, not accepted: S3 and production are PENDING, and 12g is pending a decision.

Next tasks, directly executable:
1. Push decision: 25+ local commits are ahead of origin; nothing has been pushed.
2. S3 acceptance for G-21/G-24 (needs a real isolated S3 bucket). Production nginx/CDN check for G-22.
3. Decisions needed before code:
   - test DB isolation (12b);
   - thumbnail source (12g);
   - G-23, G-25, G-26, G-28, G-30;
   - G-27 `GET /segments` and `GET /compile/status`;
   - S3, production and deployment checks.
