# API Changelog

This document tracks changes to the Open-Kanban API specification.

## [1.0.0] - 2026-03-31

### Added

- Initial API specification
- **Authentication**
  - `POST /api/v1/auth/login` - User authentication
  - `POST /api/v1/auth/init` - Server initialization
  - `GET /api/v1/auth/me` - Get current user
  - `GET /api/v1/auth/config` - Get public app configuration
  - `GET /api/v1/auth/token` - List user tokens
  - `POST /api/v1/auth/token` - Create API token
  - `PUT /api/v1/auth/token` - Update token
  - `DELETE /api/v1/auth/token` - Delete token
  - `GET /api/v1/auth/activities` - Activity log
  - `GET /api/v1/auth/agents` - List agents
  - `POST /api/v1/auth/agents` - Create agent
  - `DELETE /api/v1/auth/agents` - Delete agent
  - `POST /api/v1/auth/agents/reset-token` - Reset agent token
  - `GET /api/v1/auth/users` - List users
  - `PUT /api/v1/auth/users` - Update user
  - `POST /api/v1/auth/users/enabled` - Enable/disable user
  - `GET /api/v1/auth/permissions` - List permissions
  - `POST /api/v1/auth/permissions` - Set permission
  - `DELETE /api/v1/auth/permissions` - Delete permission
  - `GET /api/v1/auth/permissions/columns` - Get column permissions
  - `POST /api/v1/auth/permissions/columns` - Set column permission
  - `DELETE /api/v1/auth/permissions/columns` - Delete column permission
  - `PUT /api/v1/auth/config` - Update app config

- **Boards**
  - `GET /api/v1/boards` - List all boards (public)
  - `POST /api/v1/boards` - Create board
  - `GET /api/v1/boards/{id}` - Get board (public)
  - `PUT /api/v1/boards/{id}` - Update board
  - `DELETE /api/v1/boards/{id}` - Delete board (soft delete)
  - `GET /api/v1/boards/{id}/export` - Export board
  - `POST /api/v1/boards/{id}/reset` - Reset board
  - `POST /api/v1/boards/{id}/copy` - Copy board
  - `POST /api/v1/boards/from-template` - Create board from template
  - `POST /api/v1/boards/import` - Import board

- **Columns**
  - `GET /api/v1/columns` - List columns (public)
  - `POST /api/v1/columns` - Create column
  - `PUT /api/v1/columns` - Update column
  - `DELETE /api/v1/columns` - Delete column
  - `PUT /api/v1/columns/reorder` - Reorder columns
  - `GET /api/v1/columns/{columnId}/agent` - Get column agent config
  - `POST /api/v1/columns/{columnId}/agent` - Set column agent config
  - `DELETE /api/v1/columns/{columnId}/agent` - Delete column agent config

- **Tasks**
  - `GET /api/v1/tasks` - List tasks (public)
  - `POST /api/v1/tasks` - Create task
  - `GET /api/v1/tasks/{id}` - Get task (public)
  - `PUT /api/v1/tasks/{id}` - Update task
  - `DELETE /api/v1/tasks/{id}` - Delete task
  - `POST /api/v1/tasks/{id}/archive` - Archive/unarchive task
  - `POST /api/v1/tasks/{id}/complete` - Complete task
  - `GET /api/v1/tasks/{id}/attachments` - Get attachments
  - `GET /api/v1/archived` - List archived tasks
  - `GET /api/v1/drafts` - List draft tasks

- **Comments**
  - `GET /api/v1/comments` - List comments (public)
  - `POST /api/v1/comments` - Create comment
  - `GET /api/v1/comments/{id}` - Get comment (public)

- **Subtasks**
  - `GET /api/v1/subtasks` - List subtasks
  - `POST /api/v1/subtasks` - Create subtask
  - `PUT /api/v1/subtasks/{id}` - Update subtask
  - `DELETE /api/v1/subtasks/{id}` - Delete subtask

- **Templates**
  - `GET /api/v1/templates` - List templates (public)
  - `POST /api/v1/templates` - Save template
  - `DELETE /api/v1/templates/{id}` - Delete template

- **Dashboard**
  - `GET /api/v1/dashboard/stats` - Dashboard statistics

- **Files**
  - `POST /api/v1/upload` - Upload file
  - `DELETE /api/v1/attachments/{id}` - Delete attachment

- **Webhooks**
  - `POST /api/v1/webhook/notify` - Trigger webhook

- **MCP**
  - `GET /api/v1/mcp/my-tasks` - Get agent's tasks

- **System**
  - `GET /api/v1/health` - Health check (public)
  - `GET /api/v1/status` - Status check (public)

### Security

- Bearer token authentication (JWT)
- Optional HMAC-SHA256 signature verification (disabled by default)
- Role-based access control (ADMIN, MEMBER, VIEWER)
- Board-level and column-level permissions
