# Test Failure Mode

When the user reports a test failure, runtime error, build error, TypeScript error, API error, or UI bug, treat it as maintenance debugging work.

A user-provided error message is not permission to rewrite large parts of the project.

## Required Behavior

When fixing a reported error, follow this workflow:

1. Identify the failing area from the error message.
2. Search the relevant existing code before editing.
3. Locate the smallest likely root cause.
4. Make the smallest safe fix.
5. Do not add unrelated features.
6. Do not refactor unrelated modules.
7. Do not change database schema unless the error proves it is necessary.
8. Do not change upload, deletion, deployment, or AI provider behavior unless directly related to the error.
9. Run relevant verification commands from docs/agent/verify-commands.md.
10. Report the exact commands run and their results.

## Do Not

- Do not fix a test failure by deleting or weakening the test unless the test is clearly outdated and the reason is explained.
- Do not hide errors.
- Do not claim lint passed because this project currently has no lint script.
- Do not claim smoke passed because this project currently has no smoke script.
- Do not make broad architecture changes for a narrow bug.
- Do not introduce new dependencies unless absolutely necessary and justified.

## Required Final Report

After fixing the issue, report:

    Root cause:
    - What caused the error

    Fix:
    - What was changed

    Files changed:
    - path/to/file

    Verification:
    - command: passed / failed / not run

    Risk:
    - Any remaining risk

    Next step:
    - Recommended follow-up, if any