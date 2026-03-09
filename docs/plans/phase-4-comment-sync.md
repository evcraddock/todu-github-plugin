# Phase 4: Comment Sync

## Purpose

Implement the strict 1:1 mirrored comment model from `../ARCHITECTURE.md`.

This phase should complete the user-visible sync behavior by handling comment creation, editing, deletion, attribution, and conflict resolution.

## Scope

- create mirrored comments in both directions
- edit mirrored comments in both directions
- hard delete mirrored comments in both directions
- maintain local comment link state
- apply visible attribution headers in mirrored markdown comments
- resolve comment edit conflicts with comment-level last-write-wins behavior

## Deliverables

- comment mapping/link storage
- comment create/edit/delete sync logic
- attribution formatting helpers
- tests for comment lifecycle behavior and conflicts

## Acceptance Criteria

- one GitHub comment maps to one todu comment and vice versa
- mirrored comments include the expected attribution format
- editing a comment on one side updates the mirrored comment on the other side
- deleting a comment on one side deletes the mirrored comment on the other side
- comment conflicts resolve according to the architecture rules
- automated tests cover comment creation, edits, deletes, and conflict handling

## Out of Scope

- retry/backoff scheduling
- shared binding status publishing
- broader runtime cleanup behavior outside comment links
