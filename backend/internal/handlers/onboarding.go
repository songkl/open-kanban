package handlers

import (
	"database/sql"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/gin-gonic/gin"
)

// QuickstartRequest is the body of POST /api/v1/onboarding/quickstart.
// The wizard posts {presetSlug, boardName, installAgent, triggerDemoRun}
// and the handler materialises the full onboarding sequence in a single
// transaction so the new user never lands on a half-built board.
type QuickstartRequest struct {
	// PresetSlug identifies which preset to base the new board on
	// (e.g. "product-iteration"). Required.
	PresetSlug string `json:"presetSlug"`
	// BoardName overrides the auto-generated board name. Empty string
	// means "use the preset's display name".
	BoardName string `json:"boardName"`
	// InstallAgent controls whether the wizard also creates the
	// preset's sample Agent account and grants it ADMIN on the new
	// board. A nil pointer means "use the default" (true) so the
	// wizard is a one-click experience; explicit false opts out.
	InstallAgent *bool `json:"installAgent"`
	// TriggerDemoRun controls whether the wizard creates a single
	// representative task in the new board's first column. Same
	// nil-vs-false semantics as InstallAgent.
	TriggerDemoRun *bool `json:"triggerDemoRun"`
}

// installAgentDefault returns the resolved default for InstallAgent.
// nil → true (wizard default), explicit false → false.
func (r QuickstartRequest) installAgentDefault() bool {
	if r.InstallAgent == nil {
		return true
	}
	return *r.InstallAgent
}

// triggerDemoDefault returns the resolved default for TriggerDemoRun.
// nil → true (wizard default), explicit false → false.
func (r QuickstartRequest) triggerDemoDefault() bool {
	if r.TriggerDemoRun == nil {
		return true
	}
	return *r.TriggerDemoRun
}

// QuickstartResult is what the wizard renders after the request
// succeeds. boardId is the freshly-created board so the wizard can
// navigate the user straight to it without another round-trip.
// agentToken is returned ONLY when InstallAgent was true; it's the
// fresh agent's API key, surfaced so the wizard can show "you can
// give this token to your runner" copy.
type QuickstartResult struct {
	BoardID    string `json:"boardId"`
	BoardName  string `json:"boardName"`
	AgentID    string `json:"agentId,omitempty"`
	AgentToken string `json:"agentToken,omitempty"`
	DemoTaskID string `json:"demoTaskId,omitempty"`
}

