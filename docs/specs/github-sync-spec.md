# GitHub Sync Plugin Specification

## Status

Draft

## Summary

`todu-github-plugin` is a `syncProvider` plugin for `toduai` that synchronizes one GitHub repository on `github.com` with one todu project.

The plugin provides bidirectional sync for:

- task/issue creation
- title and markdown body updates
- workflow status
- priority
- normal labels
- comments, including create/edit/delete
- GitHub assignees imported into todu

This spec assumes the generic integration architecture described by task #2186 exists in core todu. Under that assumption, the GitHub plugin runs under the daemon as a polling sync provider that consumes shared integration bindings, while keeping provider-specific runtime state in local plugin-owned storage.

## Goals

- Sync a single GitHub repo to a single todu project through a durable binding.
- Keep linked tasks and issues aligned using deterministic mapping rules.
- Support bidirectional bootstrap for existing active/open work.
- Support bidirectional comment sync with strict 1:1 mirrored comments.
- Preserve a clean plugin boundary by storing plugin internals in plugin-owned local storage.
- Design the GitHub plugin to consume a generic shared integration control plane in core todu rather than owning repo/project binding management locally.

## v1 Scope

This version of the plugin covers the following concrete behavior:

- target `github.com` only
- bind exactly one GitHub repository to exactly one todu project
- sync GitHub issues with todu tasks
- exclude pull requests from sync
- sync title, markdown body, status, priority, normal labels, comments, and GitHub assignees into todu
- keep due dates local to todu
- represent workflow state with explicit `status:*` labels plus GitHub open/closed state
- represent priority with explicit `priority:*` labels
- run bootstrap immediately when a binding is created
- bootstrap from GitHub open issues and todu tasks in `active`, `inprogress`, or `waiting`
- run as a daemon-scheduled polling sync provider with per-binding state, cursors, and retry tracking
- read shared GitHub integration bindings from core todu synced state
- store provider-specific mappings, cursors, and runtime sync state in plugin-owned local storage

## Source Constraints and Architecture Alignment

This spec aligns with the existing todu plugin model documented in:

- `~/Private/code/github/evcraddock/todu/docs/plugin-sync-provider-api.md`
- `~/Private/code/github/evcraddock/todu/docs/worker-plugin-api.md`
- `~/Private/code/github/evcraddock/todu/docs/architecture/plugins.md`
- `~/Private/code/github/evcraddock/todu/docs/daemon-service-operations.md`

Key alignment decisions:

- The plugin is a `syncProvider`, not a generic worker plugin.
- This spec assumes core todu provides a generic synced integration binding model as a shared control plane.
- Plugin-owned internal state lives in plugin-managed local storage, not core synced entities.
- The daemon remains the scheduling authority.
- The plugin should be installable/removable without GitHub-specific changes to baseline todu task behavior.

## Terminology

- **Binding**: a shared integration record in core todu that associates one GitHub repo with one todu project.
- **Linked item**: a todu task and GitHub issue that represent the same work item.
- **Reserved labels**: labels with plugin-defined semantics.
- **Normal labels**: all other labels mirrored as plain labels.
- **Bootstrap sync**: the initial sync run that happens immediately after a binding is created.

## Binding Model

### Cardinality

- Exactly one GitHub repo maps to exactly one todu project.
- A todu project may have at most one GitHub binding.
- A GitHub repo may have at most one todu binding.

### Binding creation

This spec assumes binding management is provided by a generic integration surface in core todu, with commands such as:

```bash
toduai integration connect github --project rott --repo evcraddock/rott
toduai integration sync github
toduai integration sync github --project rott
toduai integration disconnect github --project rott
```

Rules:

- The target todu project must already exist.
- `connect` creates a shared integration binding and immediately requests bootstrap sync.
- If a binding already exists, replacement must require an explicit force-style flow.
- `sync` runs across all matching GitHub bindings by default and may be scoped by project or repo.
- Integration bindings are intended to be created and managed from any machine, then consumed by the authority daemon running the GitHub plugin.

## Authentication and Configuration

### Authentication

- The plugin uses one global GitHub token for all bindings.
- The token is supplied through daemon plugin config or environment configuration.

### Per-plugin configuration

Expected high-level config fields:

