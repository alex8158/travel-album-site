# Performance Optimization Mode

Use this mode when the user asks to improve runtime efficiency, processing speed, memory usage, upload speed, media pipeline throughput, frontend responsiveness, API latency, or build/runtime performance.

Performance optimization must be evidence-based.

Do not make broad refactors without identifying measurable bottlenecks first.

## Core Rules

* Do not optimize the entire codebase blindly.
* Do not rewrite architecture unless a measured bottleneck proves it is necessary.
* Do not add new dependencies unless the benefit is clearly justified.
* Do not change database schema unless required and approved.
* Do not change upload, deletion, AI provider, or deployment behavior unless directly related to the measured bottleneck.
* Preserve existing behavior and API contracts.
* Prefer small, reversible optimizations.
* Measure before and after whenever possible.

## Required Workflow

For broad performance requests, follow this workflow:

1. Run a performance audit first.
2. Identify likely bottlenecks.
3. Classify bottlenecks by area:

   * frontend rendering
   * API latency
   * database/query behavior
   * upload flow
   * image processing
   * video processing
   * AI/VLM calls
   * curation pipeline
   * polling/background jobs
   * build/deployment/runtime configuration
4. Rank findings by:

   * expected impact
   * implementation risk
   * affected modules
   * verification difficulty
5. Propose a staged plan.
6. Do not implement until the user approves a specific stage or task.

## Performance Audit Output

Before coding, report:

```
Current performance map:
- Area:
- Related files:
- Current behavior:
- Why it may be slow:

Bottleneck candidates:
- Candidate 1:
- Candidate 2:
- Candidate 3:

Priority:
- P0:
- P1:
- P2:

Proposed first optimization:
- What to change:
- Why this is low-risk:
- How to verify:

Do not change yet:
- Areas intentionally avoided:
```

## Implementation Rules

When implementing an approved performance task:

* Make the smallest safe change.
* Keep behavior unchanged unless the task explicitly requires behavior change.
* Add logging or measurement only when useful and not noisy.
* Avoid premature caching.
* Avoid duplicate processing.
* Avoid repeated API calls.
* Avoid repeated database queries.
* Avoid unnecessary AI/VLM calls.
* Avoid loading large media files into memory unless necessary.
* Avoid processing too many images/videos in one synchronous request.
* Avoid blocking the event loop with heavy work when a safer async/background path exists.

## Verification

Use docs/agent/verify-commands.md.

Report only commands that were actually run.

Current project has no lint script and no smoke script. Do not claim lint or smoke passed.

For backend performance changes, run at least:

```
cd server && npx tsc --noEmit
cd server && npm test
```

For frontend performance changes, run at least:

```
cd client && npx tsc -b
cd client && npm test
```

For build-related changes, run:

```
cd server && npm run build
cd client && npm run build
```

For runtime/API changes, run the health check when possible:

```
curl -s http://127.0.0.1:3001/api/health
```

## Final Report

After an approved optimization task, report:

```
Summary:
- What changed

Performance rationale:
- What bottleneck this addresses
- Why this should improve performance

Files changed:
- path/to/file

Verification:
- command: passed / failed / not run

Before/after evidence:
- Before:
- After:
- Not measured because:

Risk:
- Remaining risk

Next step:
- Recommended next optimization, if any
```
