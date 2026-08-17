# Agent Harness Rules

This project uses an agent harness to keep AI coding work safe, scoped, and verifiable.

Before doing coding work, follow these project instruction files:

- AGENTS.md
- docs/agent/verify-commands.md
- docs/agent/task-template.md

## Core Rules

- Inspect existing code before modifying files.
- Work on one clearly defined task at a time.
- Do not expand task scope.
- Do not add unrelated features.
- Do not refactor large modules unless explicitly requested.
- Do not change database schema unless explicitly requested.
- Do not change upload, media deletion, or production deployment behavior unless explicitly requested.
- Do not add new dependencies unless necessary and justified.
- Do not assume endpoints, scripts, provider configs, or database fields exist.
- Search the repository first, then report current facts before implementation.

## Verification Rules

Use the commands in:

- docs/agent/verify-commands.md

Important current project facts:

- There is no lint script.
- There is no smoke script.
- Do not claim lint passed.
- Do not claim smoke passed.
- Only report verification commands that were actually run.

## Required Workflow

For implementation tasks:

1. Restate the task.
2. Search relevant files.
3. Report current facts.
4. Propose the minimal change plan.
5. Implement only after the plan is clear.
6. Run relevant verification commands.
7. Report files changed, verification results, risks, and next step.

For review-only tasks:

- Do not modify files.
- Inspect relevant files.
- Report findings by severity.
- Recommend the next action.

## Media Pipeline Safety

Be extra careful with:

- Upload handling
- Image analysis
- Blur detection
- Duplicate detection
- Global similarity
- AI/VLM review
- Curation pipeline
- Slideshow generation
- Media deletion or trash behavior

Clearly distinguish between:

- rejected
- trashed
- permanently deleted
- excluded from curated output

Do not permanently delete user media unless explicitly requested.

## AI/VLM Safety

Before changing AI or VLM behavior, inspect:

- Provider configuration
- Environment variables
- Availability checks
- Fallback behavior
- Error handling
- Logs
- Tests or mocks

Do not silently skip AI stages. Report why a stage is unavailable or skipped.