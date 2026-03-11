# todu-github-plugin

A todu plugin that syncs GitHub issues to the todu system.

## Prerequisites

- Node.js 20+
- toduai CLI installed (`toduai --version`)
- overmind (process manager for dev environment)

## Installation

```bash
npm install
```

## Getting Started

### 1. Build the plugin

```bash
npm run build
```

This produces `dist/index.js` (bundled ESM) and `dist/index.d.ts` (type declarations).

### 2. Start the dev environment

```bash
make dev
```

This starts three services via overmind:

- `build` — watches TypeScript sources and rebuilds declarations
- `bundle` — watches and re-bundles `dist/index.js` via esbuild
- `daemon` — runs an isolated `toduai` daemon using `config/dev.toduai.yaml`

The dev environment uses a project-local data directory (`.dev/todu/data/`) that is completely separate from any normal `toduai` daemon on the machine.

### 3. Verify the plugin loaded

```bash
make dev-cli CMD="plugin list"
```

You should see the `github` plugin listed with status `ok`. The plugin path is configured in `config/dev.toduai.yaml` under `daemon.plugins.paths`.

### 4. Configure the GitHub token

```bash
make dev-cli CMD="plugin config github --set '{\"settings\":{\"token\":\"ghp_your_token_here\"},\"intervalSeconds\":30}'"
```

The token must be nested under `settings` because the daemon passes the `settings` sub-object to the provider's `initialize()` method. The optional `intervalSeconds` controls the sync polling interval (default: 300 seconds).

Restart the daemon to pick up new config:

```bash
make dev-stop && make dev
```

In production, plugin config is provided through the `TODUAI_DAEMON_PLUGIN_CONFIG` environment variable as a JSON object — no config file needed.

### 5. Create a test project

```bash
make dev-cli CMD="project create --name my-test-project"
```

Note the project ID from the output.

### 6. Add a GitHub integration binding

```bash
make dev-cli CMD="integration add --provider github --project my-test-project --target-kind repository --target owner/repo --strategy bidirectional"
```

Replace `owner/repo` with the GitHub repository you want to sync.

### 7. Verify sync

```bash
make dev-cli CMD="integration status"
```

Check the daemon logs for sync activity:

```bash
make dev-logs
```

## Dev Environment Reference

### Start / Stop

```bash
make dev          # Start all services (daemonized)
make dev-stop     # Stop all services
make dev-status   # Check if running
```

### Logs

```bash
make dev-logs     # Connect to overmind log output (Ctrl+C to detach)
make dev-tail     # Quick peek at recent logs
```

### Run commands against the dev daemon

```bash
# Generic wrapper
make dev-cli CMD="daemon status"
make dev-cli CMD="project list"
make dev-cli CMD="integration list"

# Convenience targets
make dev-daemon-status
make dev-projects
make dev-integrations
```

You can also call the CLI directly:

```bash
toduai --config ./config/dev.toduai.yaml daemon status
```

### Available make commands

```bash
make help
```

## Testing

### Unit tests

```bash
npm test                  # Run all unit tests
npm run test:watch        # Watch mode
npm run test:coverage     # With coverage report
```

### Integration tests

Integration tests run against a real GitHub repository ([evcraddock/todu-github-plugin-test](https://github.com/evcraddock/todu-github-plugin-test)) and require a GitHub token:

```bash
TODU_PLUGIN_GITHUB_TOKEN=ghp_xxx npm run test:integration
```

These tests are skipped when `TODU_PLUGIN_GITHUB_TOKEN` is not set.

### All checks

```bash
make check        # Lint + unit tests
make pre-pr       # Full pre-PR checks (format, lint, typecheck, test)
```

## Build

```bash
npm run build       # Full build (declarations + bundle)
npm run typecheck   # Type check only (no emit)
npm run lint        # ESLint
npm run format      # Prettier
```

The build uses:

- `tsc` for type declarations only (`tsconfig.build.json`)
- `esbuild` to bundle `src/index.ts` into a single `dist/index.js` with all dependencies inlined

Bundling is required because the `toduai` daemon is a compiled Bun binary that cannot resolve `node_modules` from dynamically imported plugin files.

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the full design.

## License

MIT
