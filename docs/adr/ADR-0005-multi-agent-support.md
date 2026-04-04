# ADR-0005: Multi-Agent Support Architecture

## Status

Accepted

## Context

Open-Kanban supports AI agents that can autonomously work on tasks. This required:
- Task assignment to specific agents
- Agent identification via tokens
- Column-based agent routing
- Agent-specific task queries

## Decision

We implemented a **column-based agent assignment system** with:

### Agent Types
- Agents are identified by a `user_agent` token field
- Each agent has a unique agent type identifier

### Column Routing
- Columns can have `agent_types` configuration
- Tasks in a column are routed to configured agent types
- Agents query tasks based on their agent type

### Task Assignment
```go
type CreateTaskRequest struct {
    AgentID     *string `json:"agentId"`
    AgentPrompt *string `json:"agentPrompt"`
}
```

### Agent Task Query
```
GET /api/v1/mcp/my-tasks
```
Returns tasks where:
- Task's column has matching agent type, OR
- Task assignee matches agent identifier

## Implementation Details

**Agent Token:**
```sql
SELECT user_agent FROM tokens WHERE `key` = ?
```

**Task Filtering:**
```sql
SELECT * FROM tasks t
JOIN columns c ON t.column_id = c.id
LEFT JOIN column_agents ca ON c.id = ca.column_id
WHERE t.published = true
  AND (t.assignee = ? OR ca.agent_types LIKE ?)
```

## Consequences

### Positive
- Agents can work independently on assigned tasks
- Multiple agents can coexist without conflicts
- Column-based routing provides organizational flexibility
- Agent-specific prompts for context

### Negative
- Token-based agent identification has security implications
- No built-in agent coordination
- Limited visibility into agent decision-making

## References

- [Kanban My Tasks API](#)
- [Column Agent Configuration](#)
