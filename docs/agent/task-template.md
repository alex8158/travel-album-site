# Agent Task Template

This document defines the standard task execution template for AI coding agents working in this repository.

Agents must use this template when implementing, debugging, reviewing, or modifying code.

The goal is to make every task clear, scoped, verifiable, and easy to review.

## 1. Task Summary

Before doing any work, restate the task briefly.

Format:

```
Task:
- What needs to be done

Expected outcome:
- What should be true after the task is complete

Scope:
- Which part of the project is likely affected
```

Example:

```
Task:
- Fix global similarity deduplication missing similar photos across groups.

Expected outcome:
- Similar photos that survive earlier grouping should be checked again globally before final curation.

Scope:
- Server media curation pipeline only.
- No frontend changes unless explicitly required.
```

## 2. Scope Rules

Agents must keep the task narrow.

Unless the user explicitly asks for it, do not:

* Add unrelated features
* Refactor large modules
* Change UI design
* Change database schema
* Change deployment scripts
* Change upload behavior
* Change authentication or authorization behavior
* Add new dependencies
* Rename existing public APIs
* Rewrite unrelated documentation
* Modify tests only to hide a real failure

If a broader change seems necessary, report it first and explain why.

## 3. Before Coding Checklist

Before changing code, inspect the repository.

For every task, agents must first search for existing implementation.

General search commands:

```
find . -maxdepth 4 -type f | sort

grep -R "keyword" -n server client docs .kiro 2>/dev/null
```

For backend/API tasks, check:

* Existing routes
* Existing handlers/controllers
* Existing services
* Existing repository methods
* Existing types
* Existing tests
* Existing error handling

For frontend tasks, check:

* Existing pages
* Existing components
* Existing API clients
* Existing hooks
* Existing state handling
* Existing loading and error states

For media pipeline tasks, check:

* Existing upload flow
* Existing media analysis flow
* Existing deduplication logic
* Existing similarity grouping logic
* Existing AI/VLM review logic
* Existing curation pipeline
* Existing slideshow generation logic
* Existing fallback behavior

For AI/VLM tasks, check:

* Provider configuration
* Environment variable names
* Availability checks
* Fallback behavior
* Error handling
* Logging
* Tests or mocks

## 4. Fact Report Before Implementation

Before coding, report the current facts.

Format:

```
Current facts:
- Found file/path/function:
- Found existing behavior:
- Found related tests:
- Found related docs:

Potential conflict:
- Requirement says:
- Current code does:

Proposed minimal change:
- Change 1:
- Change 2:

Risk:
- Risk 1:
- Risk 2:
```

If the user asked to analyze first, do not modify files until the user confirms.

If the current code conflicts with old documentation, prioritize current code as implementation truth and report the mismatch.

## 5. Implementation Rules

When implementing, agents must:

* Make the smallest safe change
* Preserve existing architecture
* Preserve existing behavior unless the task requires a change
* Keep naming consistent with nearby code
* Avoid duplicate logic
* Avoid duplicate endpoints
* Avoid hard-coded configuration unless explicitly required
* Add or update tests when practical
* Keep frontend, backend, and media pipeline changes separated when possible

Agents must not silently skip difficult parts.

If something cannot be completed, report:

* What was attempted
* What blocked completion
* What remains to be done
* How to verify the partial result

## 6. Verification Requirements

Use the verification commands defined in:

```
docs/agent/verify-commands.md
```

Relevant commands include:

Server typecheck:

```
cd server && npx tsc --noEmit
```

Server build:

```
cd server && npm run build
```

Server test:

```
cd server && npm test
```

Client typecheck:

```
cd client && npx tsc -b
```

Client build:

```
cd client && npm run build
```

Client test:

```
cd client && npm test
```

Health check when backend is running directly on port 3001:

```
curl -s http://127.0.0.1:3001/api/health
```

Health check when behind nginx:

```
curl -s http://127.0.0.1/api/health | jq
```

Important:

* Do not claim lint passed because this project currently has no lint script.
* Do not claim smoke passed because this project currently has no smoke script.
* Do not claim verification passed unless the command was actually run.
* If a command was skipped, explain why.

## 7. Minimum Verification Matrix

Use this matrix to decide what to run.

Backend-only code change:

```
cd server && npx tsc --noEmit
cd server && npm test
```

Frontend-only code change:

```
cd client && npx tsc -b
cd client && npm test
```

Shared behavior or API contract change:

```
cd server && npx tsc --noEmit
cd server && npm test
cd client && npx tsc -b
cd client && npm test
```

Build, deployment, or production behavior change:

```
cd server && npm run build
cd client && npm run build
```

Runtime API change:

```
curl -s http://127.0.0.1:3001/api/health
```

Media pipeline change:

```
cd server && npx tsc --noEmit
cd server && npm test
```

Also report:

* Input sample used, if any
* Output behavior observed, if any
* Logs checked, if any
* Fallback behavior, if relevant

## 8. Final Report Template

After implementation, report in this format:

