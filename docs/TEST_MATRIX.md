# Test Matrix

Documented coverage for major sync behaviors. Each row maps to one or more automated tests.

## Legend

- **U** = unit test (in-memory, fast, no credentials)
- **I** = integration test (real GitHub API, requires `TODU_PLUGIN_GITHUB_TOKEN`)

## Provider Foundation

| Behavior                            | Type | Status |
| ----------------------------------- | ---- | ------ |
| Parse owner/repo target ref         | U    | ✅     |
| Reject malformed target ref         | U    | ✅     |
| Parse owner/repo#number external ID | U    | ✅     |
| Reject malformed external ID        | U    | ✅     |
| Validate github provider binding    | U    | ✅     |
| Reject non-github provider          | U    | ✅     |
| Reject unsupported target kind      | U    | ✅     |
| Load token from provider settings   | U    | ✅     |
| Reject missing token                | U    | ✅     |
| Throw when not initialized          | U    | ✅     |

## Bootstrap and Linking

| Behavior                                          | Type | Status |
| ------------------------------------------------- | ---- | ------ |
| Pull imports open issues with normalized fields   | U    | ✅     |
| Pull imports linked closed issues                 | U    | ✅     |
| Pull excludes pull requests                       | U    | ✅     |
| Push exports active/inprogress/waiting tasks      | U    | ✅     |
| Push skips done/canceled tasks                    | U    | ✅     |
| Push creates new issues for unlinked tasks        | U    | ✅     |
| Push follows duplicate policy (no title matching) | U    | ✅     |
| File-backed link store persists across instances  | U    | ✅     |

## Field Sync

| Behavior                                                    | Type | Status |
| ----------------------------------------------------------- | ---- | ------ |
| Push updates linked issue title/body/status/priority/labels | U    | ✅     |
| Push skips update when GitHub issue is newer                | U    | ✅     |
| Pull imports GitHub assignees                               | U    | ✅     |
| Push does not sync assignees back to GitHub                 | U    | ✅     |

## Status and Priority Normalization

| Behavior                                                                      | Type | Status |
| ----------------------------------------------------------------------------- | ---- | ------ |
| Conflicting open status labels use precedence (active > inprogress > waiting) | U    | ✅     |
| Conflicting closed status labels use precedence (done > canceled)             | U    | ✅     |
| Closed + open status label trusts closed state → done                         | U    | ✅     |
| Priority normalization uses precedence (high > medium > low)                  | U    | ✅     |
| Missing priority defaults to medium                                           | U    | ✅     |
| Reserved labels stripped from normal labels                                   | U    | ✅     |
| Push merges normal labels with status and priority labels                     | U    | ✅     |

## Reopen / Close / Cancel

| Behavior                                           | Type | Status |
| -------------------------------------------------- | ---- | ------ |
| Reopened issue imports as open status              | U    | ✅     |
| Closed issue without label maps to done            | U    | ✅     |
| Closed issue with status:canceled maps to canceled | U    | ✅     |
| Done task pushes as closed + status:done           | U    | ✅     |
| Canceled task pushes as closed + status:canceled   | U    | ✅     |

## Comment Sync

| Behavior                                                | Type | Status |
| ------------------------------------------------------- | ---- | ------ |
| Pull imports GitHub comments with attribution           | U    | ✅     |
| Push creates GitHub comments with todu attribution      | U    | ✅     |
| Push updates mirrored comment on edit                   | U    | ✅     |
| Push deletes mirrored comment when note removed         | U    | ✅     |
| Pull detects deleted GitHub comments and removes links  | U    | ✅     |
| Edit conflict resolved by last-write-wins timestamps    | U    | ✅     |
| 1:1 comment mapping maintained across multiple comments | U    | ✅     |
| Comment attribution formatting (GitHub and todu)        | U    | ✅     |
| Attribution stripping                                   | U    | ✅     |

## Strategy

| Behavior                 | Type | Status |
| ------------------------ | ---- | ------ |
| Strategy push skips pull | U    | ✅     |
| Strategy pull skips push | U    | ✅     |
| Strategy none skips both | U    | ✅     |

## Runtime and Observability

| Behavior                                        | Type | Status |
| ----------------------------------------------- | ---- | ------ |
| Initial runtime state has no retry or cursor    | U    | ✅     |
| Exponential backoff delay doubles per attempt   | U    | ✅     |
| Backoff caps at maxSeconds                      | U    | ✅     |
| Success resets retry state                      | U    | ✅     |
| Failure increments retry attempt                | U    | ✅     |
| shouldRetry gates on backoff time               | U    | ✅     |
| Runtime store persists to file                  | U    | ✅     |
| Runtime store returns copies (mutation safety)  | U    | ✅     |
| Provider records success in runtime store       | U    | ✅     |
| Provider records failure in runtime store       | U    | ✅     |
| Provider skips sync when backoff not elapsed    | U    | ✅     |
| Provider resets retry after successful recovery | U    | ✅     |

## Binding Status

| Behavior                                                | Type | Status |
| ------------------------------------------------------- | ---- | ------ |
| Binding status starts idle                              | U    | ✅     |
| Running transition records attempt time                 | U    | ✅     |
| Idle transition records success, clears error           | U    | ✅     |
| Error transition records error summary                  | U    | ✅     |
| Blocked transition records reason                       | U    | ✅     |
| Full lifecycle: idle → running → idle                   | U    | ✅     |
| Full lifecycle: idle → running → error → running → idle | U    | ✅     |
| Provider updates status to idle on success              | U    | ✅     |
| Provider updates status to error on failure             | U    | ✅     |

## Loop Prevention

| Behavior                                            | Type | Status |
| --------------------------------------------------- | ---- | ------ |
| Record and detect own writes                        | U    | ✅     |
| Different timestamps don't match                    | U    | ✅     |
| Re-record overwrites previous timestamp             | U    | ✅     |
| Expired entries cleared                             | U    | ✅     |
| Recent entries preserved                            | U    | ✅     |
| Provider records loop prevention writes during push | U    | ✅     |

## Logging

| Behavior                                 | Type | Status |
| ---------------------------------------- | ---- | ------ |
| Logger records entries at all levels     | U    | ✅     |
| Logger captures full context fields      | U    | ✅     |
| Logger returns copies (mutation safety)  | U    | ✅     |
| Log entry formatting includes all fields | U    | ✅     |

## Multi-Cycle Sync

| Behavior                                     | Type | Status |
| -------------------------------------------- | ---- | ------ |
| Pull → push → pull produces consistent state | U    | ✅     |
| Bidirectional updates converge across cycles | U    | ✅     |

## Failure Paths

| Behavior                                       | Type | Status |
| ---------------------------------------------- | ---- | ------ |
| Pull error propagates without corrupting state | U    | ✅     |
| Push error propagates without corrupting state | U    | ✅     |
| Pull before initialize throws                  | U    | ✅     |
| Push before initialize throws                  | U    | ✅     |

## Integration Tests

| Behavior                               | Type | Status  |
| -------------------------------------- | ---- | ------- |
| Bootstrap import from real GitHub repo | I    | planned |
| Task export creates real GitHub issue  | I    | planned |
| Field sync round-trip with real API    | I    | planned |
| Comment create/edit/delete round-trip  | I    | planned |
