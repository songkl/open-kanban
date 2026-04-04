# Contributing to Open-Kanban

Thank you for your interest in contributing to Open-Kanban!

## Code of Conduct

Please be respectful and constructive in all interactions. We follow a standard code of conduct for open source projects.

## Getting Started

### Prerequisites

- Go 1.21 or higher
- Node.js 18 or higher
- SQLite (included in Go)

### Development Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/songkl/open-kanban.git
   cd open-kanban
   ```

2. **Start the backend server**
   ```bash
   cd backend
   go run ./cmd/server
   ```

3. **Start the frontend (optional, for development)**
   ```bash
   cd frontend
   npm install
   npm run dev
   ```

4. **Start MCP server (for AI agent integration)**
   ```bash
   cd mcp-server
   npm install
   npm run build
   PORT=8081 npm run dev
   ```

## Making Changes

### Branch Naming

Use descriptive branch names:
- `feature/description` - for new features
- `fix/description` - for bug fixes
- `docs/description` - for documentation changes
- `refactor/description` - for code refactoring

### Commit Messages

Follow conventional commit format:
- `feat: add new feature` - for new features
- `fix: resolve issue #123` - for bug fixes
- `docs: update README` - for documentation
- `test: add tests for feature` - for test additions
- `refactor: improve code structure` - for refactoring

Include the task ID (e.g., `OPT-004`) in the commit message when applicable.

### Pull Request Process

1. **Create a feature branch** from `main`
2. **Make your changes** following the coding standards
3. **Add tests** for new functionality
4. **Ensure all tests pass**:
   ```bash
   go test ./...
   ```
5. **Update documentation** if needed
6. **Submit a pull request** with a clear description

## Coding Standards

### Backend (Go)

- Follow Go idioms and `gofmt` formatting
- Add unit tests for all handlers
- Use table-driven tests with subtests
- Handle errors explicitly
- Use transactions for multi-table operations

### Frontend (React)

- Use functional components with hooks
- Follow existing component patterns
- Add TypeScript types for props
- Use Tailwind CSS for styling
- Support dark mode with `dark:` variants

### API Design

- Use RESTful conventions
- Return appropriate HTTP status codes
- Use JSON for request/response bodies
- Prefer empty arrays `[]` over `null` for lists
- Include pagination for list endpoints

## Testing

### Backend Tests

Run all backend tests:
```bash
cd backend
go test ./...
```

Run tests with coverage:
```bash
go test -cover ./...
```

### Frontend Tests

Run frontend tests (when configured):
```bash
cd frontend
npm test
```

## Reporting Issues

When reporting issues, please include:
- Clear description of the problem
- Steps to reproduce
- Expected vs actual behavior
- Environment details (OS, Go version, etc.)
- Error messages or logs

## Feature Requests

We welcome feature requests! Please:
- Search existing issues first
- Describe the use case clearly
- Explain the expected behavior
- Provide mockups or examples if applicable

## License

By contributing, you agree that your contributions will be licensed under the same license as the project.
