# Observability Rules

This file defines how agents should use logs, metrics, state, and evidence when debugging, optimizing, or modifying this project.

The goal is to prevent guess-based fixes and make runtime behavior easier to understand.

## Core Principle

Agents must prefer evidence over guessing.

When investigating bugs, performance issues, stuck jobs, failed uploads, media processing problems, AI/VLM behavior, or frontend status issues, agents should look for observable evidence first.

Observable evidence includes:

* error messages
* stack traces
* logs
* request/response data
* run status
* stage status
* duration measurements
* input/output counts
* retry counts
* skipped-stage reasons
* API call frequency

## Required Observability Questions

Before fixing non-trivial runtime issues, agents should answer:

1. What operation failed or became slow?
2. Which stage or function was running?
3. What input was being processed?
4. What output was produced?
5. How long did it take?
6. Was the operation retried or repeated?
7. Was a fallback used?
8. Was an error swallowed or reported?
9. What did the frontend show?
10. What did the backend state actually say?

## IDs to Preserve in Logs

When adding or reading logs, prefer including relevant IDs:

* tripId
* runId
* mediaId
* requestId
* stage
* provider
* jobId, if available

Do not log secret values, API keys, private file paths containing credentials, tokens, or private key contents.

## Media Pipeline Observability

For upload, image analysis, deduplication, similarity grouping, AI review, curation, slideshow generation, or cleanup, agents should look for or add evidence about:

* stage name
* stage start time
* stage end time
* durationMs
* input count
* output count
* rejected count
* trashed count
* deleted count
* skipped count
* skip reason
* error reason
* fallback behavior

Important media states must remain distinct:

* rejected
* trashed
* permanently deleted
* excluded from curated output

Agents must not merge these states in logs or reports.

## Curation Pipeline Observability

For curation runs, agents should inspect or improve visibility into:

* current stage
* stage order
* stage duration
* stage input and output counts
* final selection count
* user pinned media count
* user unpinned media count
* AI-selected media count
* fallback path
* failure stage
* failure reason

If a curation run is stuck, agents should identify the last completed stage and the next expected stage.

## AI/VLM Observability

For AI or VLM-related behavior, agents should inspect or report:

* provider configuration
* provider availability
* env variable names checked
* why AI/VLM was enabled or disabled
* number of calls
* batch size
* timeout or error
* invalid response handling
* skipped-stage reason
* fallback behavior

Do not silently skip AI/VLM stages.

If AI/VLM is unavailable, report the exact non-secret reason.

## Performance Observability

For performance optimization, agents must avoid blind optimization.

Before changing code, inspect or estimate:

* which stage is slow
* duration by stage
* repeated work
* repeated API calls
* repeated database queries
* repeated embedding computation
* repeated AI/VLM calls
* frontend polling frequency
* blocking synchronous work
* large media processing behavior

When possible, report before/after evidence:

```
Before:
- operation:
- duration:
- count:

After:
- operation:
- duration:
- count:

If not measured:
- explain why
```

## Frontend Observability

For frontend status, progress, loading, or polling issues, agents should inspect:

* which component triggers the request
* polling interval
* cleanup behavior when component unmounts
* duplicate requests
* loading state
* error state
* API response shape
* backend status field

Do not fix frontend status issues by hiding backend errors.

## Logging Rules

When adding logs:

* Keep logs useful and concise.
* Include stage and relevant IDs.
* Include counts and duration when useful.
* Avoid noisy logs inside tight loops.
* Do not log secrets.
* Do not log entire large payloads or media contents.
* Prefer structured messages where practical.

Example:

```
[curation] runId=... tripId=... stage=L4_similarity start mediaCount=120

[curation] runId=... tripId=... stage=L4_similarity done durationMs=8320 selected=78 trashed=42

[ai-review] runId=... provider=openai-compatible available=false reason=missing_model skipped=true
```

## Error Reporting Rules

When catching errors, preserve useful context:

* operation
* stage
* relevant IDs
* error message
* whether fallback was used
* whether the run continues or fails

Do not swallow errors silently.

Do not convert all failures into generic "processing failed" without preserving internal reason.

## Final Report Requirement

When fixing or analyzing runtime issues, agents should report:

```
Evidence used:
- logs:
- state:
- error:
- files inspected:

Root cause:
- what failed or slowed down

Observable impact:
- what the user saw
- what the backend state showed

Fix:
- what changed

Verification:
- commands run
- result

Remaining visibility gap:
- what is still hard to observe, if anything
```