- `enabled`
- `intervalSeconds` (default `300`)
- `retryInitialSeconds`
- `retryMaxSeconds`
- `settings.token` or equivalent token reference

### Shared binding configuration

GitHub repo/project bindings are stored as shared integration records in synced core todu state rather than in plugin-local storage.

Each shared binding should contain at minimum:

- binding id
- provider type (`github`)
- GitHub owner
- GitHub repo
- todu project id
- enabled flag
- created timestamp
- updated timestamp

### Local runtime state

The GitHub plugin stores provider-specific execution state locally, keyed by shared binding id.

That local runtime state includes at minimum:

- last sync state
- last successful cursor/checkpoint
- retry/backoff state

## Sync Scope

### Included

- GitHub issues only
- Open and closed issues updated since the last sync checkpoint

### Excluded

- Pull requests
- Milestones
- Due dates

The plugin must query all issues updated since the last sync, regardless of open/closed state, so it can observe GitHub-side close/reopen and comment edit/delete activity.

## Durable Identity

### Task to issue identity

The durable task/issue link uses:

```text
external_id = owner/repo#number
```

Example:

```text
evcraddock/rott#42
```

### Internal mapping

In addition to `external_id`, the plugin stores local mapping data in its DB for:

- shared binding id membership
- comment mirroring
- sync checkpoints/cursors
- last-seen external timestamps
- retry and error state
- loop-prevention bookkeeping

### Existing conflicting `external_id`

If a task in a bound project already has a non-empty `external_id` that does not match the bound repo/issue, the plugin overwrites it during linking.

## Bootstrap Behavior

Bootstrap runs immediately after `connect` succeeds.

### GitHub to todu bootstrap

Import all open GitHub issues in the bound repo.

### Todu to GitHub bootstrap

Export all todu tasks in the bound project with status:

- `active`
- `inprogress`
- `waiting`

Ignore existing todu tasks with status:

- `done`
- `canceled`

### Dedupe policy

If equivalent work already exists on both sides but is not already linked, the plugin does not guess. It creates duplicates rather than performing title-based matching.

### Bootstrap comments

For bootstrapped linked items, existing comments are also backfilled bidirectionally.

## Field Mapping

## Title

- todu task title ↔ GitHub issue title
- Conflict resolution: field-group last-write-wins

## Description / Body

- todu task description ↔ GitHub issue body
- Content is markdown on both sides.
- The canonical content is raw user markdown.
- Hidden plugin markers are allowed in the markdown body if needed for bookkeeping or loop prevention.
- Conflict resolution: field-group last-write-wins

## Status Mapping

### Canonical GitHub reserved labels

Every synced GitHub issue must have exactly one status label:

- `status:active`
- `status:inprogress`
- `status:waiting`
- `status:done`
- `status:canceled`

GitHub issue open/closed state must also be kept consistent with the status label.

### Mapping from GitHub to todu

| GitHub issue state | GitHub status label | Todu status  |
| ------------------ | ------------------- | ------------ |
| open               | `status:active`     | `active`     |
| open               | `status:inprogress` | `inprogress` |
| open               | `status:waiting`    | `waiting`    |
| closed             | `status:done`       | `done`       |
| closed             | `status:canceled`   | `canceled`   |

### Mapping from todu to GitHub

| Todu status  | GitHub issue state | GitHub status label |
| ------------ | ------------------ | ------------------- |
| `active`     | open               | `status:active`     |
| `inprogress` | open               | `status:inprogress` |
| `waiting`    | open               | `status:waiting`    |
| `done`       | closed             | `status:done`       |
| `canceled`   | closed             | `status:canceled`   |

### Reopen behavior

Reopening on either side must sync.

Examples:

- reopening a closed `status:done` issue reopens the linked todu task to an open status
- reopening a closed `status:canceled` issue removes canceled semantics and restores an open status

### Normalization rules

If multiple `status:*` labels are present, the plugin auto-normalizes to exactly one using this precedence:

```text
active > inprogress > waiting > done > canceled
```

If GitHub issue open/closed state conflicts with the `status:*` label, the plugin trusts the GitHub issue open/closed state and rewrites the label to match the state.

Examples:

- closed + `status:active` becomes closed + `status:done`
- open + `status:canceled` becomes open + `status:active`