// QuickstartOnboarding is the all-in-one onboarding endpoint
// (PM_REVIEW_2026-09-17 §5.4 ROI #4). It performs the three steps
// the wizard UX is built around — pick preset → create board → install
// Agent → trigger demo run — atomically so a network hiccup never
// leaves the new user staring at a half-populated board.
//
// Auth: Requires the caller to be logged in (the first login after
// setup completes is the primary caller). The handler itself runs the
// underlying handlers' logic inline (rather than calling
// CreateBoardFromTemplate / CreateAgent / CreateTask across HTTP) so
// the entire flow fits inside one transaction.
//
// Marketplace gate: if the admin disabled the marketplace we still
// honour Quickstart as long as the requested preset exists — disabling
// the marketplace hides the *browse* surface, not the wizard itself.
// Otherwise a disable would brick the wizard right when new users need
// it most.
func QuickstartOnboarding(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		user := getCurrentUser(c, db)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		var req QuickstartRequest
		if err := c.ShouldBindJSON(&req); err != nil {
			c.JSON(http.StatusBadRequest, gin.H{"error": "Invalid request parameters"})
			return
		}

		// PresetSlug is required. We deliberately do NOT validate the
		// marketplace-enabled toggle here — Quickstart is the wizard's
		// escape hatch and must work even on hosts that hid the
		// marketplace browse page.
		presetSlug := strings.TrimSpace(req.PresetSlug)
		if presetSlug == "" {
			c.JSON(http.StatusBadRequest, gin.H{"error": "presetSlug is required"})
			return
		}

		// Load the preset row. A disabled preset (enabled=0) is still
		// usable from the wizard: the row only goes away when an admin
		// DELETE's it. This matches the "wizard works even on locked-
		// down hosts" contract.
		var (
			presetName    string
			columnsConfig string
			sampleTasks   string
			sampleAgent   string
		)
		err := db.QueryRow(`
			SELECT name, columns_config, sample_tasks, sample_agent
			FROM preset_templates
			WHERE slug = ?
		`, presetSlug).Scan(&presetName, &columnsConfig, &sampleTasks, &sampleAgent)
		if err != nil {
			if err == sql.ErrNoRows {
				c.JSON(http.StatusNotFound, gin.H{"error": "Preset not found"})
				return
			}
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load preset"})
			return
		}

		boardName := strings.TrimSpace(req.BoardName)
		if boardName == "" {
			boardName = presetName
		}

		// Defaults: wizard is one-click, so the install-agent and
		// trigger-demo-run toggles default to true unless the user
		// explicitly opted out (set the field to false in the JSON).
		installAgent := req.installAgentDefault()
		triggerDemo := req.triggerDemoDefault()

		tx, err := db.Begin()
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to start onboarding"})
			return
		}
		defer tx.Rollback()

		now := time.Now()

		boardID := generateID()
		if _, err := tx.Exec(
			"INSERT INTO boards (id, name, deleted, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
			boardID, boardName, false, now, now,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create board"})
			return
		}

		if _, err := tx.Exec(
			"INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes) VALUES (?, ?, ?, ?, 'ADMIN', ?, NULL, NULL, NULL, '')",
			generateID(), user.ID, boardID, user.ID, user.ID,
		); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to grant creator ownership"})
			return
		}

		columns, err := decodeColumnsConfig(columnsConfig)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Preset columns_config is malformed"})
			return
		}

		// Materialise the preset's columns. We materialise them in the
		// order the preset declared so the wizard's drag-and-drop works
		// the same way it would on any user-created board.
		colIDs := make([]string, 0, len(columns))
		for _, col := range columns {
			colID := generateID()
			colIDs = append(colIDs, colID)
			if _, err := tx.Exec(
				"INSERT INTO columns (id, name, status, position, color, board_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
				colID, col.Name, col.Status, col.Position, col.Color, boardID, now, now,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create column"})
				return
			}
		}

		result := QuickstartResult{
			BoardID:   boardID,
			BoardName: boardName,
		}

		// Step 3 of the wizard: install the preset's sample Agent.
		// The preset stores the agent nickname only; the wizard is
		// responsible for handing out the fresh token. We deliberately
		// do NOT touch existing agents — if the nickname is taken we
		// append a numeric suffix rather than overwriting the user.
		if installAgent && sampleAgent != "" {
			agentNick := sampleAgent
			if nicknameTaken(tx, agentNick) {
				agentNick = uniqueAgentNickname(tx, sampleAgent)
			}

			agentID := generateID()
			if _, err := tx.Exec(
				"INSERT INTO users (id, username, nickname, avatar, type, role, enabled, created_at, updated_at, last_active_at) VALUES (?, ?, ?, ?, 'AGENT', 'ADMIN', 1, ?, ?, ?)",
				agentID, agentNick, agentNick, "", now, now, now,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create sample agent"})
				return
			}

			tokenKey := generateTokenKey()
			if _, err := tx.Exec(
				"INSERT INTO tokens (id, name, `key`, user_id, created_at, updated_at) VALUES (?, 'default', ?, ?, ?, ?)",
				generateID(), tokenKey, agentID, now, now,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create agent token"})
				return
			}

			if _, err := tx.Exec(
				"INSERT INTO board_permissions (id, user_id, board_id, owner_agent_id, access, granted_by_user_id, expires_at, revoked_at, revoked_by_user_id, notes) VALUES (?, ?, ?, ?, 'ADMIN', ?, NULL, NULL, NULL, '')",
				generateID(), agentID, boardID, user.ID, user.ID,
			); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to grant sample agent board access"})
				return
			}

			result.AgentID = agentID
			result.AgentToken = tokenKey
		}

		// Step 4 of the wizard: drop a single representative task into
		// the freshly-created board's first column. The wizard promises
		// "drag this card to ship it" copy; we honour that by ALWAYS
		// landing the card in column 0 (the leftmost / backlog).
		if triggerDemo {
			tasks, err := decodeSampleTasks(sampleTasks)
			if err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Preset sample_tasks is malformed"})
				return
			}
			if len(tasks) > 0 && len(colIDs) > 0 {
				task := tasks[0]
				columnIdx := task.ColumnIndex
				if columnIdx < 0 || columnIdx >= len(colIDs) {
					columnIdx = 0
				}
				priority := task.Priority
				if priority == "" {
					priority = "medium"
				}
				taskID := generateID()
				if _, err := tx.Exec(
					"INSERT INTO tasks (id, title, description, priority, column_id, position, published, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?, ?, ?)",
					taskID, task.Title, task.Description, priority, colIDs[columnIdx], user.ID, now, now,
				); err != nil {
					c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to create demo task"})
					return
				}
				result.DemoTaskID = taskID
			}
		}

		if err := tx.Commit(); err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to commit onboarding"})
			return
		}

		LogActivity(db, user.ID, "BOARD_CREATE", "BOARD", boardID, boardName, "", c.ClientIP(), getRequestSource(c))

		c.JSON(http.StatusOK, result)
	}
}

// nicknameTaken is true when a user with the given nickname already
// exists. Used to avoid clobbering an existing Agent the admin may
// have hand-configured.
func nicknameTaken(tx *sql.Tx, nickname string) bool {
	var exists int
	if err := tx.QueryRow("SELECT COUNT(*) FROM users WHERE nickname = ?", nickname).Scan(&exists); err != nil {
		return false
	}
	return exists > 0
}

// uniqueAgentNickname returns "<base> <n>" where n is the smallest
// positive integer that doesn't collide with an existing nickname.
// We use a short loop rather than an unbounded CTE because the only
// realistic caller is the onboarding wizard, which runs at most once
// per user.
func uniqueAgentNickname(tx *sql.Tx, base string) string {
	for i := 1; i < 1000; i++ {
		candidate := strings.TrimSpace(base) + " " + strconv.Itoa(i)
		if !nicknameTaken(tx, candidate) {
			return candidate
		}
	}
	// Fall back to a random suffix so we never infinite-loop even on a
	// pathological DB.
	return strings.TrimSpace(base) + " " + generateID()[:4]
}