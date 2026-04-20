# CLAUDE.md

## Development Requirements

### Feature Development

Every new feature addition **must** include:

1. **Unit Tests**
   - All new backend handlers must have corresponding test functions
   - Test file naming convention: `*_test.go` in the same package
   - Use table-driven tests with subtests for different scenarios
   - Minimum coverage: happy path + error cases + edge cases

2. **Test Execution**
   - All tests must pass before marking a task as complete
   - Run `go test ./...` to verify all backend tests pass
   - Run `npm test` (when configured) to verify frontend tests pass

3. **Test Database Setup**
   - Use in-memory SQLite (`:memory:`) for handler tests
   - Include all required tables and foreign keys in schema
   - Insert required seed data (users, tokens, boards, etc.) before tests
   - Use `requireAuth` middleware pattern for auth-required endpoints

### Code Style

- Use `bash` with `python3` or `cat > file << 'ENDOFFILE'` for file writes (MCP write tool may be blocked)
- Match existing code conventions in the codebase
- Add `dark:` Tailwind variants for dark mode support
- Use `utf8.ValidString` / `strings.ToValidUTF8` for WebSocket safety

### API Development

- Public endpoints (GetBoards, etc.) do not require auth middleware
- Auth-required endpoints use `RequireAuth(db)` middleware
- Prefer returning empty arrays `[]` over `null` for list responses
- Use proper HTTP status codes (200, 400, 401, 403, 404, 500)

### Build Verification

- Backend: `go build -o /tmp/server ./cmd/server`
- Frontend: `npm run build`
- MCP Server: `npm run build` in mcp-server directory, for dev PORT=8081

### Git Commit Messages

All commit messages **must** start with the task ID in the format `T-XXXX: `.

**Correct:**
- `T-123: Add user login feature`
- `T-456: Fix pagination bug`

**Incorrect:**
- `Add user login feature`
- `Fixed the bug`

This ensures every commit is traceable to a specific task.

