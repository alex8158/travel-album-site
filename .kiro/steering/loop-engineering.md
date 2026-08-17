# Loop Engineering Rules

This file defines how agents should use loops in this project.

A loop is a repeatable workflow where an agent responds to a trigger, pursues a goal, performs actions, verifies results, and stops according to clear rules.

Loops must follow the project harness rules.

Related files:

* AGENTS.md
* docs/agent/verify-commands.md
* docs/agent/task-template.md
* docs/agent/known-issues.md
* .kiro/steering/context-management.md
* .kiro/steering/observability.md
* .kiro/steering/tool-permissions.md
* .kiro/steering/recovery-rollback.md
* .kiro/steering/evaluation.md

## Core Principle

Agents may use loops to reduce manual prompting, but loops must remain bounded, verifiable, and reversible.

Do not create unbounded loops.

Do not keep modifying code indefinitely.

Do not expand task scope during a loop.

## Loop Anatomy

Every loop should define:

1. Trigger
2. Goal
3. Allowed actions
4. Verification method
5. Stop rule
6. Escalation rule
7. Memory update rule, if relevant

## Safe Loop Types

### 1. Post-Task Verification Loop

Trigger:

* A spec task, bugfix, or feature patch is completed.

Goal:

* Verify the change and report actual results.

Allowed actions:

* Run relevant commands from docs/agent/verify-commands.md.
* Inspect test/build/typecheck output.
* Report Verification and Evaluation.

Stop rule:

* Stop when relevant verification passes.
* If verification fails, switch to Recovery and Rollback Rules.

Do not claim lint or smoke passed because this project currently has no lint or smoke script.

### 2. Test Failure Recovery Loop

Trigger:

* TypeScript, test, build, runtime, or health check fails after a change.

Goal:

* Recover safely without expanding scope.

Allowed actions:

* Identify the failed command.
* Determine whether the failure was caused by the latest change.
* Make the smallest safe correction.
* Re-run relevant verification.

Stop rule:

* If one recovery attempt succeeds, stop and report.
* If two consecutive attempts fail, stop and report according to the Two-Failure Stop Rule.
* Do not attempt a third fix without explanation.

### 3. Performance Audit Loop

Trigger:

* The user reports slow upload, slow processing, slow curation, slow video handling, slow page loading, or poor runtime efficiency.

Goal:

* Find bottlenecks with evidence before optimizing.

Allowed actions:

* Inspect call chains.
* Inspect logs and stage durations.
* Identify repeated work, repeated API calls, repeated AI/VLM calls, frontend polling, and blocking media processing.
* Output P0/P1/P2 bottleneck candidates.

Stop rule:

* Stop after producing the audit report.
* Low-risk optimizations may proceed if clearly bounded.
* High-risk optimizations must pause.

### 4. Documentation Consistency Loop

Trigger:

* Code, requirements, design, or tasks appear inconsistent.

Goal:

* Identify mismatch without blindly rewriting code.

Allowed actions:

* Compare current code with relevant docs.
* Report mismatch.
* Recommend whether docs or code should change.

Stop rule:

* Stop after reporting mismatch.
* Do not rewrite implementation to match old docs unless explicitly requested.

### 5. Known-Issue Memory Loop

Trigger:

* A recurring bug pattern or project-specific pitfall is discovered.

Goal:

* Prevent the same issue from recurring.

Allowed actions:

* Update docs/agent/known-issues.md when the issue is likely to recur.
* Keep the update concise.
* Do not add temporary one-off errors.

Stop rule:

* Stop after updating memory and reporting the reason.

## High-Risk Loop Restrictions

Loops must not automatically perform high-risk actions.

High-risk actions include:

* database schema changes
* database deletion
* uploaded media deletion
* upload flow changes
* media cleanup behavior changes
* authentication or authorization changes
* deployment configuration changes
* AI provider configuration changes
* environment variable changes
* adding new dependencies
* broad refactors
* production deployment

If a loop reaches a high-risk action, it must pause and explain.

## Verification Rules

Use real commands from:

```
docs/agent/verify-commands.md
```

Current project facts:

* no lint script
* no smoke script

Report only commands that were actually run.

## Evaluation Rules

For AI, media, performance, curation, deduplication, or user-facing behavior changes, include Evaluation notes.

Verification proves code can run.

Evaluation explains whether the result is better.

## Stop Conditions

A loop must stop when:

* the goal is achieved
* relevant verification passes
* two recovery attempts fail
* a high-risk action is required
* the task scope becomes unclear
* the agent would need to modify unrelated modules
* the agent cannot produce evidence for a performance or quality claim

## Final Loop Report

At the end of a loop, report:

```
Loop type:
- post-task verification / recovery / performance audit / documentation consistency / memory update

Trigger:
- what started the loop

Goal:
- what the loop tried to achieve

Actions taken:
- what was done

Verification:
- command: passed / failed / not run

Evaluation:
- result quality or performance assessment, if relevant

Stop reason:
- why the loop stopped

Risk:
- remaining risk

Next step:
- recommended next action
```
