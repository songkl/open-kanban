package handlers

import (
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"net/http"
	"strings"
	"time"

	"open-kanban/internal/models"

	"github.com/gin-gonic/gin"
)

// viewerTokenPrefix is prepended to every minted plaintext so a
// reader can immediately tell a share link from a regular auth
// token. Avoid using this string as a secret — it is intentionally
// not secret (the secret is the 32-byte random suffix that follows).
const viewerTokenPrefix = "vwt_"

// hashViewerToken returns the SHA-256 hex digest used as the
// lookup key in viewer_tokens.token_hash. Stored hashed so a
// database leak cannot be turned into working share links.
func hashViewerToken(plaintext string) string {
	sum := sha256.Sum256([]byte(plaintext))
	return hex.EncodeToString(sum[:])
}

// MintViewerTokenRequest is the POST body for minting a new viewer
// token. ExpiresAt is optional — omit / set null for a token that
// never expires (revoked manually instead). Label is optional too,
// the board owner can recognise the token in Settings.
type MintViewerTokenRequest struct {
	Label     string     `json:"label"`
	ExpiresAt *time.Time `json:"expiresAt,omitempty"`
}

// MintViewerToken creates a new public read-only share token for a
// board. The plaintext is returned exactly once in the response
// (same model as /api/v1/auth/token).
//
// Authorization: requires the caller to be a global ADMIN or the
// recorded owner of the board. A user who has been granted
// per-board READ / WRITE / ADMIN access (without owning it) cannot
// mint a share link — share-link management is treated as a
// meta-capability, the same way SetPermission / DeletePermission
// reserve it to owners + global admins.
func MintViewerToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !canManageBoardPermissions(db, user, boardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can mint viewer tokens"})
			return
		}

		var exists int
		err := db.QueryRow("SELECT COUNT(*) FROM boards WHERE id = ? AND deleted = false", boardID).Scan(&exists)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to check board"})
			return
		}
		if exists == 0 {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}

		var req MintViewerTokenRequest
		// Body is optional — a no-body POST still produces a usable
		// token. Decode only if the request actually has a body so
		// callers using `curl -X POST` without `-d` do not 400.
		if c.Request.ContentLength > 0 {
			if err := c.ShouldBindJSON(&req); err != nil {
				c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request body"})
				return
			}
		}
		if len(req.Label) > 200 {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Label is too long"})
			return
		}
		if req.ExpiresAt != nil && req.ExpiresAt.Before(time.Now()) {
			c.JSON(http.StatusBadRequest, gin.H{"error": "expiresAt must be in the future"})
			return
		}

		plaintext := viewerTokenPrefix + generateTokenKey()
		tokenHash := hashViewerToken(plaintext)
		id := generateID()

		var expiresArg interface{}
		if req.ExpiresAt != nil {
			expiresArg = req.ExpiresAt.UTC()
		} else {
			expiresArg = nil
		}

		_, err = db.Exec(`
			INSERT INTO viewer_tokens (id, board_id, token_hash, label, created_by, expires_at, created_at)
			VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
		`, id, boardID, tokenHash, req.Label, user.ID, expiresArg)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create viewer token"})
			return
		}

		c.JSON(http.StatusOK, gin.H{
			"id":       id,
			"boardId":  boardID,
			"label":    req.Label,
			"token":    plaintext,
			"expiresAt": req.ExpiresAt,
			"createdAt": time.Now().UTC(),
		})
	}
}

// ListViewerTokens returns every non-revoked viewer token for a
// board. Plaintext values are never returned — the owner can only
// see the metadata + revoke by id. Authorization mirrors
// MintViewerToken: global ADMIN or recorded board owner only.
func ListViewerTokens(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		boardID := c.Param("id")
		if boardID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Board ID is required"})
			return
		}

		if !canManageBoardPermissions(db, user, boardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can list viewer tokens"})
			return
		}

		rows, err := db.Query(`
			SELECT id, board_id, label, created_by, expires_at, revoked_at, created_at
			FROM viewer_tokens
			WHERE board_id = ? AND revoked_at IS NULL
			ORDER BY created_at DESC
		`, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to list viewer tokens"})
			return
		}
		defer rows.Close()

		tokens := []models.ViewerToken{}
		for rows.Next() {
			var t models.ViewerToken
			var label string
			var createdBy sql.NullString
			var expiresAt, revokedAt sql.NullTime
			if err := rows.Scan(&t.ID, &t.BoardID, &label, &createdBy, &expiresAt, &revokedAt, &t.CreatedAt); err != nil {
				continue
			}
			t.Label = label
			if createdBy.Valid {
				t.CreatedBy = &createdBy.String
			}
			if expiresAt.Valid {
				t.ExpiresAt = &expiresAt.Time
			}
			if revokedAt.Valid {
				t.RevokedAt = &revokedAt.Time
			}
			tokens = append(tokens, t)
		}

		c.JSON(http.StatusOK, gin.H{"tokens": tokens})
	}
}

