# Known Issues and Project Memory

This document records known project issues, historical pitfalls, and important implementation facts.

Agents must read this file when debugging, optimizing, or changing media processing, AI/VLM, curation, upload, deployment, or verification behavior.

The goal is to avoid repeating old mistakes.

## 1. No Lint or Smoke Command

### Issue

The project currently does not have a lint script.

The project currently does not have a smoke test script.

### Rule

Agents must not claim that lint or smoke tests passed unless those commands are added later.

Use the real verification commands in:

```
docs/agent/verify-commands.md
```

### Verification

Current known commands include:

```
cd server && npx tsc --noEmit
cd server && npm test
cd server && npm run build
cd client && npx tsc -b
cd client && npm test
cd client && npm run build
```

## 2. Secret Files Must Not Be Exposed

### Issue

The repository or uploaded project archive may contain sensitive files such as:

* `.env`
* `.pem`
* private keys
* API keys
* deployment credentials

### Rule

Agents may report that secret files exist, but must not print, summarize, copy, or expose secret values.

Agents must not modify production credentials unless explicitly requested.

Agents must not commit secret files.

## 3. Media State Meanings Must Stay Separate

### Issue

Media pipeline states can easily be confused.

The following are not the same:

* rejected
* trashed
* permanently deleted
* excluded from curated output

### Rule

Agents must clearly distinguish these states in code, logs, reports, and database updates.

Do not permanently delete user media unless explicitly requested.

Do not treat excluded media as deleted media.

Do not mix reject reason, trash reason, and final selection exclusion reason.

## 4. AI/VLM Provider Availability

### Issue

AI/VLM stages may be skipped if provider availability checks do not recognize the configured provider.

The project may use OpenAI-compatible environment variables or other provider-specific variables.

### Rule

Before changing AI/VLM behavior, agents must inspect:

* provider configuration
* environment variable names
* availability checks
* fallback behavior
* logs
* tests or mocks

Agents must not assume VLM is available.

Agents must not silently skip AI/VLM stages.

If an AI/VLM stage is skipped, report the non-secret reason.

## 5. Avoid Sending Too Many Items to VLM

### Issue

Large VLM batches can produce unstable results, hallucinations, or incomplete review.

### Rule

Prefer deterministic local checks first.

Use embedding, technical quality scoring, grouping, or pairwise similarity before VLM when possible.

Use VLM for gray-area review or group-level decisions, not massive unbounded batches.

## 6. Global Similarity Can Miss Cross-Group Duplicates

### Issue

Similar photos can survive if they are split into different initial groups.

A first-pass grouping strategy may miss cross-group near-duplicates.

### Rule

For similar-photo cleanup, consider a second global similarity pass over survivors.

This pass should avoid unnecessary VLM calls when deterministic embedding similarity and local quality scores are sufficient.

Agents must report whether a change affects:

* initial grouping
* group winner selection
* post-reducer review
* global similarity
* scene deduplication
* final curated selection

## 7. Duplicate Counting and Trash Reasons Can Be Double-Counted

### Issue

Deduplication, global similarity, and curation may count or classify the same media item in multiple ways.

This can cause confusing stats such as duplicate deleted count and global similarity trashed count overlapping.

### Rule

When changing statistics or trash logic, agents must define the primary reason for each media item.

Avoid double-counting the same item across multiple categories unless the UI explicitly supports multiple reasons.

## 8. Curation Pipeline Must Not Re-run Stages Accidentally

### Issue

AI review, scene deduplication, smart curation, or final selection logic can be accidentally run more than once if orchestration is unclear.

### Rule

Before modifying curation flow, agents must inspect the current stage order and call chain.

Agents must report whether the change affects:

* L2
* L3
* L4
* L5
* L6
* L7 finalize
* post-reducer AI review
* post-reducer scene deduplication

Do not duplicate a stage unless explicitly required.

## 9. User Pins and Unpins Must Be Preserved

### Issue

Final curated selection may combine AI-selected media with user-pinned and user-unpinned media.

### Rule

Agents must preserve user intent.

Final selection logic should respect:

* user pins
* user unpins
* AI current selection
* final curated output

Do not remove user-pinned media unless explicitly requested.

## 10. Performance Optimization Must Be Evidence-Based

### Issue

Broad performance requests can lead to unsafe refactors.

### Rule

For performance work, follow Performance Optimization Mode.

Agents must identify evidence before optimizing:

