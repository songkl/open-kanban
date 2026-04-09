#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

failed=0

echo_step() {
    echo ""
    echo -e "${YELLOW}=== $1 ===${NC}"
}

echo_success() {
    echo -e "${GREEN}✓ $1${NC}"
}

echo_fail() {
    echo -e "${RED}✗ $1${NC}"
}

cd "$PROJECT_DIR"

echo_step "Go Format Check"
unformatted=$(gofmt -l .)
if [ -n "$unformatted" ]; then
    echo "The following files are not formatted correctly:"
    echo "$unformatted"
    echo "Run 'gofmt -w .' to fix"
    failed=1
else
    echo_success "gofmt check passed"
fi

echo_step "Go Lint"
GOLANGCI_LINT="$(command -v golangci-lint 2>/dev/null || echo "$HOME/go/bin/golangci-lint")"
if [ ! -f "$GOLANGCI_LINT" ]; then
    echo "golangci-lint not found. Installing..."
    go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
    GOLANGCI_LINT="$HOME/go/bin/golangci-lint"
fi
cd backend
if $GOLANGCI_LINT run ./...; then
    echo_success "golangci-lint check passed"
else
    echo_fail "golangci-lint check failed"
    failed=1
fi
cd "$PROJECT_DIR"

echo_step "Go Test"
cd backend
if go test ./... -race -coverprofile=coverage.out; then
    COVERAGE=$(go tool cover -func=coverage.out | grep total | awk '{print $3}' | sed 's/%//')
    echo "Coverage: $COVERAGE%"
    if (( $(echo "$COVERAGE < 50" | bc -l) )); then
        echo "Coverage is below 50% threshold"
        failed=1
    else
        echo_success "Go tests passed"
    fi
else
    echo_fail "Go tests failed"
    failed=1
fi
cd "$PROJECT_DIR"

echo_step "Go Build"
cd backend
if go build -o /tmp/kanban-server-test ./cmd/server/main.go; then
    echo_success "Go build passed"
else
    echo_fail "Go build failed"
    failed=1
fi
cd "$PROJECT_DIR"

echo_step "Frontend Install & Lint"
cd frontend
npm ci > /dev/null 2>&1
if npm run lint; then
    echo_success "Frontend lint passed"
else
    echo_fail "Frontend lint failed"
    failed=1
fi

echo_step "Frontend Test"
if npm run test:run -- --coverage; then
    echo_success "Frontend tests passed"
else
    echo_fail "Frontend tests failed"
    failed=1
fi

echo_step "Frontend Build"
if npm run build; then
    echo_success "Frontend build passed"
else
    echo_fail "Frontend build failed"
    failed=1
fi

cd "$PROJECT_DIR"

echo ""
if [ $failed -eq 0 ]; then
    echo -e "${GREEN}=== All CI checks passed ===${NC}"
    exit 0
else
    echo -e "${RED}=== Some CI checks failed ===${NC}"
    exit 1
fi
