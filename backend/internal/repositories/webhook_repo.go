package repositories

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"open-kanban/internal/models"
)

// ErrWebhookNotFound is returned by webhook reads when no row
// matches the supplied id. The config service translates this to
// HTTP 404; tests use errors.Is to assert the cause without
// coupling to the SQLite driver.
var ErrWebhookNotFound = errors.New("webhook not found")

// WebhookRepository owns every SQL statement that touches the
// `webhooks` table (migration 012). The CRUD surface matches the
// admin endpoints the operator UI will mount on
// /api/v1/webhooks (plan §7 in
// docs/EVENT_CENTER_PLAN_s-1138.md):
//
//	Create        → POST   /api/v1/webhooks
//	Get           → GET    /api/v1/webhooks/:id
//	List          → GET    /api/v1/webhooks
//	Update        → PUT    /api/v1/webhooks/:id
//	Delete        → DELETE /api/v1/webhooks/:id
//	RotateSecret  → POST   /api/v1/webhooks/:id/rotate
//
// The repository is intentionally driver-agnostic so the same
// code runs against both sqlite (modernc.org/sqlite for tests,
// mattn/go-sqlite3 in production) and go-sql-driver/mysql. Note
// the secret column is BLOB on both engines — see the per-method
// docs below for the byte-vs-string split the schema requires.
type WebhookRepository struct {
	db *sql.DB
}

// NewWebhookRepository constructs a WebhookRepository bound to
// the supplied database handle. The handle must already have the
// webhooks table from migration 012 applied; otherwise every
// method here will return a SQL "no such table" error.
func NewWebhookRepository(db *sql.DB) *WebhookRepository {
	return &WebhookRepository{db: db}
}

// Create inserts a new webhooks row. The caller is expected to
// populate the Secret field with the plaintext signing key (the
// config service generates it via crypto/rand before calling);
// the BLOB column never leaves the service layer in plaintext
// after this method returns.
//
// The created_at / updated_at columns are stamped from
// time.Now().UTC() so a future timezone-agnostic audit
// consumer doesn't have to normalise on read.
func (r *WebhookRepository) Create(w *models.Webhook) error {
	now := time.Now().UTC()
	w.CreatedAt = now
	w.UpdatedAt = now

	_, err := r.db.Exec(`
		INSERT INTO webhooks (
			id, name, url, secret, enabled,
			event_types, filters, headers,
			timeout_sec, max_retries,
			created_by, created_at, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`,
		w.ID, w.Name, w.URL, w.Secret, boolToInt(w.Enabled),
		nonEmpty(w.EventTypes, "[]"),
		nonEmpty(w.Filters, "{}"),
		nonEmpty(w.Headers, "{}"),
		w.TimeoutSec, w.MaxRetries,
		w.CreatedBy, w.CreatedAt, w.UpdatedAt,
	)
	if err != nil {
		return fmt.Errorf("webhook repo: insert: %w", err)
	}
	return nil
}

// Get returns the webhooks row identified by id, or
// ErrWebhookNotFound when no such row exists. The returned
// Webhook has its Secret field populated from the BLOB column
// — redaction is the config service's responsibility.
func (r *WebhookRepository) Get(id string) (*models.Webhook, error) {
	row := r.db.QueryRow(`
		SELECT id, name, url, secret, enabled,
		       event_types, filters, headers,
		       timeout_sec, max_retries,
		       created_by, created_at, updated_at,
		       last_success_at, last_failure_at
		FROM webhooks WHERE id = ?
	`, id)

	var (
		w             models.Webhook
		createdBy     sql.NullString
		lastSuccessAt sql.NullTime
		lastFailureAt sql.NullTime
		enabledInt    int
	)
	if err := row.Scan(
		&w.ID, &w.Name, &w.URL, &w.Secret, &enabledInt,
		&w.EventTypes, &w.Filters, &w.Headers,
		&w.TimeoutSec, &w.MaxRetries,
		&createdBy, &w.CreatedAt, &w.UpdatedAt,
		&lastSuccessAt, &lastFailureAt,
	); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, ErrWebhookNotFound
		}
		return nil, fmt.Errorf("webhook repo: get: %w", err)
	}

	w.Enabled = enabledInt != 0
	if createdBy.Valid {
		s := createdBy.String
		w.CreatedBy = &s
	}
	if lastSuccessAt.Valid {
		t := lastSuccessAt.Time
		w.LastSuccessAt = &t
	}
	if lastFailureAt.Valid {
		t := lastFailureAt.Time
		w.LastFailureAt = &t
	}
	return &w, nil
}

