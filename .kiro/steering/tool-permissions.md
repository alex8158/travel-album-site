# Tool and Permission Rules

This file defines what agents may read, modify, execute, or must avoid in this project.

The goal is to let agents work efficiently while preventing unsafe changes to secrets, user data, media files, database schema, deployment configuration, and high-risk project behavior.

## Core Principle

Agents may proceed with low-risk investigation and maintenance work.

Agents must pause and explain before high-risk actions.

The user may not be a professional developer, so agents should explain risks in plain language.

## Allowed Read Operations

Agents may read and search:

* source code
* tests
* documentation
* Kiro specs
* package.json files
* configuration examples
* non-secret project files
* logs provided by the user
* local error messages
* verification command output

Useful read commands include:

```
grep -R "keyword" -n server client docs .kiro 2>/dev/null
find . -maxdepth 4 -type f | sort
cat package.json
cat server/package.json
cat client/package.json
```

Agents must not print secret values when reading files.

## Allowed Low-Risk Modifications

Agents may modify low-risk files when directly related to the task:

* ordinary frontend components
* ordinary backend service logic
* API handlers for the current issue
* tests related to the current issue
* documentation
* agent harness documents
* small configuration references that do not contain secrets

Rules:

* Make the smallest safe change.
* Do not expand task scope.
* Preserve existing behavior unless the task requires a change.
* Run relevant verification commands.
* Report what changed and what was verified.

## Medium-Risk Modifications

Agents may modify these areas only with a short explanation of impact and verification plan:

* API request or response shape
* shared types used by both server and client
* media analysis pipeline
* deduplication or similarity logic
* AI curation logic
* job orchestration
* frontend polling behavior
* performance behavior across multiple files
* fallback behavior

Before modifying medium-risk areas, agents should explain:

* what area is affected
* why the change is needed
* what behavior should remain unchanged
* how the change will be verified

## High-Risk Actions Requiring Pause

Agents must pause and explain before doing any of the following:

* changing database schema
* changing migration files
* deleting database data
* deleting uploaded media files
* changing upload flow
* changing media deletion or cleanup behavior
* changing authentication or authorization behavior
* changing production deployment configuration
* changing environment variable names
* changing AI provider configuration
* adding new dependencies
* running production deployment commands
* running destructive shell commands
* broad refactors
* changes that may affect existing user data

Agents must not perform high-risk actions until the user approves.

## Files Agents Must Not Expose

Agents must not print, summarize, copy, or expose secret values from:

* `.env`
* `.env.local`
* `.env.production`
* `.pem`
* private keys
* API key files
* cloud credentials
* database passwords
* deployment credentials

Agents may say that such files exist, but must not reveal their contents.

## Files Agents Should Not Modify Without Approval

Agents must not modify these files or file types without explicit approval:

* `.env`
* `.env.*`
* `*.pem`
* private key files
* production deployment files
* nginx production configuration
* database migration files
* files containing real user uploads
* files containing production credentials

## Dangerous Commands

Agents must not run destructive commands unless explicitly requested and clearly justified.

Examples of dangerous commands:

```
rm -rf
DROP DATABASE
DELETE FROM
TRUNCATE
git reset --hard
git clean -fd
npm install <new-package>
pnpm add <new-package>
yarn add <new-package>
deploy scripts targeting production
```

If a command may delete files, modify data, change dependencies, or affect production, pause first.

## Dependency Rules

Agents must not add dependencies casually.

Before adding a dependency, agents must report:

* package name
* why it is needed
* what existing alternatives were checked
* whether it affects server, client, or both
* what risk it introduces

Prefer using existing dependencies and built-in APIs.

## Database Rules

Database changes are high risk.

Before database changes, agents must inspect:

* current schema
* migration files
* repository methods
* existing query patterns
* tests or seed data

Agents must pause before:

* changing schema
* adding migrations
* deleting records
* changing primary data relationships
* changing behavior that may affect existing user data

## Media File Rules

Uploaded media and generated media are user data.

Agents must not delete or permanently alter media files unless explicitly requested.

Agents must clearly distinguish:

* rejected
* trashed
* permanently deleted
* excluded from curated output

Agents must not use deletion as a shortcut for fixing curation or display bugs.

## AI Provider Rules

AI provider configuration is high risk.

Agents must not change provider names, environment variable names, API keys, or model configuration without approval.

Before changing AI/VLM behavior, agents must inspect:

* provider availability checks
* env variable names
* fallback behavior
* logs
* tests or mocks

Agents must not expose secret keys.

## Verification Commands

Use real verification commands from:

```
docs/agent/verify-commands.md
```

Current project facts:

* no lint script
* no smoke script

Do not claim lint or smoke passed unless those commands are added later.

## Reporting Requirement

After changes, agents must report:

```
Files changed:
- path/to/file

Risk level:
- low / medium / high

What changed:
- plain-language explanation

What was not changed:
- important boundaries preserved

Verification:
- command: passed / failed / not run

Remaining risk:
- any unresolved risk
```

## Plain-Language Requirement

Because the user may not be a professional developer, agents should explain high-risk items in plain language.

Example:

```
This change would alter the database structure. That means existing uploaded trips or media records could be affected. I should pause before doing this.
```

Example:

```
This fix only changes how the page reads an existing API response. It does not change upload, deletion, database schema, or AI provider configuration.
```
