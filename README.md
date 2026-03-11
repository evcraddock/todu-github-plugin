# todu-github-plugin

A sync provider plugin for [todu](https://github.com/evcraddock/todu) that provides bidirectional synchronization between GitHub issues and todu tasks. Issues, labels, status, priority, and comments are kept in sync automatically.

## Installation

### 1. Clone and build

```bash
git clone https://github.com/evcraddock/todu-github-plugin.git
cd todu-github-plugin
npm install
npm run build
```

### 2. Register the plugin

Add the built plugin path to your toduai daemon config under `daemon.plugins.paths`:

```yaml
daemon:
  plugins:
    paths:
      - /absolute/path/to/todu-github-plugin/dist/index.js
```

### 3. Configure your GitHub token

```bash
toduai plugin config github --set '{"settings":{"token":"ghp_your_token_here"},"intervalSeconds":300}'
```

The token needs `repo` scope for private repositories or `public_repo` for public ones. `intervalSeconds` controls how often the plugin syncs (default: 300 seconds).

### 4. Create a project and binding

```bash
toduai project create --name my-project
toduai integration add \
  --provider github \
  --project my-project \
  --target-kind repository \
  --target owner/repo \
  --strategy bidirectional
```

Replace `owner/repo` with the GitHub repository to sync. Strategy options: `bidirectional`, `pull`, `push`, or `none`.

### 5. Verify

```bash
toduai integration status
```

## Development

### Prerequisites

- Node.js 20+
- [overmind](https://github.com/DarthSim/overmind) (process manager)
- toduai CLI installed

### Setup

```bash
npm install
cp config/dev.toduai.yaml.template config/dev.toduai.yaml
```

The dev config is gitignored because `toduai plugin config` writes secrets into it.

### Dev environment

```bash
make dev          # Start all services
make dev-stop     # Stop all services
make dev-status   # Check status
```

This runs three processes via overmind:

- **build** — `tsc --watch` for type declarations
- **bundle** — `esbuild --watch` to produce `dist/index.js` with all dependencies inlined
- **daemon** — isolated todu daemon using the dev config

The dev environment uses a project-local data directory (`.dev/todu/data/`) separate from any production daemon.

### Common commands

```bash
make dev-cli CMD="plugin list"          # Run any toduai command against dev daemon
make dev-cli CMD="task list"            # List tasks
make dev-logs                           # View daemon logs
npm test                                # Run unit tests
npm run typecheck                       # Type check
make pre-pr                             # Full pre-PR checks (format, lint, typecheck, test)
```

## Architecture

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT
