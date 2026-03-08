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

### Start the Dev Environment

```bash
make dev
```

This starts all services defined in `Procfile.dev`. The command returns immediately (daemonized).

### View Logs

```bash
# Stream all logs (Ctrl+C to stop)
make dev-logs

# Quick peek at recent logs
make dev-tail
```

### Check Status

```bash
make dev-status
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

## Dev Environment Setup

If `make dev` fails, the dev environment needs configuration. See `todu` task #2177 (`Set up dev environment`) for the follow-up setup work.

## Starter Code

The initial scaffold includes a tiny issue identifier helper in `src/index.ts` so linting, type-checking, and tests have a real project module to exercise.

## License

MIT
