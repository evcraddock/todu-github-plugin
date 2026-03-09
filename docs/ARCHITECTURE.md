# Architecture

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

### Binding creation and management

This spec assumes binding management is provided by the generic integration surface in core todu, with commands such as:

```bash
toduai integration list --provider github
toduai integration add --provider github --project rott --target-kind repository --target evcraddock/rott --strategy bidirectional
toduai integration update <binding-id> --target-kind repository --target evcraddock/rott
toduai integration set-strategy <binding-id> --strategy pull
toduai integration enable <binding-id>
toduai integration disable <binding-id>
toduai integration remove <binding-id>
toduai integration status
toduai integration status <binding-id>
```

Rules:

- The target todu project must already exist.
- GitHub bindings use `provider = github`, `targetKind = repository`, and `targetRef = owner/repo`.
- `integration add` creates a shared integration binding and the authority daemon should pick it up for bootstrap and steady-state sync.
- If a binding already exists, replacement must require an explicit update or replacement flow.
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
- provider (`github`)
- project id
- target kind (`repository`)
- target ref (`owner/repo`)
- strategy (`bidirectional`, `pull`, `push`, or `none`)
- enabled flag
- created timestamp
- updated timestamp

The GitHub provider should interpret `targetRef` to derive the GitHub owner and repo.

### Binding strategy

This spec describes the full bidirectional GitHub behavior.

When a binding uses another core-defined strategy:

- `bidirectional`: apply the full behavior in this spec
- `pull`: only GitHub-to-todu import behavior runs
- `push`: only todu-to-GitHub export behavior runs
- `none`: the binding remains visible but no sync work runs

### Local runtime state

The GitHub plugin stores provider-specific execution state locally, keyed by the host-supplied binding identity, typically `catalogId + bindingId`.

That local runtime state includes at minimum:

- last local retry/backoff state
- last successful cursor/checkpoint
- local mapping/link state

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

- binding identity membership
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

Observability is split between shared integration binding status and local provider runtime details.

### Shared binding status

The authority daemon should publish the high-level runtime status for each binding through the core integration status model surfaced by `toduai integration status`.

Minimum shared observable data per binding:

- binding id
- state (`running`, `idle`, `blocked`, or `error`)
- authority id
- last successful sync time
- last attempted sync time
- last error summary
- updated time

### Local runtime details

The plugin may additionally keep detailed provider runtime data in local DB state and logs, such as:

- current retry/backoff state
- last processed issue cursor/checkpoint
- counts for created/updated/deleted items in the last cycle
- provider-local diagnostics needed for debugging

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
- `binding_runtime_state`
- `binding_errors`

Shared GitHub integration bindings and shared integration binding status are owned by core todu synced state, not by the plugin DB. The plugin DB stores only provider-local runtime and mapping data keyed by binding identity.

Suggested contents:

### `item_links`

- binding identity
- todu task id
- GitHub issue number
- external id
- last mirrored title/body timestamp
- last mirrored status/priority/labels timestamp

### `comment_links`

- binding identity
- todu task id
- todu comment id
- GitHub issue number
- GitHub comment id
- last mirrored comment timestamp
- deleted flag or tombstone bookkeeping as needed internally

### `binding_runtime_state`

- binding identity
- last local cursor/checkpoint
- retry attempt
- next retry at
- local runtime cleanup markers as needed

## Integration Lifecycle Semantics

### Add

`toduai integration add --provider github ...` must:

1. validate project exists
2. validate `target-kind repository`
3. validate `target owner/repo` format
4. validate binding uniqueness or require an explicit update/replacement flow
5. persist a shared integration binding in core todu state
6. allow the authority daemon to pick it up for bootstrap and steady-state sync

### Update

`toduai integration update <binding-id> ...` updates the shared binding target metadata.

### Strategy and enablement

- `toduai integration set-strategy <binding-id> --strategy ...` changes the desired binding strategy.
- `toduai integration enable <binding-id>` re-enables execution for a binding.
- `toduai integration disable <binding-id>` disables execution while keeping the binding visible.

### Remove

`toduai integration remove <binding-id>` removes the shared binding and stops future sync for it.

Removing a binding does not delete already-synced tasks, issues, or comments.

## Implementation Notes

### SyncProvider shape

The plugin should export a `syncProvider` registration compatible with `@todu/core` host expectations.

The provider runtime should:

- initialize GitHub client state from config
- load active GitHub integration bindings from synced core todu state
- maintain local runtime state per binding identity
- pull GitHub issues per binding
- push todu changes per binding
- honor the binding strategy supplied by the host
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

## Implementation Plan Documents

Implementation sequencing lives in `docs/plans/` so the architecture document can stay focused on stable design.

Current phase documents:

1. `docs/plans/phase-1-provider-foundation.md`
2. `docs/plans/phase-2-bootstrap-and-linking.md`
3. `docs/plans/phase-3-field-sync.md`
4. `docs/plans/phase-4-comment-sync.md`
5. `docs/plans/phase-5-runtime-and-observability.md`
6. `docs/plans/phase-6-test-coverage-and-hardening.md`

## Open Implementation Questions

These do not block the spec, but they should be made concrete during implementation planning:

- exact plugin DB technology and schema versioning approach
- exact hidden marker format, if hidden markers are used
- exact GitHub API client abstraction and pagination strategy
- exact todu comment/task APIs used for delete detection and edit timestamps
- whether `toduai integration remove` should preserve or remove plugin-local link metadata for historical audit/debugging
- whether provider-local runtime state should key by `bindingId` alone or by `catalogId + bindingId` in the final implementation

## Acceptance Criteria for v1

A v1 implementation satisfies this spec when:

1. a user can create one shared GitHub integration binding from one existing todu project to one GitHub repo using the generic integration management surface
2. the binding uses `provider = github`, `targetKind = repository`, and `targetRef = owner/repo`
3. bootstrap immediately imports open GitHub issues and exports active/inprogress/waiting todu tasks when strategy is `bidirectional`
4. linked items receive `external_id = owner/repo#number`
5. title/body/status/priority/labels sync according to the mapping rules and respect the binding strategy
6. GitHub assignees sync into todu, but not the reverse
7. comments sync bidirectionally for create/edit/delete with strict 1:1 mirrored behavior when the binding strategy includes both directions
8. status and priority labels normalize deterministically
9. deletion maps to cancelation instead of hard deletion
10. sync runs on a configurable polling interval with per-binding retry state
11. shared binding desired state and shared binding status live in core todu synced state, while provider runtime state lives in plugin-local storage and detailed diagnostics remain available through local DB state plus logs
