DEV_CONFIG := ./config/dev.toduai.yaml
DEV_CLI := toduai --config $(DEV_CONFIG)

.PHONY: dev dev-stop dev-status dev-logs dev-tail dev-daemon-status dev-projects dev-integrations dev-cli check pre-pr help

SOCKET := ./.overmind.sock

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "\033[36m%-15s\033[0m %s\n", $$1, $$2}'

dev: ## Start the dev environment (daemonized)
	@if [ ! -f $(DEV_CONFIG) ]; then \
		echo "Creating $(DEV_CONFIG) from template..."; \
		cp $(DEV_CONFIG).template $(DEV_CONFIG); \
	fi
	@if [ -S $(SOCKET) ] && overmind ps -s $(SOCKET) > /dev/null 2>&1; then \
		echo "Dev environment already running"; \
		overmind ps -s $(SOCKET); \
	else \
		rm -f $(SOCKET); \
		overmind start -f Procfile.dev -s $(SOCKET) -D; \
		sleep 2; \
		overmind ps -s $(SOCKET); \
	fi

dev-stop: ## Stop the dev environment
	@if [ -S $(SOCKET) ]; then overmind quit -s $(SOCKET) || true; fi
	@rm -f $(SOCKET)
	@tmux list-sessions 2>/dev/null | grep overmind | cut -d: -f1 | xargs -r -n1 tmux kill-session -t 2>/dev/null || true

dev-status: ## Check if dev environment is running
	@if [ -S $(SOCKET) ] && overmind ps -s $(SOCKET) > /dev/null 2>&1; then \
		echo "running"; \
	else \
		echo "stopped"; \
	fi

dev-logs: ## Connect to overmind log output (Ctrl+C to detach)
	overmind connect -s $(SOCKET)

dev-tail: ## Show last 100 lines of logs (non-blocking)
	@if [ -S $(SOCKET) ]; then \
		for pane in $$(tmux -S $(SOCKET) list-panes -a -F '#{pane_id}' 2>/dev/null); do \
			tmux -S $(SOCKET) capture-pane -p -t "$$pane" -S -100 2>/dev/null; \
		done; \
	else \
		echo "Dev environment not running"; \
	fi

dev-daemon-status: ## Show isolated dev daemon status via toduai
	$(DEV_CLI) daemon status

dev-projects: ## List projects against the isolated dev daemon
	$(DEV_CLI) project list

dev-integrations: ## List integrations against the isolated dev daemon
	$(DEV_CLI) integration list

dev-cli: ## Run a toduai command against the isolated dev config (usage: make dev-cli CMD="daemon status")
	@test -n "$(CMD)" || (echo "Usage: make dev-cli CMD=\"daemon status\"" && exit 1)
	$(DEV_CLI) $(CMD)

check: ## Run linting and tests
	npm run lint && npm test

pre-pr: ## Run pre-PR checks
	./scripts/pre-pr.sh

# Connect to specific service terminal (replace 'app' with service name from Procfile.dev)
# connect-app: ## Connect to app terminal
# 	overmind connect -s $(SOCKET) app