// List returns every webhooks row ordered by created_at DESC so
// the operator UI shows the most recently created webhook at
// the top. Empty result returns an empty slice (not nil) so the
// config service can hand it straight to the JSON encoder
// without a nil-vs-empty dance.
//
// Like Get, the Secret field is populated from the BLOB column;
// the config service is responsible for redaction.
func (r *WebhookRepository) List() ([]*models.Webhook, error) {
	rows, err := r.db.Query(`
		SELECT id, name, url, secret, enabled,
		       event_types, filters, headers,
		       timeout_sec, max_retries,
		       created_by, created_at, updated_at,
		       last_success_at, last_failure_at
		FROM webhooks
		ORDER BY datetime(created_at) DESC, id ASC
	`)
	if err != nil {
		return nil, fmt.Errorf("webhook repo: list: %w", err)
	}
	defer rows.Close()

	out := []*models.Webhook{}
	for rows.Next() {
		var (
			w             models.Webhook
			createdBy     sql.NullString
			lastSuccessAt sql.NullTime
			lastFailureAt sql.NullTime
			enabledInt    int
		)
		if err := rows.Scan(
			&w.ID, &w.Name, &w.URL, &w.Secret, &enabledInt,
			&w.EventTypes, &w.Filters, &w.Headers,
			&w.TimeoutSec, &w.MaxRetries,
			&createdBy, &w.CreatedAt, &w.UpdatedAt,
			&lastSuccessAt, &lastFailureAt,
		); err != nil {
			return nil, fmt.Errorf("webhook repo: list scan: %w", err)
		}
		w.Enabled = enabledInt != 0
		if createdBy.Valid {
			s := createdBy.String
			w.CreatedBy = &s
		}
		if lastSuccessAt.Valid {
			t := lastSuccessAt.Time
			w.LastSuccessAt = &t
		}
		if lastFailureAt.Valid {
			t := lastFailureAt.Time
			w.LastFailureAt = &t
		}
		out = append(out, &w)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("webhook repo: list iterate: %w", err)
	}
	return out, nil
}

// Update writes the mutable columns of the named webhook. The
// Secret column is intentionally NOT touched here — secret
// rotation goes through RotateSecret so the audit trail
// captures the rotation as a distinct action.
//
// Returns ErrWebhookNotFound when no row matches the supplied
// id so the config service can surface 404 to the operator.
func (r *WebhookRepository) Update(w *models.Webhook) error {
	now := time.Now().UTC()
	res, err := r.db.Exec(`
		UPDATE webhooks
		SET name = ?, url = ?, enabled = ?,
		    event_types = ?, filters = ?, headers = ?,
		    timeout_sec = ?, max_retries = ?,
		    updated_at = ?
		WHERE id = ?
	`,
		w.Name, w.URL, boolToInt(w.Enabled),
		nonEmpty(w.EventTypes, "[]"),
		nonEmpty(w.Filters, "{}"),
		nonEmpty(w.Headers, "{}"),
		w.TimeoutSec, w.MaxRetries,
		now, w.ID,
	)
	if err != nil {
		return fmt.Errorf("webhook repo: update: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("webhook repo: update rows: %w", err)
	}
	if affected == 0 {
		// Could be a no-op update (same values) or a missing
		// row. Distinguish by re-reading so the caller can
		// return 404 vs 200 appropriately.
		var exists int
		if err := r.db.QueryRow("SELECT 1 FROM webhooks WHERE id = ?", w.ID).Scan(&exists); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrWebhookNotFound
			}
			return fmt.Errorf("webhook repo: update probe: %w", err)
		}
	}
	w.UpdatedAt = now
	return nil
}

// Delete removes the webhook row identified by id. Returns
// ErrWebhookNotFound when no row matches so the config service
// can surface 404; the ON DELETE CASCADE on webhook_deliveries
// (migration 012) sweeps historical delivery rows atomically.
func (r *WebhookRepository) Delete(id string) error {
	res, err := r.db.Exec("DELETE FROM webhooks WHERE id = ?", id)
	if err != nil {
		return fmt.Errorf("webhook repo: delete: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("webhook repo: delete rows: %w", err)
	}
	if affected == 0 {
		return ErrWebhookNotFound
	}
	return nil
}

// RotateSecret atomically writes the supplied secret BLOB into
// the webhooks row and stamps updated_at = now. The caller is
// responsible for generating the new secret value with
// crypto/rand before calling; the repository never reads the
// previous secret because the config service returns the
// plaintext exactly once and never holds it afterwards.
//
// Returns ErrWebhookNotFound when no row matches.
func (r *WebhookRepository) RotateSecret(id string, secret []byte) error {
	now := time.Now().UTC()
	res, err := r.db.Exec(`
		UPDATE webhooks
		SET secret = ?, updated_at = ?
		WHERE id = ?
	`, secret, now, id)
	if err != nil {
		return fmt.Errorf("webhook repo: rotate secret: %w", err)
	}
	affected, err := res.RowsAffected()
	if err != nil {
		return fmt.Errorf("webhook repo: rotate secret rows: %w", err)
	}
	if affected == 0 {
		return ErrWebhookNotFound
	}
	return nil
}

// boolToInt mirrors the SQLite INTEGER column convention used by
// the schema: 1 for true, 0 for false. Kept local to this file
// rather than promoted to a shared util because no other model
// in the codebase currently encodes a bool this way (the older
// tables use BOOLEAN columns that the SQLite driver scans
// directly).
func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// nonEmpty returns s when non-empty, otherwise fallback. Used to
// populate the JSON-text columns (event_types / filters /
// headers) with sensible defaults when the operator omits them
// in the create / update request body.
func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
