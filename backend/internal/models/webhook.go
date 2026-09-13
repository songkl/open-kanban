package models

import "time"

// Webhook represents one row of the `webhooks` table created by
// migration 012 (plan §4 in
// docs/EVENT_CENTER_PLAN_s-1138.md). The config service exposes
// this row to the operator UI; the secret value (column 4) is
// intentionally omitted from the JSON tags so it can never
// accidentally serialise through a debug endpoint. Repositories
// return it as a BLOB; the service redacts it to "********" before
// handing the row back over the wire — see
// services/webhook_config_service.go for the redaction policy.
//
// EventTypes / Filters / Headers are stored as opaque JSON text
// per the schema comment; the model exposes them as strings and
// leaves parsing to the caller (handler / UI) so a future
// catalogue addition doesn't ripple through the storage layer.
type Webhook struct {
	ID            string     `json:"id"`
	Name          string     `json:"name"`
	URL           string     `json:"url"`
	Secret        []byte     `json:"-"`
	Enabled       bool       `json:"enabled"`
	EventTypes    string     `json:"eventTypes"`
	Filters       string     `json:"filters"`
	Headers       string     `json:"headers"`
	TimeoutSec    int        `json:"timeoutSec"`
	MaxRetries    int        `json:"maxRetries"`
	CreatedBy     *string    `json:"createdBy,omitempty"`
	CreatedAt     time.Time  `json:"createdAt"`
	UpdatedAt     time.Time  `json:"updatedAt"`
	LastSuccessAt *time.Time `json:"lastSuccessAt,omitempty"`
	LastFailureAt *time.Time `json:"lastFailureAt,omitempty"`
}
