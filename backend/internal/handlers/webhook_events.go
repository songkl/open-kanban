package handlers

import (
	"database/sql"
	"net/http"
	"sort"

	"github.com/gin-gonic/gin"
)

// EventCatalogueEntry is the public shape of one row in the
// response from GET /api/v1/webhooks/events (plan §8 in
// docs/EVENT_CENTER_PLAN_s-1138.md). The frontend §7.2 event
// picker renders this slice directly, so the field names and
// types are part of the API contract:
//
//   - Event        the dot-namespaced identifier the dispatcher
//                  matches against webhook.eventTypes. Stable
//                  across releases (plan §3 promises a fixed,
//                  versioned catalogue).
//   - DisplayName  Chinese label shown in the operator UI. Kept
//                  in Chinese because the existing kanban UI
//                  ships zh-CN as its primary locale; an i18n
//                  layer can overlay later without renaming
//                  the API field.
//   - Description  one-line trigger description sourced from
//                  the §3 "Triggered when" column.
//   - PayloadSchema simplified JSON Schema subset (type /
//                  required / properties) describing the `data`
//                  object carried under envelope.data. New
//                  fields are additive per the §3 note that
//                  receivers MUST ignore unknown keys.
//   - Filters      which §3.2 filter categories meaningfully
//                  apply to the event. The picker disables
//                  categories that aren't listed here.
type EventCatalogueEntry struct {
	Event        string                 `json:"event"`
	DisplayName  string                 `json:"displayName"`
	Description  string                 `json:"description"`
	PayloadSchema map[string]any        `json:"payloadSchema"`
	Filters      []string               `json:"filters"`
}

// EventFilter constants are the canonical strings returned in
// the Filters slice. They mirror the §3.2 filter keys exactly
// so the picker can look them up without translation.
const (
	EventFilterBoardIDs    = "boardIds"
	EventFilterColumnIDs   = "columnIds"
	EventFilterPriorities  = "priorities"
	EventFilterAssigneeIDs = "assigneeIds"
)

// webhookEventCatalogue is the single source of truth for the
// event picker (plan §3 + §8). It MUST stay in sync with the
// event names dispatched by the call sites listed in the
// Description field; the table-driven test in
// webhook_events_test.go asserts the structure stays stable.
//
// Adding a new event means appending a row here, adding a
// matching trigger call at the production site, and adding a
// matching entry to the table-driven test. No other code
// needs to change — the picker renders from this slice.
var webhookEventCatalogue = []EventCatalogueEntry{
	{
		Event:       "task.created",
		DisplayName: "任务创建",
		Description: "A new task row is inserted.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task"},
			"properties": map[string]any{
				"task": taskPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.updated",
		DisplayName: "任务更新",
		Description: "Title / description / priority / assignee / due date changes.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task", "changes"},
			"properties": map[string]any{
				"task":    taskPayloadSchema(),
				"changes": changesPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.moved",
		DisplayName: "任务移动",
		Description: "A task crosses a column boundary.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task", "fromColumnId", "toColumnId"},
			"properties": map[string]any{
				"task":         taskPayloadSchema(),
				"fromColumnId": stringPayloadSchema(),
				"toColumnId":   stringPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.completed",
		DisplayName: "任务完成",
		Description: "A task is moved into a \"done\" column.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task"},
			"properties": map[string]any{
				"task": taskPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.deleted",
		DisplayName: "任务删除",
		Description: "A task is removed (soft-delete).",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task"},
			"properties": map[string]any{
				"task": taskPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.assigned",
		DisplayName: "任务分配",
		Description: "Assignee changes (including null -> user).",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task", "previousAssignee"},
			"properties": map[string]any{
				"task":             taskPayloadSchema(),
				"previousAssignee": nullableStringPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "task.commented",
		DisplayName: "任务评论",
		Description: "A comment row is inserted on a task.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"task", "comment"},
			"properties": map[string]any{
				"task":    taskPayloadSchema(),
				"comment": commentPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
			EventFilterColumnIDs,
			EventFilterPriorities,
			EventFilterAssigneeIDs,
		},
	},
	{
		Event:       "column.created",
		DisplayName: "列创建",
		Description: "A new column is added to a board.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"column"},
			"properties": map[string]any{
				"column": columnPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
		},
	},
	{
		Event:       "column.updated",
		DisplayName: "列更新",
		Description: "Column metadata changes.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"column", "changes"},
			"properties": map[string]any{
				"column":  columnPayloadSchema(),
				"changes": changesPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
		},
	},
	{
		Event:       "column.deleted",
		DisplayName: "列删除",
		Description: "A column is removed.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"column"},
			"properties": map[string]any{
				"column": columnPayloadSchema(),
			},
		},
		Filters: []string{
			EventFilterBoardIDs,
		},
	},
	{
		Event:       "board.created",
		DisplayName: "看板创建",
		Description: "A new board is created.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"board"},
			"properties": map[string]any{
				"board": boardPayloadSchema(),
			},
		},
		Filters: []string{},
	},
	{
		Event:       "board.updated",
		DisplayName: "看板更新",
		Description: "Board metadata changes.",
		PayloadSchema: map[string]any{
			"type":     "object",
			"required": []string{"board", "changes"},
			"properties": map[string]any{
				"board":   boardPayloadSchema(),
				"changes": changesPayloadSchema(),
			},
		},
		Filters: []string{},
	},
}

