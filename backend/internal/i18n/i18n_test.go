package i18n_test

import (
	"testing"

	"open-kanban/internal/i18n"
)

func TestSetLocale(t *testing.T) {
	tests := []struct {
		name     string
		locale   string
		wantLang string
	}{
		{"Set to Chinese", "zh", "zh"},
		{"Set to English", "en", "en"},
		{"Set to unknown locale defaults to English", "fr", "en"},
		{"Set to empty string defaults to English", "", "en"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			i18n.SetLocale(tt.locale)
			got := i18n.GetLocale()
			if got != tt.wantLang {
				t.Errorf("GetLocale() = %q, want %q", got, tt.wantLang)
			}
		})
	}
}

func TestT(t *testing.T) {
	i18n.SetLocale("en")
	tests := []struct {
		name     string
		key      i18n.MessageKey
		expected string
	}{
		{"Title key", i18n.KeyFieldTitle, "Title"},
		{"Description key", i18n.KeyFieldDescription, "Description"},
		{"Priority key", i18n.KeyFieldPriority, "Priority"},
		{"Assignee key", i18n.KeyFieldAssignee, "Assignee"},
		{"Unknown key returns key string", i18n.MessageKey("unknown.key"), "unknown.key"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := i18n.T(tt.key)
			if got != tt.expected {
				t.Errorf("T() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestT_ChineseLocale(t *testing.T) {
	i18n.SetLocale("zh")
	tests := []struct {
		name     string
		key      i18n.MessageKey
		expected string
	}{
		{"Title key in Chinese", i18n.KeyFieldTitle, "标题"},
		{"Description key in Chinese", i18n.KeyFieldDescription, "描述"},
		{"Priority key in Chinese", i18n.KeyFieldPriority, "优先级"},
		{"Assignee key in Chinese", i18n.KeyFieldAssignee, "负责人"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := i18n.T(tt.key)
			if got != tt.expected {
				t.Errorf("T() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestTDefault(t *testing.T) {
	i18n.SetLocale("en")
	tests := []struct {
		name       string
		key        i18n.MessageKey
		defaultMsg string
		expected   string
	}{
		{"Known key returns translation", i18n.KeyFieldTitle, "Default Title", "Title"},
		{"Unknown key returns default", i18n.MessageKey("unknown.key"), "Default Message", "Default Message"},
		{"Empty default still returns key", i18n.MessageKey("unknown.key"), "", ""},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := i18n.TDefault(tt.key, tt.defaultMsg)
			if got != tt.expected {
				t.Errorf("TDefault() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestGetLocale(t *testing.T) {
	tests := []struct {
		name     string
		locale   string
		expected string
	}{
		{"English locale", "en", "en"},
		{"Chinese locale", "zh", "zh"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			i18n.SetLocale(tt.locale)
			got := i18n.GetLocale()
			if got != tt.expected {
				t.Errorf("GetLocale() = %q, want %q", got, tt.expected)
			}
		})
	}
}

func TestGetLocale_UnknownLocale(t *testing.T) {
	i18n.SetLocale("zh")

	i18n.SetLocale("unknown")

	got := i18n.GetLocale()
	if got != "zh" {
		t.Errorf("GetLocale() = %q, want %q (should keep previous locale on unknown)", got, "zh")
	}
}

func TestRegisterTranslation(t *testing.T) {
	i18n.SetLocale("en")

	newKey := i18n.MessageKey("custom.test")
	customTranslation := "Custom Test Translation"
	i18n.RegisterTranslation("en", newKey, customTranslation)

	got := i18n.T(newKey)
	if got != customTranslation {
		t.Errorf("T() = %q, want %q after RegisterTranslation", got, customTranslation)
	}

	i18n.SetLocale("zh")
	customZhTranslation := "自定义测试翻译"
	i18n.RegisterTranslation("zh", newKey, customZhTranslation)

	got = i18n.T(newKey)
	if got != customZhTranslation {
		t.Errorf("T() in zh = %q, want %q after RegisterTranslation", got, customZhTranslation)
	}
}

func TestRegisterTranslation_NewLocale(t *testing.T) {
	i18n.SetLocale("en")

	newKey := i18n.MessageKey("custom.french")
	frenchTranslation := "Traduction de test"
	i18n.RegisterTranslation("fr", newKey, frenchTranslation)

	i18n.SetLocale("fr")
	got := i18n.T(newKey)
	if got != frenchTranslation {
		t.Errorf("T() in fr = %q, want %q after RegisterTranslation", got, frenchTranslation)
	}
}

func TestFormatChange_String(t *testing.T) {
	i18n.SetLocale("en")

	result := i18n.FormatChange(i18n.KeyFieldTitle, "Old Title", "New Title")
	expected := "Title: 'Old Title' → 'New Title'"
	if result != expected {
		t.Errorf("FormatChange() = %q, want %q", result, expected)
	}
}

func TestFormatChange_Number(t *testing.T) {
	i18n.SetLocale("en")

	result := i18n.FormatChange(i18n.KeyFieldPosition, 1, 5)
	expected := "Position: 1 → 5"
	if result != expected {
		t.Errorf("FormatChange() = %q, want %q", result, expected)
	}
}

func TestFormatChange_Boolean_English(t *testing.T) {
	i18n.SetLocale("en")

	result := i18n.FormatChange(i18n.KeyFieldPublished, false, true)
	expected := "Published: No → Yes"
	if result != expected {
		t.Errorf("FormatChange() = %q, want %q", result, expected)
	}
}

func TestFormatChange_Boolean_Chinese(t *testing.T) {
	i18n.SetLocale("zh")

	result := i18n.FormatChange(i18n.KeyFieldPublished, true, false)
	expected := "发布: 是 → 否"
	if result != expected {
		t.Errorf("FormatChange() = %q, want %q", result, expected)
	}
}

func TestBoolToString_English(t *testing.T) {
	i18n.SetLocale("en")

	if i18n.T(i18n.KeyFieldPublished) != "Published" {
		t.Skip("boolToString is internal, skip direct test")
	}
}

func TestFormatChange_UnknownKey(t *testing.T) {
	i18n.SetLocale("en")

	unknownKey := i18n.MessageKey("unknown.field")
	result := i18n.FormatChange(unknownKey, "old", "new")
	expected := "unknown.field: 'old' → 'new'"
	if result != expected {
		t.Errorf("FormatChange() with unknown key = %q, want %q", result, expected)
	}
}

func TestFormatChange_IntType(t *testing.T) {
	i18n.SetLocale("en")

	result := i18n.FormatChange(i18n.KeyFieldPosition, 0, 100)
	expected := "Position: 0 → 100"
	if result != expected {
		t.Errorf("FormatChange() = %q, want %q", result, expected)
	}
}

func TestRegisterTranslation_UpdatesCurrentWhenSameLocale(t *testing.T) {
	i18n.SetLocale("en")

	original := i18n.T(i18n.KeyFieldTitle)
	newValue := "Custom Title"
	i18n.RegisterTranslation("en", i18n.KeyFieldTitle, newValue)

	got := i18n.T(i18n.KeyFieldTitle)
	if got != newValue {
		t.Errorf("T() = %q, want %q after updating existing key", got, newValue)
	}

	i18n.RegisterTranslation("en", i18n.KeyFieldTitle, original)
}

func TestFormatChange_DifferentTypes(t *testing.T) {
	i18n.SetLocale("en")

	result1 := i18n.FormatChange(i18n.KeyFieldTitle, "value1", "value2")
	if result1 != "Title: 'value1' → 'value2'" {
		t.Errorf("FormatChange string = %q, unexpected result", result1)
	}

	result2 := i18n.FormatChange(i18n.KeyFieldPosition, 1, 2)
	if result2 != "Position: 1 → 2" {
		t.Errorf("FormatChange int = %q, unexpected result", result2)
	}
}
