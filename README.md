# todu-github-plugin

A todu plugin that syncs GitHub issues to the todu system.

## Prerequisites

- Node.js 20+ or Bun 1.0+

## Installation

```bash
npm install
# or
bun install
```

## How to Work on This Project

### Local Dev Environment

The repo uses an isolated local `toduai` development environment.

- Dev config file: `config/dev.toduai.yaml`
- Dev runtime data: `.dev/todu/data/`
- Dev daemon socket: `.dev/todu/data/daemon.sock`

This keeps local development separate from any normal `toduai` daemon already running on the machine.

The `.dev/` runtime directory is intentionally gitignored.

### Start the Dev Environment

```bash
make dev
```

This starts all services defined in `Procfile.dev` and returns immediately.

Current services:

- `build` - watches and rebuilds the plugin
- `daemon` - runs an isolated local `toduai` daemon using `config/dev.toduai.yaml`

### View Logs

```bash
# Stream all logs (Ctrl+C to stop)
make dev-logs

# Quick peek at recent logs
make dev-tail
```

### Check Process Status

```bash
make dev-status
```

### Check Dev Daemon Status via CLI

```bash
make dev-daemon-status
```

### Run `toduai` Against the Dev Daemon

```bash
# Generic wrapper
make dev-cli CMD="daemon status"
make dev-cli CMD="project list"
make dev-cli CMD="integration list"

# Convenience targets
make dev-projects
make dev-integrations
```

You can also call the CLI directly:

```bash
toduai --config ./config/dev.toduai.yaml daemon status
toduai --config ./config/dev.toduai.yaml project list
toduai --config ./config/dev.toduai.yaml integration list
```

### Stop the Dev Environment

```bash
make dev-stop
```

### Run Tests and Linting

```bash
make check
```

### Before Opening a PR

```bash
make pre-pr
```

### Available Make Commands

```bash
make help
```

## Manual Setup Notes

- Copy `.env.example` to `.env` if you want local overrides such as `TODUAI_LOG_LEVEL`.
- The dev environment is intentionally minimal and does not include an Automerge sync server or multi-machine simulation.
- The daemon is isolated and ready for plugin development work. Actual GitHub provider loading will be added as the implementation tasks introduce the provider runtime.

## Starter Code

The initial scaffold includes a tiny issue identifier helper in `src/index.ts` so linting, type-checking, and tests have a real project module to exercise.

## License

MIT
