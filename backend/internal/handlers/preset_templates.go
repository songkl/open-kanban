package handlers

import (
	"database/sql"
	"encoding/json"
	"net/http"

	"github.com/gin-gonic/gin"
)

// PresetTemplate is the wire shape returned by GET /api/v1/preset-templates.
// The marketplace UI consumes the slug as a stable identifier and the
// columns_config as a JSON-encoded []ColumnConfig (the same shape the
// existing user-template handler uses), so the create-from-preset path
// can reuse CreateBoardFromTemplate without a parallel parser.
//
// sample_tasks and sample_agent are surfaced verbatim — the onboarding
// wizard is the primary consumer and it knows how to translate the
// columnIndex / priority fields into task rows.
type PresetTemplate struct {
	ID            string `json:"id"`
	Slug          string `json:"slug"`
	Name          string `json:"name"`
	Description   string `json:"description"`
	Category      string `json:"category"`
	ColumnsConfig string `json:"columnsConfig"`
	SampleTasks   string `json:"sampleTasks"`
	SampleAgent   string `json:"sampleAgent"`
	Position      int    `json:"position"`
}

// isMarketplaceEnabled reads the app_config row written by the admin
// "marketplace enabled" toggle. We treat a missing row as "enabled" so
// a fresh install (where no admin has touched the toggle yet) still
// gets a marketplace by default — matching the PM_REVIEW §6 expectation
// that the marketplace is the default onboarding surface.
func isMarketplaceEnabled(db *sql.DB) bool {
	var value string
	err := db.QueryRow("SELECT value FROM app_config WHERE `key` = 'marketplaceEnabled'").Scan(&value)
	if err != nil {
		return true
	}
	return value != "0"
}

// GetPresetTemplates returns the curated marketplace. Self-hosted admins
// can disable the marketplace by inserting a row
//   app_config('marketplaceEnabled', '0')
// which causes this handler to respond with 404 (the SPA then hides
// every "Templates" entry point). A 404 rather than an empty list is
// deliberate: a deliberately-disabled surface should look "gone", not
// "broken".
//
// Auth: the route is registered without RequireAuth so unauthenticated
// visitors can still browse the marketplace from the landing page,
// but we still go through the database and apply the enabled toggle
// so disabled hosts don't leak the catalog.
func GetPresetTemplates(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		if !isMarketplaceEnabled(db) {
			c.JSON(http.StatusNotFound, gin.H{"error": "Template marketplace is disabled"})
			return
		}

		rows, err := db.Query(`
			SELECT id, slug, name, description, category, columns_config, sample_tasks, sample_agent, position
			FROM preset_templates
			WHERE enabled = 1
			ORDER BY position ASC, name ASC
		`)
		if err != nil {
			c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to load preset templates"})
			return
		}
		defer rows.Close()

		presets := make([]PresetTemplate, 0, 4)
		for rows.Next() {
			var p PresetTemplate
			if err := rows.Scan(&p.ID, &p.Slug, &p.Name, &p.Description, &p.Category, &p.ColumnsConfig, &p.SampleTasks, &p.SampleAgent, &p.Position); err != nil {
				c.JSON(http.StatusInternalServerError, gin.H{"error": "Failed to scan preset template"})
				return
			}
			presets = append(presets, p)
		}

		c.JSON(http.StatusOK, presets)
	}
}

// decodeColumnsConfig parses the JSON columns_config of a preset
// template and returns the slice of ColumnConfig the existing
// create-board-from-template handler consumes. Centralised so the
// onboarding wizard and any future "create board from preset"
// endpoints share the same parser.
func decodeColumnsConfig(raw string) ([]ColumnConfig, error) {
	if raw == "" {
		return nil, nil
	}
	var cols []ColumnConfig
	if err := json.Unmarshal([]byte(raw), &cols); err != nil {
		return nil, err
	}
	return cols, nil
}

// decodeSampleTasks parses the JSON sample_tasks of a preset template
// into a slice of PresetSampleTask for the wizard. The shape is
// intentionally minimal — only fields the wizard needs to drop a
// representative card into the freshly-created board.
type PresetSampleTask struct {
	Title       string `json:"title"`
	ColumnIndex int    `json:"columnIndex"`
	Description string `json:"description"`
	Priority    string `json:"priority"`
}

func decodeSampleTasks(raw string) ([]PresetSampleTask, error) {
	if raw == "" {
		return nil, nil
	}
	var tasks []PresetSampleTask
	if err := json.Unmarshal([]byte(raw), &tasks); err != nil {
		return nil, err
	}
	return tasks, nil
}