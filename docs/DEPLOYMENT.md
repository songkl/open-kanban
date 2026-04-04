# Deployment Best Practices

## Quick Start with Docker

### SQLite (Recommended for small deployments)

```bash
docker-compose up -d kanban
```

Access at http://localhost:8080

### MySQL (Recommended for production)

```bash
docker-compose up -d kanban-mysql
# Wait for MySQL to be healthy
docker-compose up -d kanban-with-mysql
```

## Production Checklist

### 1. Database

- [ ] Use MySQL instead of SQLite for production
- [ ] Configure proper connection pooling (`DB_MAX_OPEN_CONNS`, `DB_MAX_IDLE_CONNS`)
- [ ] Enable regular backups
- [ ] Use a dedicated database user with minimal privileges

### 2. Security

- [ ] Set `ALLOWED_ORIGINS` to your actual frontend domain(s)
- [ ] Use HTTPS in production
- [ ] Enable signature verification for MCP (`SIGNATURE_ENABLED=1`)
- [ ] Use strong secrets for `SIGNATURE_SECRETS`
- [ ] Configure proper firewall rules

### 3. Resource Limits

```yaml
# docker-compose.yml additions for production
services:
  kanban:
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
```

### 4. WebSocket Connections

Adjust based on expected users:

| Users | `WS_MAX_CONNECTIONS` | `WS_MAX_CONNECTIONS_PER_USER` |
|-------|---------------------|-------------------------------|
| 100 | 150 | 5 |
| 500 | 750 | 5 |
| 1000+ | 1500+ | 3 |

## Health Monitoring

### Health Check Endpoint

```
GET /api/v1/health
GET /api/v1/status
```

Returns JSON:
```json
{"status": "ok"}
```

### Setting Up Monitoring

```bash
# Simple health check
curl http://localhost:8080/api/v1/health

# Check with authentication
curl -H "Authorization: Bearer <token>" http://localhost:8080/api/v1/status
```

### Recommended Monitoring Stack

1. **Uptime monitoring**: Use uptimekuma, Grafana, or cloud provider health checks
2. **Log aggregation**: Ship logs to Loki, ELK, or cloud logging
3. **Metrics**: Export WebSocket connection metrics via `/api/v1/status`

Example Prometheus scrape config:
```yaml
scrape_configs:
  - job_name: 'kanban'
    static_configs:
      - targets: ['kanban:8080']
    metrics_path: '/api/v1/status'
```

## Docker Deployment

### Environment Variables

```yaml
services:
  kanban:
    environment:
      - PORT=8080
      - DATABASE_URL=/app/data/kanban.db
      - ALLOWED_ORIGINS=https://yourdomain.com
      - WS_MAX_CONNECTIONS=500
      - GLOBAL_RATE_LIMIT_REQUESTS=200
    volumes:
      - kanban-data:/app/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:8080/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 3
```

### Reverse Proxy (nginx)

```nginx
server {
    listen 443 ssl;
    server_name kanban.yourdomain.com;

    location / {
        proxy_pass http://localhost:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }

    location /api/ {
        proxy_pass http://localhost:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

## Scaling Considerations

### Horizontal Scaling

- WebSocket connections are stateful (sticky sessions required)
- Use `RATE_LIMIT_STORE=redis` for distributed rate limiting
- Database should be centralized (MySQL)

### Database Tuning (MySQL)

```sql
-- Recommended MySQL settings
innodb_buffer_pool_size = 256M
max_connections = 100
innodb_file_per_table = ON
```

## Backup Strategy

### SQLite

```bash
# Daily backup script
cp /path/to/kanban.db /backup/kanban-$(date +%Y%m%d).db
```

### MySQL

```bash
# Daily backup
mysqldump -u kanban -p kanban > /backup/kanban-$(date +%Y%m%d).sql
```

## Troubleshooting

### High memory usage

- Reduce `DB_MAX_OPEN_CONNS`
- Lower `WS_MAX_CONNECTIONS`
- Enable connection pooling for MySQL

### WebSocket disconnections

- Check `ALLOWED_ORIGINS` includes your frontend domain
- Verify proxy passes `Upgrade` headers (for nginx)
- Check `WS_MAX_CONNECTIONS_PER_USER` limit

### Slow API responses

- Add database indexes
- Enable query logging
- Check connection pool settings
