# Verify Commands

This document defines the verification commands that coding agents must use for this project.

Agents must not claim that lint, smoke, or any other verification passed unless the corresponding command actually exists and was executed.

## Server

### Typecheck

Use this command to check TypeScript types without emitting files:

    cd server && npx tsc --noEmit

### Build

Use this command to build the server:

    cd server && npm run build

### Test

Use this command to run server tests:

    cd server && npm test

## Client

### Typecheck

Use this command to check client TypeScript types:

    cd client && npx tsc -b

### Build

Use this command to build the client:

    cd client && npm run build

### Test

Use this command to run client tests:

    cd client && npm test

## Health Check

If the backend is running directly on port 3001, use:

    curl -s http://127.0.0.1:3001/api/health

If the backend is behind nginx, use:

    curl -s http://127.0.0.1/api/health | jq

## Current Missing Commands

The project currently does not have these commands:

- lint
- smoke
- unified verify script

Agents must not claim that lint or smoke passed unless those commands are added later.

## Recommended Minimum Verification

For backend changes, run at least:

    cd server && npx tsc --noEmit
    cd server && npm test

For frontend changes, run at least:

    cd client && npx tsc -b
    cd client && npm test

For changes that affect build, deployment, or shared behavior, run:

    cd server && npm run build
    cd client && npm run build

For API/runtime changes, also run the health check after the server starts:

    curl -s http://127.0.0.1:3001/api/health

## Reporting Requirement

After making code changes, agents must report:

1. Which verification commands were run
2. Which commands passed
3. Which commands failed
4. Any commands that were skipped and why