## Priority Mapping

Priority is represented using exactly one reserved label:

- `priority:low`
- `priority:medium`
- `priority:high`

Rules:

- Priority sync is bidirectional.
- If multiple priority labels exist, the plugin auto-normalizes to exactly one.
- Normalization precedence is:

```text
high > medium > low
```

## Normal Label Mapping

All non-reserved labels are mirrored bidirectionally as normal labels.

Reserved labels are:

- `status:*`
- `priority:*`

Examples:

- GitHub label `bug` ↔ todu label `bug`
- todu label `needs-review` ↔ GitHub label `needs-review`

If a label to be pushed to GitHub does not exist in the repo, the plugin automatically creates it.

## Assignee Mapping

Assignee sync is asymmetric.

### GitHub to todu

- GitHub assignees sync into todu.
- If multiple GitHub assignees exist, they are joined into plain text in the todu assignee field.

### Todu to GitHub

- Todu assignees do not sync to GitHub.

## Comments

### Model

Comments use a strict 1:1 mirrored model:

- one GitHub comment ↔ one todu comment
- comment creates sync both ways
- comment edits sync both ways
- comment deletes sync both ways

### Body format

Comment bodies remain markdown.

Mirrored comments include a visible attribution header. Example:

```md
_Synced from GitHub comment by @octocat on 2026-03-08T22:00:00Z_

Original markdown body here.
```

or:

```md
_Synced from todu comment by @alice on 2026-03-08T22:00:00Z_

Original markdown body here.
```

### Author model

- GitHub-created comments imported into todu preserve the original GitHub username in the mirrored markdown attribution.
- Todu-created comments pushed to GitHub are authored by the configured GitHub token owner, with the original todu author preserved in the mirrored markdown attribution.

### Edit conflicts

If the same mirrored comment is edited on both sides before the next sync, resolution is last-write-wins using the mirrored comment updated timestamp.

### Delete behavior

If a mirrored comment is deleted on one side, the plugin hard deletes the mirrored comment on the other side.

### Comment mapping storage

The plugin DB must store comment linkage state sufficient to support:

- comment create mirroring
- in-place edit mirroring
- hard delete mirroring
- loop prevention
- timestamp-based conflict resolution

## Conflict Resolution

Conflict resolution is field-group last-write-wins rather than whole-item last-write-wins.

This avoids a comment edit on one side incorrectly winning for title/status/labels.

### Field groups

The plugin resolves these groups independently:

1. **Title/body**
2. **Status/priority/labels**
3. **Comments**

### Rule

Within each group, the most recently updated source wins according to the best available timestamp for that group.

### Notes

- Issue-level `updated_at` is not sufficient for all groups.
- Comment sync must use comment-level timestamps.
- The plugin DB should track last mirrored timestamps per group where needed.

## Deletion Semantics for Linked Items

Deletion of the linked issue/task itself is not propagated as a true delete.

Instead, deletion is mapped to cancelation:

- GitHub side target becomes: closed + `status:canceled`
- Todu side target becomes: `canceled`

This rule applies regardless of which side initiated the deletion.

## Polling, Scheduling, and Retry

### Scheduling

- Default interval: 5 minutes
- Interval is configurable
- Each binding has independent schedule, cursor, and retry state

### Retry

The plugin follows daemon-host retry semantics with exponential backoff.

Each binding tracks its own:

- retry attempt count
- next retry timestamp
- last error
- last success timestamp

A successful cycle resets retry state for that binding.

## Observability

The plugin records provider runtime sync state in its local DB and logs.

Minimum observable data per binding:

- last successful sync time
- last attempted sync time
- last error
- current retry/backoff state
- last processed issue cursor/checkpoint
- counts for created/updated/deleted items in the last cycle

Logging should clearly identify:

- binding id
- project id
- repo name
- sync direction
- entity type
- item identifier
- failure reason

## Local Storage Model

The plugin-owned DB should contain logical tables or collections for at least:

- `item_links`
- `comment_links`
- `binding_sync_state`
- `binding_errors`

Shared GitHub integration bindings are owned by core todu synced state, not by the plugin DB. The plugin DB stores only runtime and mapping data keyed by binding id.

