# Contributing

This document defines how to work in this project.

## Required workflow

1. Work only within task scope.
2. Read relevant files before editing.
3. Make the smallest change that satisfies the task.
4. Follow [CODE_STANDARDS.md](CODE_STANDARDS.md).
5. Do not add manual line breaks in markdown paragraphs.
6. If blocked or requirements are ambiguous, stop and report `BLOCKED` with reason.
7. Summarize changed files and verification results.

## Plan disclosure and approval

Before implementation begins on a task, disclose the plan and get approval.

Do not ask for approval on an undisclosed plan.

Use this format:

### Plan for task #<id>

#### Goal

- <one sentence summary>

#### Files to read

- `<path>`
- `<path>`

#### Files likely to change

- `<path>`
- `<path>`

If the exact file list is not known yet, say so explicitly and keep the eventual changes scoped.

#### Implementation steps

1. <step>
2. <step>
3. <step>

#### Verification

- `<command>`
- `<command>`

#### Open questions / risks

- <item>
- or `None`

#### Approval

Reply with `approve` to proceed with this plan.

## Branch and commits

Start from the latest main branch and create a task branch:

```bash
git checkout main && git pull
git checkout -b feat/{task-id}-short-description
```

Branch prefixes:

- `feat/` - new features
- `fix/` - bug fixes
- `docs/` - documentation only
- `chore/` - maintenance

Commit format:

```text
<type>: <short description>

Task: #<task-id>
```

## Verification setup (required)

This project should define local verification before regular contribution work begins.

Set up and document at minimum:

- formatting
- linting
- testing

Add clear commands for these checks in this document or the README once they exist.

## Review and integration

- Push your branch to github.
- Use pull requests for review and integration whenever possible.
- Run the `pr-review` skill in a visible tmux sub-agent pane as part of the review process.
- Treat the `pr-review` result as part of the review gate and stop for explicit human merge approval after review is complete.
- Never auto-merge.

## When stuck

After 3 failed attempts at the same problem:

1. Stop.
2. Document what was tried and why it failed.
3. Ask for guidance or propose alternatives.
