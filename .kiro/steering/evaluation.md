# Evaluation Rules

This file defines how agents should evaluate whether changes actually improve behavior, quality, performance, or user experience.

Verification proves that code can run.

Evaluation proves that the result is better.

## Core Principle

For AI, media processing, curation, deduplication, performance, and user experience changes, agents must not rely only on typecheck, tests, or build success.

Agents should also explain how the result was evaluated or how it should be evaluated.

## Verification vs Evaluation

Verification answers:

* Does the code compile?
* Do tests pass?
* Does the build pass?
* Does the health check respond?

Evaluation answers:

* Did the user-facing result improve?
* Did processing become faster?
* Did duplicate/similar photos decrease?
* Did false positives or false negatives change?
* Did AI/VLM calls decrease?
* Did fallback behavior remain safe?
* Did the frontend show accurate progress and errors?

## When Evaluation Is Required

Agents must include evaluation notes for changes involving:

* image analysis
* blur detection
* duplicate detection
* similarity grouping
* global similarity
* AI/VLM review
* curation pipeline
* final selection
* slideshow generation
* upload performance
* video processing
* frontend progress or polling
* user-facing media quality
* performance optimization
* AI prompt or model behavior

## Evaluation Dimensions

Agents should evaluate relevant changes across these dimensions.

### Correctness

Check whether:

* upload results are correct
* curation run completes
* final selection is generated
* API response shape remains compatible
* user pins and unpins are respected
* rejected, trashed, deleted, and excluded states remain distinct

### Quality

Check whether:

* blurry media is handled correctly
* similar photos are reduced
* good photos are preserved
* user-preferred or pinned photos are preserved
* false positives are acceptable
* false negatives are acceptable
* slideshow output still looks reasonable

### Performance

Check whether:

* total processing time changed
* stage duration changed
* repeated work was reduced
* API requests were reduced
* frontend polling was reduced
* large media handling improved
* event loop blocking risk was reduced

### Cost

Check whether:

* AI/VLM call count changed
* batch size changed
* embedding computation is reused
* provider failures avoid repeated expensive retries
* deterministic local checks are used before expensive AI calls

### Stability

Check whether:

* large uploads still work
* 100+ image batches still work
* large videos do not block the main flow unnecessarily
* fallback behavior still works
* provider unavailable behavior is safe
* failed processing produces useful errors

### User Experience

Check whether:

* progress status is accurate
* loading state is not stuck
* error messages are understandable
* retry or rerun behavior is clear
* UI remains responsive
* final media output matches user expectations

## Suggested Evaluation Cases

Use these evaluation cases when relevant.

### Eval Case 1: Small Album Flow

Purpose:

* Verify the full flow works end to end.

Input:

* 10 images
* 2 videos

Check:

* upload succeeds
* media processing starts
* curation run completes
* final curated selection exists
* slideshow can be generated
* progress state is accurate

### Eval Case 2: Similar Photo Stress Test

Purpose:

* Evaluate deduplication and similarity cleanup.

Input:

* 50 to 100 images with several near-duplicate bursts

Check:

* obvious duplicates are removed or trashed
* cross-group similar photos are reduced
* good representative photos are preserved
* user-pinned media is preserved
* duplicate/global similarity stats are not double-counted

### Eval Case 3: Large Media Performance Test

Purpose:

* Evaluate processing performance and stability.

Input:

* 100+ images or one large video

Check:

* processing does not hang
* stage duration is reported when possible
* progress is visible
* no repeated unnecessary AI/VLM calls
* fallback behavior works
* frontend remains usable

## Before/After Evaluation

For performance or quality changes, agents should report before/after evidence when possible.

Format:

```
Before:
- scenario:
- metric:
- result:

After:
- scenario:
- metric:
- result:

Interpretation:
- improved / unchanged / worse
- confidence level
- remaining risk
```

If before/after cannot be measured, agents must say so and explain why.

## AI and Media Evaluation Rules

For AI or media behavior changes, agents should report:

```
Evaluation target:
- what behavior should improve

Expected improvement:
- fewer false duplicates
- fewer missed duplicates
- fewer VLM calls
- faster processing
- better representative photo selection

Possible regression:
- what could get worse

Suggested sample:
- what kind of album or media should be tested
```

## Do Not Overclaim

Agents must not claim that quality improved unless there is evidence.

Acceptable:

```
The code now performs a second survivor similarity pass. This should reduce cross-group near-duplicates. It still needs evaluation on a 50-100 image similar burst album.
```

Not acceptable:

```
Deduplication is now much better.
```

Acceptable:

```
The number of VLM calls should decrease because the change filters high-confidence pairs locally before AI review.
```

Not acceptable:

```
AI cost is optimized.
```

## Final Report Requirement

For relevant changes, agents must include:

```
Verification:
- typecheck/test/build/health check results

Evaluation:
- scenario used
- metric checked
- before result
- after result
- confidence
- remaining quality risk
```

If evaluation was not run, agents must report:

```
Evaluation:
- not run
- reason
- recommended evaluation case
```
