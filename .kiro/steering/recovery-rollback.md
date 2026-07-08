# Recovery and Rollback Rules

This file defines how agents should behave when a change fails, verification fails, a bug fix causes regressions, or an attempted optimization makes the project worse.

The goal is to prevent agents from expanding a failed fix into a large, unsafe rewrite.

## Core Principle

When a change fails verification, agents must stop expanding scope.

Agents should first determine whether the failure was caused by the latest change.

Prefer the smallest safe correction or rollback over broad refactoring.

## When These Rules Apply

Use these rules when:

* TypeScript fails after a change
* tests fail after a change
* build fails after a change
* runtime behavior gets worse after a change
* a bug fix causes a new bug
* a performance optimization makes behavior unstable
* the same issue persists after an attempted fix
* verification fails more than once
* the agent is tempted to modify unrelated modules

## Required Failure Response

When verification fails, agents must report:

```
Failed command:
- command

Error summary:
- short plain-language explanation

Likely cause:
- whether it appears caused by the latest change

Changed files involved:
- path/to/file

Recovery plan:
- minimal fix or rollback

Risk:
- low / medium / high
```

Agents must not hide failed verification results.

## Do Not Expand Scope

After a failed change, agents must not immediately:

* refactor large modules
* change database schema
* add new dependencies
* change upload flow
* change media deletion behavior
* change AI provider configuration
* change deployment configuration
* rewrite unrelated frontend or backend code
* delete or weaken tests just to pass verification

If any of these seem necessary, pause and explain first.

## Prefer Minimal Recovery

When a change causes failure, prefer this order:

1. Fix the smallest obvious mistake in the latest change.
2. If that fails, revert the latest change.
3. Re-check the original issue.
4. Re-investigate root cause with more evidence.
5. Propose a smaller alternative fix.

Do not continue piling fixes on top of a broken change.

## Two-Failure Stop Rule

If two consecutive attempted fixes fail, agents must stop and report before making further changes.

The report must include:

```
Attempts made:
- Attempt 1:
- Attempt 2:

Current failure:
- failed command or observed bug

What changed:
- files changed

Suspected reason:
- why the issue is still unresolved

Recommended next step:
- rollback / narrower fix / more logs / user decision
```

Agents must not continue with a third fix without explaining the situation.

## Rollback Rules

Rollback is appropriate when:

* the latest change clearly caused new failures
* the fix changed too many unrelated files
* the original issue is not solved
* behavior became worse
* verification failure is hard to diagnose
* the change introduced high-risk behavior

When rolling back, agents should preserve useful analysis but remove unsafe code changes.

Agents must report:

```
Rolled back:
- what was reverted

Preserved:
- useful notes, tests, or docs if any

Current status:
- whether project returns to previous working state
```

## Test Rules

Agents must not fix failures by deleting, skipping, or weakening tests unless the test is clearly outdated.

If a test is believed to be outdated, agents must explain:

* why the test no longer matches intended behavior
* what current behavior should be
* whether requirements or design documents support the change
* whether user approval is needed

## Verification Rules

Use real verification commands from:

```
docs/agent/verify-commands.md
```

Current project facts:

* no lint script
* no smoke script

Agents must not claim lint or smoke passed unless those commands are added later.

After recovery or rollback, agents must report actual commands run and results.

## High-Risk Recovery Requires Pause

Agents must pause before recovery actions that involve:

* database schema changes
* deleting data
* deleting uploaded media
* changing upload flow
* changing media cleanup behavior
* changing authentication or authorization
* changing deployment configuration
* changing AI provider configuration
* adding dependencies
* broad refactoring

Explain the risk in plain language before proceeding.

## Plain-Language Reporting

Because the user may not be a professional developer, agents should explain recovery decisions simply.

Example:

```
The last fix caused the server typecheck to fail. This appears to be caused by a field name mismatch introduced in the latest change. I will make a small correction in the same file instead of changing other modules.
```

Example:

```
Two fixes have failed. Continuing to patch may make the code worse. I recommend reverting the last change and re-checking the original error with more logs.
```

## Final Recovery Report

After recovery, agents must report:

```
Summary:
- what failed and what was recovered

Root cause:
- likely cause of the failed fix

Files changed:
- path/to/file

Rolled back:
- yes / no
- what was reverted

Verification:
- command: passed / failed / not run

Current status:
- original issue fixed / not fixed
- new failures introduced / not introduced

Next step:
- recommended next action
```