```
Summary:
- What changed

Files changed:
- path/to/file
- path/to/file

Verification:
- cd server && npx tsc --noEmit: passed / failed / not run
- cd server && npm test: passed / failed / not run
- cd client && npx tsc -b: passed / failed / not run
- cd client && npm test: passed / failed / not run
- cd server && npm run build: passed / failed / not run
- cd client && npm run build: passed / failed / not run
- health check: passed / failed / not run

Notes:
- Important implementation detail
- Known limitation
- Risk

Next step:
- Recommended next action, if any
```

Do not mix actual verification results with recommended commands.

## 9. Review-Only Task Template

Use this when the user asks to review, inspect, or analyze without changing code.

```
Review task:
- What is being reviewed

Files inspected:
- path/to/file
- path/to/file

Findings:
- Finding 1
- Finding 2

Severity:
- Must fix:
- Should fix:
- Nice to have:

Recommendation:
- Recommended next action
```

For review-only tasks, do not modify files.

## 10. Bugfix Task Template

Use this when the task is a bugfix.

```
Bug:
- What is broken

Expected behavior:
- What should happen

Actual behavior:
- What currently happens

Reproduction:
- Step 1
- Step 2
- Step 3

Root cause:
- Current suspected cause

Minimal fix:
- Change 1
- Change 2

Verification:
- Command or manual check
```

Bugfix rules:

* Confirm the bug exists before fixing when possible.
* Prefer fixing root cause over masking symptoms.
* Do not remove tests to make the bug disappear.
* Add regression coverage when practical.

## 11. Feature Task Template

Use this when the task is a new feature.

```
Feature:
- What should be added

User value:
- Why this matters

Scope:
- Included:
- Excluded:

Existing related code:
- path/to/file
- path/to/file

Implementation plan:
- Step 1
- Step 2
- Step 3

Verification:
- Command or manual check
```

Feature rules:

* Do not expand beyond the requested feature.
* Do not introduce new architecture unless necessary.
* Do not add new dependencies without justification.
* Preserve existing behavior.

## 12. Media Pipeline Task Template

Use this for image, video, deduplication, AI review, curation, or slideshow tasks.

```
Media task:
- What media behavior should change

Affected stage:
- Upload
- Analysis
- Blur detection
- Duplicate detection
- Similarity grouping
- AI/VLM review
- Curation
- Slideshow generation
- Cleanup

Current pipeline facts:
- Existing stage:
- Existing function:
- Existing fallback:
- Existing storage behavior:

Proposed change:
- Change 1
- Change 2

Safety:
- Does this reject media?
- Does this trash media?
- Does this permanently delete media?
- Does this affect user-pinned media?
- Does this affect final curated selection?

Verification:
- Typecheck
- Tests
- Sample input/output, if available
```

Media pipeline rules:

* Do not permanently delete media unless explicitly requested.
* Preserve fallback behavior unless explicitly requested.
* Clearly distinguish rejected, trashed, deleted, and excluded states.
* Do not mix AI review, scene deduplication, and final selection unless the task requires it.
* Report whether the change affects global similarity, scene deduplication, or final curation.

## 13. AI/VLM Task Template

Use this for AI provider, VLM review, AI scoring, prompt, or model behavior changes.

```
AI/VLM task:
- What AI behavior should change

Provider facts:
- Existing provider:
- Existing env variables:
- Existing availability check:
- Existing fallback:

Affected stage:
- Analysis
- Similarity review
- Group winner selection
- Post-reducer review
- Scene deduplication
- Final selection

Proposed change:
- Change 1
- Change 2

Failure behavior:
- What happens if provider is unavailable?
- What happens if provider times out?
- What happens if response is invalid?

Verification:
- Typecheck
- Tests or mocks
- Logs or sample response, if available
```

AI/VLM rules:

* Do not assume provider availability.
* Do not silently skip AI stages without reporting why.
* Do not hard-code provider-specific behavior unless requested.
* Preserve fallback behavior.
* Avoid sending unnecessarily large batches to VLM.
* Keep deterministic local checks when possible.

## 14. Documentation Task Template

Use this when modifying docs only.

```
Documentation task:
- What document should change

Files inspected:
- path/to/file
- path/to/file

Change summary:
- Change 1
- Change 2

Consistency check:
- Requirements:
- Design:
- Tasks:
- Code:
```

Documentation rules:

* Do not describe commands that do not exist.
* Do not claim a feature exists unless code supports it.
* Mark future work clearly as future work.
* Avoid mixing requirements, design, implementation, and progress in the same section.

## 15. Stop Conditions

Agents must stop and report before coding if:

* The task conflicts with current code
* The task requires a database schema change
* The task requires production credential changes
* The task requires deleting user media
* The task requires adding a new dependency
* The task would modify unrelated modules
* The task is ambiguous enough to risk a large wrong change
* The user explicitly asked to inspect or report before coding

## 16. Important Reminder

The agent is not expected to be clever by expanding the task.

The agent is expected to be reliable by:

* Inspecting first
* Changing minimally
* Verifying honestly
* Reporting clearly