// taskPayloadSchema describes the `task` object that sits under
// every task.* event's data property. Kept minimal — receivers
// MUST ignore unknown keys per §3.
func taskPayloadSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "title", "columnId", "priority"},
		"properties": map[string]any{
			"id":          stringPayloadSchema(),
			"title":       stringPayloadSchema(),
			"description": stringPayloadSchema(),
			"columnId":    stringPayloadSchema(),
			"columnName":  stringPayloadSchema(),
			"priority":    stringPayloadSchema(),
			"assignee":    nullableStringPayloadSchema(),
			"createdBy":   nullableStringPayloadSchema(),
			"createdAt":   stringPayloadSchema(),
			"updatedAt":   stringPayloadSchema(),
		},
	}
}

// columnPayloadSchema describes the `column` object for the
// column.* events.
func columnPayloadSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "name", "boardId", "position"},
		"properties": map[string]any{
			"id":       stringPayloadSchema(),
			"name":     stringPayloadSchema(),
			"boardId":  stringPayloadSchema(),
			"position": map[string]any{"type": "integer"},
			"color":    stringPayloadSchema(),
			"status":   nullableStringPayloadSchema(),
		},
	}
}

// boardPayloadSchema describes the `board` object for the
// board.* events.
func boardPayloadSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "name"},
		"properties": map[string]any{
			"id":          stringPayloadSchema(),
			"name":        stringPayloadSchema(),
			"shortAlias":  nullableStringPayloadSchema(),
			"description": stringPayloadSchema(),
			"createdAt":   stringPayloadSchema(),
			"updatedAt":   stringPayloadSchema(),
		},
	}
}

// commentPayloadSchema describes the `comment` object that
// ships with task.commented.
func commentPayloadSchema() map[string]any {
	return map[string]any{
		"type":     "object",
		"required": []string{"id", "content", "taskId", "createdAt"},
		"properties": map[string]any{
			"id":        stringPayloadSchema(),
			"content":   stringPayloadSchema(),
			"author":    nullableStringPayloadSchema(),
			"userId":    nullableStringPayloadSchema(),
			"taskId":    stringPayloadSchema(),
			"createdAt": stringPayloadSchema(),
		},
	}
}

// changesPayloadSchema describes the `changes[]` array carried
// by *.updated events — each element names a field that
// changed plus its previous value. We don't constrain the
// `from` type because it mirrors the field that changed.
func changesPayloadSchema() map[string]any {
	return map[string]any{
		"type":     "array",
		"items": map[string]any{
			"type":     "object",
			"required": []string{"field", "from", "to"},
			"properties": map[string]any{
				"field": stringPayloadSchema(),
				"from":  map[string]any{},
				"to":    map[string]any{},
			},
		},
	}
}

// stringPayloadSchema returns the canonical {"type":"string"}
// schema fragment. Centralised so the catalogue JSON stays
// compact.
func stringPayloadSchema() map[string]any {
	return map[string]any{"type": "string"}
}

// nullableStringPayloadSchema marks a field that may be a
// string or null (e.g. assignee when a task is unassigned).
// Receivers must tolerate JSON null.
func nullableStringPayloadSchema() map[string]any {
	return map[string]any{"type": []string{"string", "null"}}
}

// WebhookEventCatalogue returns the handler for
// GET /api/v1/webhooks/events (plan §8 last row). The endpoint
// is mounted under RequireAuth so any authenticated user can
// fetch the catalogue; the picker renders from the result so
// adding a new event is a backend-only change.
//
// The response shape is the slice of EventCatalogueEntry
// values exactly as defined in webhookEventCatalogue, sorted
// by Event to keep the wire order stable across releases
// (tests rely on this).
func WebhookEventCatalogue(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		// Copy before sorting so we never mutate the package
		// global from a request goroutine.
		entries := make([]EventCatalogueEntry, len(webhookEventCatalogue))
		copy(entries, webhookEventCatalogue)
		sort.Slice(entries, func(i, j int) bool {
			return entries[i].Event < entries[j].Event
		})
		c.JSON(http.StatusOK, gin.H{
			"events": entries,
			"count":  len(entries),
		})
	}
}
