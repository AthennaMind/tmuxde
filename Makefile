# Go checks for the module at the repository root. Every target runs in the
# offline gotools service, never on the host.

COMPOSE ?= docker compose
GOTOOLS := $(COMPOSE) run --rm gotools

.DEFAULT_GOAL := help
.PHONY: help vet lint test race check

help: ## List targets
	@awk 'BEGIN { FS = ":.*## " } /^[a-z]+:.*## / { printf "  %-6s %s\n", $$1, $$2 }' $(MAKEFILE_LIST)

vet: ## go vet
	$(GOTOOLS) go vet ./...

lint: ## golangci-lint with .golangci.yml
	$(GOTOOLS) golangci-lint run ./...

test: ## go test
	$(GOTOOLS) go test ./...

race: ## go test with race detector, needs cgo
	$(COMPOSE) run --rm -e CGO_ENABLED=1 gotools go test -race ./...

check: vet lint test ## vet, lint and test