// RevokeViewerToken soft-deletes a viewer token. After revoke the
// public lookup returns 404 with no leak of whether the token ever
// existed. Authorization: global ADMIN or recorded board owner of
// the token's board.
func RevokeViewerToken(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		tokenID := c.Param("tokenId")
		if tokenID == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Token id is required"})
			return
		}

		var boardID string
		var revokedAt sql.NullTime
		err := db.QueryRow(
			"SELECT board_id, revoked_at FROM viewer_tokens WHERE id = ?", tokenID,
		).Scan(&boardID, &revokedAt)
		if err == sql.ErrNoRows {
			c.JSON(http.StatusNotFound, gin.H{"error": "Viewer token not found"})
			return
		}
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load viewer token"})
			return
		}
		if revokedAt.Valid {
			c.JSON(http.StatusGone, gin.H{"error": "Viewer token already revoked"})
			return
		}

		if !canManageBoardPermissions(db, user, boardID) {
			c.JSON(http.StatusForbidden, gin.H{"error": "Only admin or board owner can revoke viewer tokens"})
			return
		}

		_, err = db.Exec(
			"UPDATE viewer_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = ? AND revoked_at IS NULL",
			tokenID,
		)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to revoke viewer token"})
			return
		}

		c.JSON(http.StatusOK, gin.H{"id": tokenID, "revoked": true})
	}
}

// resolvePublicViewerToken looks up a token by its plaintext, runs
// the same anti-enumeration + liveness checks every endpoint
// should run, and returns the bound board id. The token plaintext
// is matched against the SHA-256 hash so a database leak cannot be
// turned into working share links.
//
// Returns (boardID, true) on success and ("", false) on any kind of
// failure (missing, revoked, expired, malformed). Callers should
// always respond 404 in the false branch — never leak which case
// applied.
func resolvePublicViewerToken(db *sql.DB, plaintext string) (string, bool) {
	plaintext = strings.TrimSpace(plaintext)
	if plaintext == "" {
		return "", false
	}
	tokenHash := hashViewerToken(plaintext)

	var boardID string
	var expiresAt, revokedAt sql.NullTime
	err := db.QueryRow(`
		SELECT board_id, expires_at, revoked_at
		FROM viewer_tokens
		WHERE token_hash = ?
	`, tokenHash).Scan(&boardID, &expiresAt, &revokedAt)
	if err != nil {
		return "", false
	}
	if revokedAt.Valid {
		return "", false
	}
	if expiresAt.Valid && expiresAt.Time.Before(time.Now()) {
		return "", false
	}

	// Best-effort "last used" tracking. Stored in label-prefix
	// would be wrong; for now we skip persistence entirely and
	// rely on the column being absent — adding it would be its own
	// migration. The board lookup below rejects deleted boards so
	// an admin soft-deleting a board immediately kills every share
	// link that pointed at it.

	var exists int
	err = db.QueryRow("SELECT COUNT(*) FROM boards WHERE id = ? AND deleted = false", boardID).Scan(&exists)
	if err != nil || exists == 0 {
		return "", false
	}

	return boardID, true
}

