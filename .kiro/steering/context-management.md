# Context Management Rules

This file defines how agents should choose and trust context in this project.

The goal is to prevent agents from using the wrong document, outdated specs, or incomplete code context when fixing bugs, adding features, or optimizing performance.

## Core Principle

Current code is the source of implementation truth.

Documents describe requirements, design intent, historical decisions, and planned work, but documents may be outdated.

When code and documentation disagree, agents must:

1. Report the mismatch.
2. Treat current code as the implementation truth.
3. Avoid silently implementing outdated documentation.
4. Ask for clarification only when the mismatch affects a high-risk change.

## Context Priority

Use this priority order when investigating implementation behavior:

1. Current source code
2. Runtime logs and error messages
3. Tests and verification commands
4. Current Kiro spec for the active feature or bugfix
5. Project documentation
6. Historical specs or old task files

Do not trust old specs blindly.

## Required Context by Task Type

### Test Failure or Runtime Error

For test failures, build errors, runtime errors, API errors, or UI bugs, inspect:

* Error message or stack trace
* Files mentioned in the error
* Related call chain
* Existing tests
* `AGENTS.md`
* `docs/agent/verify-commands.md`

Do not start from old requirements unless the error clearly relates to a spec feature.

### Bugfix

For bug fixes, inspect:

* Current implementation
* Related service, route, component, or pipeline stage
* Existing tests
* Recent related specs only when needed
* Known project rules in `AGENTS.md`

Prefer the smallest fix that matches current architecture.

### Feature Patch

For small feature additions, inspect:

* Existing similar features
* Existing API clients or service methods
* Current UI/component patterns
* Related specs or docs
* Verification commands

Reuse existing patterns before adding new ones.

### New Feature

For larger new features, use the Kiro spec workflow.

Inspect or create:

* requirements.md
* design.md
* tasks.md

Do not implement before the spec/design/task plan is clear.

### Performance Optimization

For performance work, inspect:

* Actual call chain
* Logs
* Repeated API requests
* Repeated media processing
* Database or file access patterns
* AI/VLM call frequency
* Frontend polling or refresh logic

Do not optimize based only on guesses or old documentation.

### Media Pipeline Changes

For upload, analysis, deduplication, AI review, curation, slideshow, or deletion behavior, inspect:

* Current media pipeline code
* Related specs
* Fallback behavior
* Database records and state transitions
* User-pinned or user-selected media behavior

Clearly distinguish:

* rejected
* trashed
* permanently deleted
* excluded from curated output

Do not modify deletion or cleanup behavior unless explicitly required.

### AI/VLM Changes

For AI provider, VLM review, prompt, scoring, or curation behavior, inspect:

* Provider configuration
* Environment variable names
* Availability checks
* Fallback behavior
* Error handling
* Logs
* Tests or mocks

Do not assume AI/VLM is available.

Do not silently skip AI stages without reporting why.

## Documentation Conflict Rules

When requirements, design, tasks, and code disagree:

* Report the conflict.
* Do not silently choose the older document.
* Do not rewrite the implementation to match old docs unless requested.
* For low-risk bugs, fix according to current implementation.
* For high-risk behavior changes, pause and explain the mismatch.

## Avoid Context Overload

Agents should not read every document for every small bug.

Use only the context needed for the task.

Examples:

* A TypeScript error usually does not require reading all specs.
* A new feature should use the relevant spec workflow.
* A media pipeline change requires both code and relevant design documents.
* A performance issue requires runtime flow and evidence, not only documentation.

## Final Reporting

When reporting findings or changes, agents should mention which context was used:

```
Context used:
- Current code:
- Error/logs:
- Specs/docs:
- Verification commands:
```

Agents should also report any context mismatch:

```
Context mismatch:
- Document says:
- Current code does:
- Decision:
```
