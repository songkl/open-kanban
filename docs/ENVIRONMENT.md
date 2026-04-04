# Environment Variables

Complete list of environment variables for open-kanban server.

## Server

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `WEB_DIR` | embedded | Path to static web files (if not using embedded) |
| `ALLOWED_ORIGINS` | - | Comma-separated list of allowed CORS origins (e.g., `http://localhost:5173,http://localhost:8080`) |

## Database

### SQLite (Default)

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_TYPE` | `sqlite` | Database type |
| `DATABASE_URL` | `kanban.db` | Path to SQLite database file |

### MySQL

| Variable | Default | Description |
|----------|---------|-------------|
| `DB_TYPE` | `sqlite` | Database type (set to `mysql`) |
| `DB_HOST` | `localhost` | MySQL host |
| `DB_PORT` | `3306` | MySQL port |
| `DB_USER` | `root` | MySQL username |
| `DB_PASSWORD` | - | MySQL password |
| `DB_NAME` | `kanban` | MySQL database name |
| `DB_MAX_OPEN_CONNS` | `25` | Maximum open connections |
| `DB_MAX_IDLE_CONNS` | `5` | Maximum idle connections |
| `DB_CONN_MAX_LIFETIME` | `300` | Connection max lifetime (seconds) |

## WebSocket

| Variable | Default | Description |
|----------|---------|-------------|
| `WS_MAX_CONNECTIONS` | `100` | Maximum total WebSocket connections |
| `WS_MAX_CONNECTIONS_PER_USER` | `5` | Maximum connections per user |

## Rate Limiting

| Variable | Default | Description |
|----------|---------|-------------|
| `GLOBAL_RATE_LIMIT_REQUESTS` | `100` | Max requests per window |
| `GLOBAL_RATE_LIMIT_WINDOW_SECONDS` | `60` | Rate limit window in seconds |
| `RATE_LIMIT_STORE` | `memory` | Rate limit store type (`memory` or `redis`) |
| `REDIS_URL` | `localhost:6379` | Redis address (when `RATE_LIMIT_STORE=redis`) |

## Localization

| Variable | Default | Description |
|----------|---------|-------------|
| `APP_LOCALE` | `en` | Application locale (e.g., `en`, `zh-CN`) |

## Webhook

| Variable | Default | Description |
|----------|---------|-------------|
| `WEBHOOK_ENABLED` | `false` | Enable webhook notifications |
| `WEBHOOK_URL` | - | Webhook endpoint URL |
| `WEBHOOK_SECRET` | - | Webhook secret for signing |

## Signature Verification

Used for MCP server authentication.

| Variable | Default | Description |
|----------|---------|-------------|
| `SIGNATURE_ENABLED` | not set | Enable signature verification (`0` to disable, `1` to enable) |
| `SIGNATURE_SECRETS` | - | Comma-separated secrets (`key:secret` pairs) |

## Example .env File

```bash
# Server
PORT=8080
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8080

# Database (SQLite)
DB_TYPE=sqlite
DATABASE_URL=kanban.db

# Or MySQL
# DB_TYPE=mysql
# DB_HOST=localhost
# DB_PORT=3306
# DB_USER=kanban
# DB_PASSWORD=kanban_pass
# DB_NAME=kanban

# WebSocket
WS_MAX_CONNECTIONS=100
WS_MAX_CONNECTIONS_PER_USER=5

# Rate Limiting
GLOBAL_RATE_LIMIT_REQUESTS=100
GLOBAL_RATE_LIMIT_WINDOW_SECONDS=60

# Webhook (optional)
# WEBHOOK_ENABLED=true
# WEBHOOK_URL=https://example.com/webhook
# WEBHOOK_SECRET=your-secret

# Signature (for MCP)
# SIGNATURE_ENABLED=1
# SIGNATURE_SECRETS=key1:secret1,key2:secret2
```
