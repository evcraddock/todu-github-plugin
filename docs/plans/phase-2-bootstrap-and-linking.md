# Phase 2: Bootstrap and Linking

## Purpose

Implement the initial bootstrap behavior and durable task/issue linking model from `../ARCHITECTURE.md`.

This phase should make it possible for a GitHub integration binding to create and discover linked tasks/issues using the agreed `external_id` convention.

## Scope

- bootstrap from GitHub open issues into todu
- bootstrap from todu tasks in `active`, `inprogress`, and `waiting` into GitHub
- ignore existing todu tasks in `done` and `canceled` during bootstrap
- assign and honor `external_id = owner/repo#number`
- follow the duplicate policy from the architecture doc
- implement item-link persistence in local runtime storage

## Deliverables

- bootstrap import path from GitHub to todu
- bootstrap export path from todu to GitHub
- durable item-link creation logic
- external ID assignment/update logic
- tests for bootstrap creation and linking behavior

## Acceptance Criteria

- a new GitHub binding can bootstrap open GitHub issues into the linked todu project
- a new GitHub binding can bootstrap active/inprogress/waiting todu tasks into GitHub
- linked items receive the expected `external_id` format
- duplicate handling follows the architecture decision rather than fuzzy matching
- bootstrap logic respects binding strategy where applicable
- automated tests cover both import and export bootstrap paths

## Out of Scope

- full steady-state field reconciliation
- comment sync
- retry/backoff behavior
- shared status publishing
