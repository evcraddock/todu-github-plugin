# AI Agent Guidelines for todu-github-plugin

## Before Starting ANY Task

**ALWAYS use the `task-start-preflight` skill** when you hear:

- "start task", "work on task", "get started", "pick up task"
- "let's do task", "begin task", "tackle task"
- Or any variation of starting work

The preflight ensures you understand the task, check dependencies, and follow project guidelines.

## Required Reading

Before working, read and follow:

- [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md) - workflow and PR process
- [docs/CODE_STANDARDS.md](docs/CODE_STANDARDS.md) - code style and patterns

You MUST follow these guidelines throughout your work.

## Project Overview

A todu plugin that syncs GitHub issues to the todu system.

## Tech Stack

- Language: TypeScript
- Framework: None

## Development

**ALWAYS start the dev environment using `make dev`** when the task needs background services.

Key commands:

- `make dev` - Start the local dev environment scaffold
- `npm test` - Run tests
- `npm run lint` - Run the linter
- `npm run format` - Format code
- `npm run typecheck` - Run the TypeScript compiler in check mode

Read the Makefile before starting work.

## Dependencies

When installing packages:

- Use latest **STABLE** versions only
- Reject canary/beta/alpha/rc versions unless user explicitly approves
- Verify stable version: `npm view <package> versions | grep -v '-'`

Non-stable versions can have bugs or incomplete features. Ask before using them.

## Task Lifecycle

- **Starting**: ALWAYS run `task-start-preflight` skill first
- **Closing**: Run `task-close-gate` skill

## PR Workflow (Mandatory Sequence)

After implementation is complete, execute this exact order:

1. Run `./scripts/pre-pr.sh`
2. Push branch and open/update PR
3. Resolve CI gate:
   - If checks exist: wait for green
   - If checks fail: fetch failures, fix, rerun `./scripts/pre-pr.sh`, push, re-check
   - If checks cannot be verified automatically: stop and ask the human whether to continue without a CI signal
4. Run the `pr-review` skill for independent review
5. Report review result with explicit pipeline state
6. Stop and wait for explicit human merge approval

Do not ask "want me to...?" for required next steps.

## Conventions

- Use TypeScript strict mode
- Prefer named exports over default exports
- Use path aliases for imports (`@/...`) when they improve readability
- Handle null explicitly with `??` and `?.`
- Write tests with Vitest
