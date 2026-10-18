# Local tooling runs in started dev containers. CI uses direct commands.
SHELL := /bin/bash
GO_EXEC := docker compose exec -T -w /workspace server-dev
UI_EXEC := docker compose exec -T -w /workspace/ui ui
GO_TEST_ARGS ?= ./...
UI_TEST_ARGS ?=
VERSION ?= dev

.DEFAULT_GOAL := help
.PHONY: help setup deps vet lint test go-test ui-test integration race typecheck check ui ui-build build

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z-]+:.*## / { printf "  %-14s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

setup: ## Create dev settings once, preserving existing settings
	@if [ ! -f .env ]; then \
		umask 077; \
		printf 'AUTH_TOKEN=%s\nDEV_UID=%s\nDEV_GID=%s\nLOCAL_DOMAIN=localhost\n' \
			"$$(openssl rand -hex 32)" "$$(id -u)" "$$(id -g)" > .env; \
	fi
	@echo 'Dev settings: .env.'
	@echo 'Start with docker compose up -d --build --wait.'

deps: ## Install UI dependencies in running ui container
	$(UI_EXEC) pnpm install --frozen-lockfile --ignore-scripts
	$(UI_EXEC) pnpm --offline --config.trustLockfile=true rebuild --pending

vet: ## Go vet in server-dev
	$(GO_EXEC) go vet ./...

lint: ## Go lint including integration tests in server-dev
	$(GO_EXEC) golangci-lint run --build-tags=integration --timeout=5m ./...

go-test: ## Go unit tests in server-dev; override GO_TEST_ARGS to select tests
	$(GO_EXEC) go test $(GO_TEST_ARGS)

ui-test: ## UI tests in ui; override UI_TEST_ARGS to select tests
	$(UI_EXEC) pnpm test $(UI_TEST_ARGS)

test: go-test ui-test ## Go unit and UI tests

integration: ## Integration tests with container tmux, Git and shell tools
	$(GO_EXEC) go test -tags=integration -run '^TestIntegration' -count=1 -timeout=10m $(GO_TEST_ARGS)

race: ## Go unit tests with race detector in server-dev
	$(GO_EXEC) env CGO_ENABLED=1 go test -race $(GO_TEST_ARGS)

typecheck: ## UI TypeScript checks in ui
	$(UI_EXEC) pnpm typecheck

ui-build: ## Build UI and copy assets to web/dist inside ui
	$(UI_EXEC) pnpm build
	$(UI_EXEC) sh -ec 'mkdir -p ../web/dist; find ../web/dist -mindepth 1 ! -name .gitkeep -delete; cp -a dist/. ../web/dist/'

ui: typecheck ui-build ## UI typecheck and embedded production assets

check: vet lint test typecheck ## Vet, lint, unit tests and typecheck without builds

build: ui ## Build Linux tmuxde with embedded UI in server-dev
	$(GO_EXEC) mkdir -p dist
	$(GO_EXEC) env CGO_ENABLED=0 go build -trimpath -ldflags '-s -w -buildid= -X main.version=$(VERSION)' -o dist/tmuxde ./cmd/tmuxde
