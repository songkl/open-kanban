package i18n

import (
	"fmt"
	"os"
	"sync"
)

type MessageKey string

const (
	KeyFieldTitle       MessageKey = "field.title"
	KeyFieldDescription MessageKey = "field.description"
	KeyFieldPriority    MessageKey = "field.priority"
	KeyFieldAssignee    MessageKey = "field.assignee"
	KeyFieldMeta        MessageKey = "field.meta"
	KeyFieldStatus      MessageKey = "field.status"
	KeyFieldPosition    MessageKey = "field.position"
	KeyFieldPublished   MessageKey = "field.published"
	KeyFieldAgent       MessageKey = "field.agent"
	KeyFieldAgentPrompt MessageKey = "field.agent_prompt"
)

const (
	ChangeFormatSingle  = "%s: '%s' → '%s'"
	ChangeFormatNumber  = "%s: %d → %d"
	ChangeFormatBoolean = "%s: %s → %s"
)

var (
	defaultLocale = "en"
	translations  = map[string]map[MessageKey]string{
		"en": {
			KeyFieldTitle:       "Title",
			KeyFieldDescription: "Description",
			KeyFieldPriority:    "Priority",
			KeyFieldAssignee:    "Assignee",
			KeyFieldMeta:        "Metadata",
			KeyFieldStatus:      "Status",
			KeyFieldPosition:    "Position",
			KeyFieldPublished:   "Published",
			KeyFieldAgent:       "Agent",
			KeyFieldAgentPrompt: "Agent Prompt",
		},
		"zh": {
			KeyFieldTitle:       "标题",
			KeyFieldDescription: "描述",
			KeyFieldPriority:    "优先级",
			KeyFieldAssignee:    "负责人",
			KeyFieldMeta:        "元数据",
			KeyFieldStatus:      "状态",
			KeyFieldPosition:    "位置",
			KeyFieldPublished:   "发布",
			KeyFieldAgent:       "Agent",
			KeyFieldAgentPrompt: "Agent Prompt",
		},
	}
	currentTranslations map[MessageKey]string
	mu                  sync.RWMutex
)

func init() {
	loadTranslations(defaultLocale)
}

func SetLocale(locale string) {
	mu.Lock()
	defer mu.Unlock()
	loadTranslations(locale)
}

func loadTranslations(locale string) {
	if t, ok := translations[locale]; ok {
		defaultLocale = locale
		currentTranslations = t
	} else {
		currentTranslations = translations["en"]
	}
}

func T(key MessageKey) string {
	mu.RLock()
	defer mu.RUnlock()
	if t, ok := currentTranslations[key]; ok {
		return t
	}
	return string(key)
}

func TDefault(key MessageKey, defaultMsg string) string {
	mu.RLock()
	defer mu.RUnlock()
	if t, ok := currentTranslations[key]; ok {
		return t
	}
	return defaultMsg
}

func GetLocale() string {
	mu.RLock()
	defer mu.RUnlock()
	return defaultLocale
}

func RegisterTranslation(locale string, key MessageKey, translation string) {
	mu.Lock()
	defer mu.Unlock()
	if _, ok := translations[locale]; !ok {
		translations[locale] = make(map[MessageKey]string)
	}
	translations[locale][key] = translation
	if defaultLocale == locale {
		currentTranslations[key] = translation
	}
}

func FormatChange(key MessageKey, oldVal, newVal interface{}) string {
	fieldName := T(key)
	switch v := oldVal.(type) {
	case int:
		return fmt.Sprintf(ChangeFormatNumber, fieldName, v, newVal)
	case bool:
		oldStr := boolToString(v)
		newStr := boolToString(newVal.(bool))
		return fmt.Sprintf(ChangeFormatBoolean, fieldName, oldStr, newStr)
	default:
		return fmt.Sprintf(ChangeFormatSingle, fieldName, oldVal, newVal)
	}
}

func boolToString(b bool) string {
	locale := GetLocale()
	if locale == "zh" {
		if b {
			return "是"
		}
		return "否"
	}
	if b {
		return "Yes"
	}
	return "No"
}

func InitFromEnv() {
	locale := os.Getenv("APP_LOCALE")
	if locale != "" {
		SetLocale(locale)
	}
}