Suggested contents:

### `item_links`

- binding id
- todu task id
- GitHub issue number
- external id
- last mirrored title/body timestamp
- last mirrored status/priority/labels timestamp

### `comment_links`

- binding id
- todu task id
- todu comment id
- GitHub issue number
- GitHub comment id
- last mirrored comment timestamp
- deleted flag or tombstone bookkeeping as needed internally

### `binding_sync_state`

- binding id
- last attempted at
- last successful at
- last cursor/checkpoint
- retry attempt
- next retry at

## Manual Sync Command

`toduai integration sync github` triggers an immediate sync cycle.

Behavior:

- no args: sync all GitHub bindings
- `--project <project>`: sync one binding scoped by project
- `--repo <owner/repo>`: sync one binding scoped by repo

## Connect and Disconnect Semantics

### Connect

`toduai integration connect github ...` must:

1. validate project exists
2. validate repo format
3. validate binding uniqueness or require explicit replacement flow
4. persist a shared integration binding in core todu state
5. request bootstrap sync immediately

### Disconnect

`toduai integration disconnect github ...` removes the shared binding and stops future sync for it.

Disconnect does not delete already-synced tasks, issues, or comments.

## Implementation Notes

### SyncProvider shape

The plugin should export a `syncProvider` registration compatible with `@todu/core` host expectations.

The provider runtime should:

- initialize GitHub client state from config
- load active GitHub integration bindings from synced core todu state
- maintain local runtime state per binding id
- pull GitHub issues per binding
- push todu changes per binding
- shut down cleanly with the daemon

### Integration control plane assumption

This spec assumes core todu provides the generic `integration` control plane and CLI/app management surface. The GitHub plugin should consume that shared integration model rather than introducing GitHub-specific binding commands or storage as the source of truth.

### Loop prevention

The plugin must maintain sufficient local bookkeeping to avoid infinite mirror loops for:

- issue/task updates
- comment create/edit/delete operations
- label normalization writes

### Rate limiting

GitHub API limits should be handled through:

- per-binding retry and backoff
- checkpoint-based incremental sync
- minimal write amplification

## Initial Implementation Tasks

A practical first implementation pass can be broken into these tasks:

1. Define and implement the core `integration` domain model in todu.
2. Add generic CLI support for creating, listing, syncing, and disconnecting integrations.
3. Expose synced integration bindings to daemon/plugin consumers.
4. Scaffold the GitHub sync provider around the shared integration control plane.
5. Implement GitHub task/issue bootstrap and durable task linking via `external_id`.
6. Implement bidirectional field sync for title, body, status, priority, and labels.
7. Implement local runtime storage for cursors, item links, comment links, retry state, and loop prevention.
8. Implement bidirectional comment sync for create, edit, and delete behavior.
9. Add sync scheduling, retry/backoff behavior, and logging/observability.
10. Add end-to-end tests that cover bootstrap, steady-state sync, reopen/close transitions, label normalization, and comment mirroring.

## Open Implementation Questions

These do not block the spec, but they should be made concrete during implementation planning:

- exact plugin DB technology and schema versioning approach
- exact hidden marker format, if hidden markers are used
- exact GitHub API client abstraction and pagination strategy
- exact todu comment/task APIs used for delete detection and edit timestamps
- whether `disconnect` should optionally preserve or remove plugin-local link metadata for historical audit/debugging
- exact shape of the shared core integration binding record assumed by this spec

## Acceptance Criteria for v1

A v1 implementation satisfies this spec when:

1. a user can create one shared GitHub integration binding from one existing todu project to one GitHub repo
2. bootstrap immediately imports open GitHub issues and exports active/inprogress/waiting todu tasks
3. linked items receive `external_id = owner/repo#number`
4. title/body/status/priority/labels sync bidirectionally according to the mapping rules
5. GitHub assignees sync into todu, but not the reverse
6. comments sync bidirectionally for create/edit/delete with strict 1:1 mirrored behavior
7. status and priority labels normalize deterministically
8. deletion maps to cancelation instead of hard deletion
9. sync runs on a configurable polling interval with per-binding retry state
10. shared binding state lives in core todu synced state, while provider runtime state lives in plugin-local storage and is observable through DB state plus logs