* stage duration
* repeated processing
* repeated API calls
* repeated AI/VLM calls
* frontend polling frequency
* large media behavior
* blocking synchronous work

Do not optimize the whole codebase blindly.

## 11. Documentation May Be Outdated

### Issue

Specs, design files, task files, and README sections may be older than the current code.

### Rule

Current code is the source of implementation truth.

When documentation and code disagree:

1. Report the mismatch.
2. Treat current code as implementation truth.
3. Do not silently implement outdated docs.
4. Pause only when the mismatch implies a high-risk change.

## 12. Node and Deployment Environment May Differ

### Issue

The deployment environment may have Node.js version constraints and system dependency differences.

Past deployment issues may include:

* Node version mismatch
* ffmpeg availability
* nginx config conflicts
* health check path differences

### Rule

Before changing deployment or runtime scripts, inspect current deployment files, setup scripts, and health check behavior.

Deployment changes are high risk and should pause for explanation before implementation.

## 12a. Random supertest ETIMEDOUT / ECONNRESET / foreign 404 on macOS

### Symptom

Server tests fail at random, a different set on each run: about 8 s `ETIMEDOUT`, `read ECONNRESET`, or a 404 whose body is `{}` or `Not Found`. The failures go away when the file is re-run alone. HEAD shows them too.

### Cause (reproduced on the development Mac, 2026-11-02)

`request(app)` makes supertest call `app.listen(0)`, which binds the dual-stack `::` wildcard, but then it connects to `127.0.0.1:<port>`. On that machine the OS handed out ephemeral ports that another local process (editors, Electron apps, helpers) already held on `127.0.0.1`, and the requests went to those processes. In a standalone experiment, 140 of 3000 `::` listeners failed this way; 0 of 3000 failed when bound to `127.0.0.1`. This was reproduced on one machine only; it has not been checked on other macOS setups or on CI. Two earlier failures closely match this mechanism, but they were logged without the port or response headers and could not be confirmed one by one. Evidence: `travel-album-acceptance/g21/20261102T023422Z/round2/port-experiment/`.

### Rule

Do not treat these failures as product bugs, or as passes, without the response headers or an error with the port. Do not fix them by retrying, lengthening timeouts, or sharing one server. A per-request server bound to `127.0.0.1` avoids the problem; see `local()` in `server/src/routes/mediaServing.test.ts`. The other test files still use the default and remain exposed.

## 12b. Server tests run against the local app database

Registered 2026-11-05 (G-29 pre-commit review). Not fixed.

### Verified facts

* `server/src/database.ts` lines 11–15 always open `server/data/travel-album.db`. That file reads no environment variable, so tests cannot be pointed at another database file.
* `server/vitest.config.ts` runs every test file in one process (`fileParallelism: false`, `singleFork: true`), so all test files share that one database file.
* Whole-table deletes, checked statement by statement (static reading, 2026-11-05; not executed against a real local database). The first pass was a rough grep, which matched 30 test files. Each match was then read in full: comment lines dropped, and every `DELETE FROM <table>` with no `WHERE` kept. The result is 264 such statements in the same 30 test files. Every one sits in a `db.exec(...)` / `db.prepare(...)` call, inside a `beforeEach` (`gallery.property.test.ts` also has some in an `afterEach`). The full per-file list, with line numbers and table names, is in `travel-album-acceptance/g21/20261102T023422Z/round13-planb-commit/registration/unscoped-deletes.txt`.
  * Tables most often emptied: `trips`, `media_items`, `video_segments`, `compile_jobs`, `media_tags`, `duplicate_groups`, `upload_sessions`. Some files also empty `processing_jobs`, `processing_job_events`, `merged_video_sources`, `media_analysis`, `media_versions`, `ai_invocations`, highlight/slideshow tables, or `users`.
  * Batch files among them: `mediaServing.test.ts` (lines 184–191), `mediaServing.s3.test.ts` (101–108) and `compiledDownload.test.ts` (108–115) each empty 8 tables: `compile_jobs`, `duplicate_groups`, `media_items`, `media_tags`, `merged_video_sources`, `trips`, `upload_sessions`, `video_segments`. `gallery.test.ts` (lines 88–94) empties 7 of them, all but `merged_video_sources`.
  * `mediaWriteOwnership.test.ts` counts as one statement: line 175, a `DELETE FROM ${t}` loop in its `beforeEach` over 10 tables (`processing_job_events`, `processing_jobs`, `compile_jobs`, `video_segments`, `merged_video_sources`, `media_tags`, `upload_sessions`, `media_items`, `duplicate_groups`, `trips`). This is the G-27 whole-table clean-up that was deferred. It is **not** that file's `afterEach` clean-up (`cleanupTripTestData`), which deletes only rows tied to the trip ids the test registered. `clipsJobConflict.test.ts` has no whole-table delete since round10.
