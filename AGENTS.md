# AGENTS.md

This file defines the working rules for AI coding agents in this repository.

The goal is to make agents work safely, incrementally, and verifiably. Agents must follow this file before making code changes.

## 1. Project Overview

This project is a travel album application.

Main capabilities include:

* Uploading photos and videos
* Processing uploaded media
* Detecting blurry or duplicate photos
* Selecting better photos from similar groups
* Supporting AI-assisted media curation
* Generating slideshow-style outputs from selected media
* Serving a frontend client and backend API

The repository contains a backend server and frontend client:

* `server/` contains the backend API and media-processing logic
* `client/` contains the frontend application
* `docs/` contains project documents
* `.kiro/specs/` contains requirements, design documents, and task plans

Agents must inspect the existing code and documents before implementing changes.

## 2. Core Working Principles

Agents must follow these principles:

1. Work on one clearly defined task at a time.
2. Prefer small, targeted changes over large rewrites.
3. Do not introduce new features unless the task explicitly asks for them.
4. Do not change unrelated modules.
5. Do not rewrite existing architecture without explicit approval.
6. Do not delete existing behavior unless the task explicitly requires it.
7. Do not assume endpoints, services, database fields, or scripts exist.
8. Verify facts by searching the repository before coding.
9. Report uncertainty instead of guessing.
10. Always provide verification results after code changes.

## 3. Before Coding

Before changing code, agents must inspect the existing implementation.

For API-related work, search for:

* Existing routes
* Existing controllers or handlers
* Existing service functions
* Existing repository/database methods
* Existing request and response types
* Existing tests

For media-processing work, search for:

* Existing media pipeline stages
* Existing image or video analysis logic
* Existing deduplication logic
* Existing AI/VLM review logic
* Existing curation or slideshow logic
* Existing configuration values
* Existing fallback behavior

For frontend work, search for:

* Existing pages
* Existing components
* Existing API clients
* Existing hooks
* Existing state management
* Existing error-handling patterns

Agents should use commands such as:

```
grep -R "keyword" -n server client docs .kiro 2>/dev/null
find . -maxdepth 4 -type f | sort
```

If the current implementation conflicts with the task description, agents must report the conflict before changing code.

## 4. Scope Control

Agents must not expand the task scope.

Unless explicitly requested, agents must not:

* Add new product features
* Redesign the UI
* Refactor large modules
* Change database schema
* Change deployment scripts
* Change authentication or authorization behavior
* Change upload behavior
* Change video-processing behavior
* Change AI provider behavior
* Add new dependencies
* Rename public APIs
* Rewrite existing documents unrelated to the task

If a broader change seems necessary, agents must explain why and wait for approval.

## 5. Existing Documentation

Agents should consult relevant documents before coding.

### 5.0 Read Before Any Change

**Before modifying anything, read `docs/agent/change-boundaries.md`.**

It defines the change boundaries (what may be changed directly, what requires approval), the recording obligations (which documents must be updated after each type of change), and a list of mistakes this project has actually made. Reading it first is the cheapest way to avoid repeating them.

### 5.1 Document Authority Order

This repository contains three generations of requirement documents. They are **not** equally authoritative. Use this order when they disagree:

| Rank | Source | Role | Trust for |
| --- | --- | --- | --- |
| 1 | Current source code | Implementation truth | What the system actually does |
| 2 | `.kiro/specs/<feature>/` | **Authoritative requirement contract** | What a feature is supposed to do; acceptance criteria |
| 3 | `docs/agent/*.md` | Working rules for agents | Verify commands, known issues, task format |
| 4 | `requirements.md` (root, Part 2) | Index of iteration specs | Locating the right spec |
| 5 | `requirements.md` / `design.md` / `tasks.md` (root, v1) | **Historical baseline, archived** | Original MVP intent only |
| 6 | `docs/requirements-v2.md` / `docs/design-v2.md` | **Product vision, not a contract** | Direction and rationale only |

### 5.2 Timeline Behind the Order

* **2026-03-31** — root `requirements.md` / `design.md` / `tasks.md` were written and completed as the v1 MVP. All tasks in root `tasks.md` are done. These are archived history.
* **2026-04-09 onward** — real development moved to `.kiro/specs/<feature>/`, one spec per iteration. This is where current requirements live.
* **2026-05-06** — `docs/requirements-v2.md` and `docs/design-v2.md` were added mid-stream as a forward-looking vision for a layered image/video processing system. Iterations both predate and postdate them, and were never re-derived from them. They describe intent, not delivered behavior.

### 5.3 Rules

1. For any implementation task, agents SHALL locate the relevant `.kiro/specs/<feature>/` spec first, and treat its requirements as the contract.
2. Agents SHALL NOT implement requirements taken from `docs/requirements-v2.md`, `docs/design-v2.md`, or the root v1 documents unless the user explicitly asks for that specific item.
3. When a `.kiro/specs` requirement disagrees with current code, agents SHALL treat the code as implementation truth, report the mismatch, and ask before changing behavior to match the document.
4. When the root v1 documents or the v2 vision documents disagree with a `.kiro/specs` requirement, the `.kiro/specs` requirement wins and no report is needed — the older documents are expected to be stale.
5. When a feature exists in code but has no spec, agents SHALL say so rather than inferring requirements from the v2 vision documents. An as-built spec may be written on request (see `.kiro/specs/multi-user-system/` for the pattern).
6. Agents SHALL NOT rewrite the root v1 documents or the v2 vision documents to match current code. They are kept as-is on purpose.

