.PHONY: lint lint-fix install-lint

GOLANGCI_LINT := $(shell command -v golangci-lint 2>/dev/null || echo "$(GOPATH)/bin/golangci-lint")
GOPATH := $(shell go env GOPATH)

lint:
	@if [ ! -f "$(GOLANGCI_LINT)" ]; then \
		echo "golangci-lint not found. Run 'make install-lint' first."; \
		exit 1; \
	fi
	$(GOLANGCI_LINT) run ./...

lint-fix:
	@if [ ! -f "$(GOLANGCI_LINT)" ]; then \
		echo "golangci-lint not found. Run 'make install-lint' first."; \
		exit 1; \
	fi
	$(GOLANGCI_LINT) run --fix ./...

install-lint:
	go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