* `users`: 14 test files empty the whole `users` table (each `DELETE FROM users` has no `WHERE`, or `users` is in a loop's table list). `uploadsAccess.test.ts` deletes users only by id. 27 test files contain `INSERT INTO users` (text match). `clipsJobConflict.test.ts` (line 96) and `mediaWriteOwnership.test.ts` (line 119) insert users and never delete them.
* Every `getDb()` after `closeDb()` runs the restart cleanup in `database.ts` lines 925–950, which marks **all** `running`/`queued` jobs as `failed` (`服务重启，任务中断`). Many tests call `closeDb()` after each test. An isolated sentinel run confirmed this: a running job belonging to another trip was flipped to `failed` (evidence `travel-album-acceptance/g21/20261102T023422Z/round9-g29-review/sentinel/`).

### Impact (inferred from code; not reproduced against a real local database)

Running `npm test` inside the repository checkout would read and write the developer's local app database. Whole-table deletes would remove local trips, media rows and jobs. Test users would accumulate. Running or queued local jobs would be marked failed. This concerns local development data only. There is no evidence of a production fault.

### Rule

Until tests get their own database, run server tests only in an isolated copy with its own `server/data`, `server/uploads` and `TEMP_DIR` (pattern: `travel-album-acceptance/g21/20261102T023422Z/round10-g29-beforeeach/tests/sync.sh`).

## 12c. A killed test run can leave the `g29_test_block` trigger behind

Registered 2026-11-05. Not fixed.

### Verified facts

* Only the test "other database errors on job creation return 500 and the app keeps serving" in `server/src/routes/clipsJobConflict.test.ts` creates the trigger (line 210). It is dropped before creation (line 209), in `finally` (line 220), and in the file's `beforeEach` (line 140) and `afterEach` (line 150).
* The trigger makes every `INSERT INTO processing_jobs` fail with `g29 simulated failure`.
* This happened once, in an isolated database: a mutation-check run hit its time limit, the trigger survived, and it polluted the next full-suite run (evidence `round7-g29-fix/`, full-suite round 1).

### Trigger condition and impact

The trigger survives only if the test process is killed (time limit, SIGKILL, crash) between lines 210 and 220. Normal completion and thrown errors both reach `finally`. Once it survives, every later job insert in the same database file fails, until this test file runs again and its `beforeEach` drops the trigger. Test files that run before it in the same run are affected. Because of 12b, this would include the local app database if tests were run inside the repository.

### Rule

After a killed or timed-out server test run, check for the trigger before trusting later results: `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'g29_test_block'`.

## 12d. A cleanup error in G-27/G-29 tests skips `closeDb()` and mock restore

Registered 2026-11-05. Not fixed. Read from the code; not reproduced.

### Verified facts

* `cleanupTripTestData` (same function in `clipsJobConflict.test.ts` line 73 and `mediaWriteOwnership.test.ts` line 79) throws `cleanup: N test job(s) still active …` when a registered trip still has a `queued`/`running` job after about 3 s (150 × 20 ms).
* In `clipsJobConflict.test.ts` `afterEach` (lines 147–153), the throw skips `vi.restoreAllMocks()` and `closeDb()`. In `mediaWriteOwnership.test.ts` `afterEach` (lines 189–192), `vi.restoreAllMocks()` already ran, and only `closeDb()` is skipped.

### Impact (inferred)

The first error is explicit. Later tests may then fail in a cascade: the connection stays open, spies stay installed, and the registered rows are left behind, so a later whole-table `DELETE FROM trips` can fail on the foreign key. Read later failures in that run with this in mind.

## 12e. `markRunning()` after the 202 is outside `try` in `clips.ts`

Registered 2026-11-05. Not fixed. Code inference; not reproduced.

### Verified facts

* In `server/src/routes/clips.ts`, `/clips`, `/merge` and `/re-edit` send the 202 (lines 97, 190, 330) and then call `reporter.markRunning()` (lines 101, 194, 333) before their `try` block. HEAD has the same order (lines 84, 162, 280). G-29 did not change this.
* `JobProgressReporter.markRunning()` (`server/src/services/jobProgressReporter.ts` line 40) runs an `UPDATE` with no error handling.
* The other call sites, `routes/process.ts:171` and `routes/processJobs.ts:159`, were not checked.

### Impact (inferred)

If that `UPDATE` throws, the async handler's promise is rejected with no handler, after the response was already sent. On the Node version in use, an unhandled rejection ends the process by default. The job would stay `queued` until the restart cleanup marks it failed. No such failure has been observed.

## 12f. Type errors in G-24 / G-27 test files: resolved; test files still not type-checked by default

Registered 2026-11-05. **The three type errors in this batch are resolved.** The coverage gap below is **still open**.

### Still open: the standard check does not cover tests

The standard `cd server && npx tsc --noEmit` does not check tests (`server/tsconfig.json` excludes `**/*.test.ts`), and vitest does not type-check. Type errors in server test files therefore stay invisible to the standard verification commands. Fixing the three errors does not change this.

### Resolved: the three errors found in this batch

* All three errors were found with a separate isolated check (evidence `round11-g29-precommit-review/typecheck/`):
  * `server/src/routes/mediaWriteOwnership.test.ts` line 187: `TS2322`, a `vi.spyOn(...)` result assigned to `let download: ReturnType<typeof vi.spyOn>` (declared at line 170);
  * `server/src/routes/mediaWriteOwnership.test.ts` line 200: `TS2345`, the header list `[{}, { Authorization: 'Bearer not-a-token' }]` (line 199) passed where `Record<string, string>` is expected;
  * `server/src/routes/compiledDownload.test.ts` line 135: `TS2345`, the same header-list pattern (line 134).
* Neither file is tracked or present in HEAD. The lines appear in the G-27 snapshot (`round5-g27-impl/snapshot/`) and the G-24 snapshot (`round3-g24/snapshot/`, byte-identical to the current file). They are part of the pending batch, not older code.
* `clipsJobConflict.test.ts` and the batch helpers have no type errors in the same check. The other G-21 test files in the batch (`mediaFileAccess.test.ts`, `mediaServing.test.ts`, `mediaServing.s3.test.ts`, `gallery.test.ts`) have none either.
* Fix (approved 2026-11-05, type annotations only; no request, assertion, clean-up or runtime change): `import { …, type MockInstance } from 'vitest'`; `let download: MockInstance<(relativePath: string) => Promise<string>>`; the header list annotated `as Array<Record<string, string>>` in both files.
* Verification (isolated copies): the supplementary check `tsc -p tsconfig.batchtests.json` exits 0 after the fix. `compiledDownload`, `mediaWriteOwnership` and `clipsJobConflict` pass 57/57. In each plan-B candidate commit, the same check exits 0 for the batch test files that commit contains (evidence `round11-g29-precommit-review/typecheck/fix-proposal/`, `round12-planb-candidates/verify/c2/`, `round12-planb-candidates/verify/c3/`).

## 12g. Thumbnails for public videos may be generated from the original upload

Registered 2026-11-05. **Pending decision.** Not changed.

### Verified facts (code reading)

* `GET /api/media/:id/thumbnail` (`server/src/routes/mediaServing.ts`, route at line 144): for a non-owner request on an ordinary video, the G-21 gate first requires an available compiled file (line 150). If no stored thumbnail exists (lines 159–168), the route generates one from `row.file_path`, the **original upload** (line 178, then `generateVideoThumbnail` at line 180), and saves it as `thumbnail_path` (line 182).
* HEAD generated thumbnails from `file_path` in the same way (HEAD `mediaServing.ts` lines 138–141). G-21 added the access gate and did not change the thumbnail source.
* Where thumbnails stored by other code paths come from (upload pipeline, `thumbnailGenerator.ts`, `proxyGenerator.ts` and others) was not checked.

### Not reproduced

A frame that was cut from the compiled video could appear in the public thumbnail. This has not been reproduced and no such case has been observed.

### Decision needed

Whether a thumbnail shown to non-owners must come only from the compiled file that may be made public. AC 18 (需求 9) gates the thumbnail on the compiled file being available, but does not say where the thumbnail comes from.

## 13. What Agents Should Update Here

Agents should update this file when they discover:

* a recurring bug pattern
* an outdated assumption
* a dangerous project-specific rule
* a verification command change
* a media pipeline pitfall
* an AI/VLM behavior pitfall
* a deployment caveat
* a decision that prevents future confusion

Do not add temporary one-off errors unless they are likely to recur.
