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