// GetPublicBoard returns a sanitized, read-only snapshot of a board
// for an anonymous token holder. The endpoint is intentionally
// unauthenticated — gating is done by the URL secret alone. Mutation
// endpoints stay protected by RequireAuth so a leaked token cannot
// turn into a write surface.
//
// Sanitization: published=false / archived=true tasks are excluded,
// same as the regular columns endpoint. The response shape mirrors
// the columns endpoint so the frontend can reuse the existing
// read-only renderer (s-1204 §3 — "sanitized, read-only board view").
//
// Query shape note: the columns rows are drained into memory first
// and the rows handle is closed before the per-column task queries
// run. SQLite's database/sql pool serves concurrent statements on
// different connections; holding the columns rows handle open would
// either force the task queries to wait for the same connection
// (single-conn test databases) or, on the standard connection
// pool, push them onto a fresh connection that has not yet loaded
// the in-memory schema. Draining upfront avoids both failure modes
// — same pattern the columns handler uses.
func GetPublicBoard(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		token := c.Param("token")
		boardID, ok := resolvePublicViewerToken(db, token)
		if !ok {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}

		var name, description string
		err := db.QueryRow(`
			SELECT name, COALESCE(description, '') FROM boards WHERE id = ? AND deleted = false
		`, boardID).Scan(&name, &description)
		if err != nil {
			c.JSON(http.StatusNotFound, gin.H{"error": "Board not found"})
			return
		}

		type columnSeed struct {
			ID          string
			Name        string
			Status      string
			Position    int
			Color       string
			Description string
		}
		var seeds []columnSeed

		colRows, err := db.Query(`
			SELECT id, name, COALESCE(status, ''), position, color, COALESCE(description, '')
			FROM columns WHERE board_id = ? ORDER BY position ASC
		`, boardID)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load board"})
			return
		}
		for colRows.Next() {
			var c columnSeed
			if err := colRows.Scan(&c.ID, &c.Name, &c.Status, &c.Position, &c.Color, &c.Description); err != nil {
				continue
			}
			seeds = append(seeds, c)
		}
		colRows.Close()

		columns := []gin.H{}
		for _, c := range seeds {
			taskRows, err := db.Query(`
				SELECT t.id, t.title, COALESCE(t.description, ''), t.priority, t.assignee, t.meta, t.position,
				       t.created_at, t.updated_at,
				       COALESCE(cc.cnt, 0), COALESCE(sc.cnt, 0)
				FROM tasks t
				LEFT JOIN (SELECT task_id, COUNT(*) AS cnt FROM comments GROUP BY task_id) cc ON t.id = cc.task_id
				LEFT JOIN (SELECT task_id, COUNT(*) AS cnt FROM subtasks GROUP BY task_id) sc ON t.id = sc.task_id
				WHERE t.column_id = ? AND t.archived = false AND t.published = true
				ORDER BY t.position ASC, t.created_at ASC
			`, c.ID)
			if err != nil {
				continue
			}

			tasks := []gin.H{}
			for taskRows.Next() {
				var taskID, title, desc, priority string
				var assignee, meta sql.NullString
				var position int
				var createdAt, updatedAt time.Time
				var commentCount, subtaskCount int
				if err := taskRows.Scan(&taskID, &title, &desc, &priority, &assignee, &meta, &position, &createdAt, &updatedAt, &commentCount, &subtaskCount); err != nil {
					continue
				}
				tasks = append(tasks, gin.H{
					"id":          taskID,
					"title":       title,
					"description": desc,
					"priority":    priority,
					"assignee":    assignee.String,
					"meta":        meta.String,
					"position":    position,
					"createdAt":   createdAt,
					"updatedAt":   updatedAt,
					"_count": gin.H{
						"comments": commentCount,
						"subtasks": subtaskCount,
					},
				})
			}
			taskRows.Close()

			var statusPtr *string
			if c.Status != "" {
				statusPtr = &c.Status
			}
			columns = append(columns, gin.H{
				"id":          c.ID,
				"name":        c.Name,
				"status":      statusPtr,
				"position":    c.Position,
				"color":       c.Color,
				"description": c.Description,
				"tasks":       tasks,
			})
		}

		c.JSON(http.StatusOK, gin.H{
			"id":          boardID,
			"name":        name,
			"description": description,
			"readOnly":    true,
			"columns":     columns,
		})
	}
}

// GetPublicBoardEmbedSnippet returns the iframe snippet the board
// owner can paste into a third-party site. The snippet is computed
// server-side so the owner does not have to know which path the
// public board lives at on this deployment — and so a future move
// of the route does not silently break every embed already shipped.
func GetPublicBoardEmbedSnippet(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		token := c.Query("token")
		if token == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "token query parameter is required"})
			return
		}

		var scheme string
		if c.Request.TLS != nil {
			scheme = "https"
		} else if proto := c.GetHeader("X-Forwarded-Proto"); proto != "" {
			scheme = strings.ToLower(proto)
		} else {
			scheme = "http"
		}
		host := c.Request.Host
		if fwdHost := c.GetHeader("X-Forwarded-Host"); fwdHost != "" {
			host = fwdHost
		}
		src := scheme + "://" + host + "/public/b/" + token

		c.JSON(http.StatusOK, gin.H{
			"src":     src,
			"snippet": `<iframe src="` + src + `" width="100%" height="600" frameborder="0" style="border:0" loading="lazy" title="Kanban board"></iframe>`,
			"height":  600,
			"width":   "100%",
		})
	}
}