Agents must not silently implement outdated requirements from old documents.

## 6. Verification Rules

Agents must verify code changes using the commands defined in:

```
docs/agent/verify-commands.md
```

The current known verification commands are:

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

Backend health check when running directly on port 3001:

```
curl -s http://127.0.0.1:3001/api/health
```

Backend health check when behind nginx:

```
curl -s http://127.0.0.1/api/health | jq
```

Agents must not claim that lint passed because this project currently has no lint script.

Agents must not claim that smoke tests passed because this project currently has no smoke script.

If a verification command fails, agents must report:

* The failed command
* The relevant error message
* The likely cause
* The proposed fix

Agents must not hide failed verification results.

## 7. Security Rules

Agents must treat secrets carefully.

Agents must not print, copy, summarize, or expose secret values from files such as:

* `.env`
* `.env.local`
* `.env.production`
* `.pem`
* private keys
* deployment credentials
* API keys
* database passwords
* cloud credentials

If secret files are found in the repository, agents may report that secret files exist, but must not reveal their contents.

Agents must not modify production credentials unless explicitly instructed.

Agents must not commit secret files.

## 8. Dependency Rules

Agents must not add new dependencies unless necessary and explicitly justified.

Before adding a dependency, agents must check whether the project already has an equivalent library or helper.

If a dependency is required, agents must report:

* Package name
* Why it is needed
* Which existing alternatives were considered
* Whether it affects server, client, or both

## 9. Database and Migration Rules

Agents must not change database schema casually.

Before making database-related changes, agents must inspect:

* Existing schema definitions
* Migration files
* Repository methods
* Existing query patterns
* Existing tests or seed data

Any schema change must include:

* Reason for the change
* Migration plan
* Backward compatibility consideration
* Verification steps

## 10. Media Pipeline Rules

Media-processing behavior is sensitive.

Agents must be careful when modifying:

* Upload handling
* Image analysis
* Blur detection
* Duplicate detection
* Similarity grouping
* AI/VLM review
* Curation pipeline
* Video processing
* Slideshow generation
* Cleanup or deletion behavior

For media-related changes, agents must preserve existing fallback behavior unless explicitly asked to change it.

Agents must avoid deleting media records or files unless the task explicitly requires deletion.

Agents must clearly distinguish between:

* Marking media as rejected
* Moving media to trash
* Permanently deleting media
* Excluding media from curated output

Agents must not mix these behaviors without explicit approval.

## 11. AI and VLM Rules

Agents must not assume an AI provider is available.

Before changing AI or VLM behavior, agents must inspect:

* Provider configuration
* Environment variable names
* Availability checks
* Fallback behavior
* Error handling
* Logging
* Tests or mock clients

Agents must not silently skip AI-related stages without reporting why.

Agents must not hard-code provider-specific behavior unless the task explicitly requires it.

When modifying AI curation or similarity review, agents must report:

* Which stage is affected
* Whether the change is before or after reducer logic
* Whether it affects global similarity
* Whether it affects scene deduplication
* Whether it affects final curated selection
* How false positives and false negatives are handled

## 12. Frontend Rules

For frontend changes, agents must preserve existing user flows unless explicitly requested.

Agents must inspect existing components and API clients before adding new ones.

Agents must avoid duplicating API calls or creating parallel state that conflicts with existing state.

For UI changes, agents must report:

* Which page or component changed
* What user-visible behavior changed
* Whether API contracts changed
* Whether loading and error states are handled

## 13. Backend Rules

For backend changes, agents must inspect existing routes and services before adding new endpoints.

Agents must not create duplicate endpoints.

Agents must preserve existing response shapes unless the task explicitly requires a change.

For API changes, agents must report:

* Route path
* HTTP method
* Request body
* Response shape
* Error behavior
* Verification command or manual curl test

## 14. Task Execution Flow

Agents should follow this flow:

1. Restate the task briefly.
2. Inspect relevant files.
3. Report existing facts.
4. Identify the minimal change plan.
5. Make the change.
6. Run relevant verification commands.
7. Report results and remaining risks.

For tasks where the user explicitly says "先看", "先分析", "不要改代码", or "先汇报", agents must not modify files.

## 15. Final Report Format

After completing a task, agents must report in this format:

```
Summary:
- What changed

Files changed:
- path/to/file

Verification:
- command: passed / failed / not run
- command: passed / failed / not run

Notes:
- Important implementation details
- Known limitations
- Risks

Next step:
- Recommended next action, if any
```

Agents must distinguish between commands that were actually run and commands that were only recommended.

## 16. Current Known Gaps

The project currently lacks:

* A unified verify script
* A lint script
* A smoke test script
* A dedicated debugging playbook

Agents should not pretend these files or commands exist.

Two former gaps are now closed and must not be described as missing: change
boundaries live in `docs/agent/change-boundaries.md` (see section 5.0) and the
agent task format in `docs/agent/task-template.md`.

## 17. Important Reminder

The agent's job is not to be creative by default.

The agent's job is to make the smallest safe change that satisfies the task, prove it with verification, and clearly report what happened.
