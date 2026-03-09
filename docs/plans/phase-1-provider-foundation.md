# Phase 1: Provider Foundation

## Purpose

Create the GitHub sync provider foundation that plugs into the core integration binding architecture described in `../ARCHITECTURE.md` and task #2186.

This phase should establish the provider runtime shape, binding interpretation, and local provider configuration loading, but should not attempt full sync behavior yet.

## Scope

- scaffold the `syncProvider` registration for provider identity `github`
- implement provider initialization and shutdown structure
- accept host-supplied integration bindings
- parse and validate GitHub bindings with:
  - `provider = github`
  - `targetKind = repository`
  - `targetRef = owner/repo`
- load local provider configuration and credentials
- produce clear errors for invalid bindings or missing local config

## Deliverables

- provider registration/export
- runtime skeleton that can iterate applicable bindings
- binding parsing and validation utilities
- provider config/auth loading utilities
- tests for valid and invalid binding/config cases

## Acceptance Criteria

- the plugin exports a valid `syncProvider` registration
- bindings with `provider = github` and `targetKind = repository` are accepted
- malformed `targetRef` values fail with contextual errors
- missing or invalid local GitHub configuration fails clearly
- provider runtime can start and stop cleanly without performing full sync yet
- automated tests cover target parsing and config validation behavior

## Out of Scope

- bootstrap sync
- field mapping
- comment sync
- retry scheduling
- observability/status publishing
