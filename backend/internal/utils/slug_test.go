package utils_test

import (
	"testing"

	"open-kanban/internal/utils"
)

func TestToPinyinSlug_Basic(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"开发", "kaifa"},
		{"项目", "xiangmu"},
		{"任务", "renwu"},
		{"看板", "kanban"},
		{"测试", "ceshi"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToPinyinSlug(tt.input)
			if result != tt.expected {
				t.Errorf("ToPinyinSlug(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestToPinyinSlug_MixedChineseEnglish(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"开发项目", "kaifaxiangmu"},
		{"ABC", "abc"},
		{"ABC123", "abc123"},
		{"开发ABC", "kaifaabc"},
		{"test项目", "testxiangmu"},
		{"HelloWorld", "helloworld"},
		{"Hello World", "helloworld"},
		{"hello123world", "hello123world"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToPinyinSlug(tt.input)
			if result != tt.expected {
				t.Errorf("ToPinyinSlug(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestToPinyinSlug_Empty(t *testing.T) {
	tests := []struct {
		input string
	}{
		{""},
		{"   "},
		{"   "},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToPinyinSlug(tt.input)
			if result != "" {
				t.Errorf("ToPinyinSlug(%q) = %q, want empty", tt.input, result)
			}
		})
	}
}

func TestToPinyinSlug_SpecialChars(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"hello-world", "helloworld"},
		{"hello--world", "helloworld"},
		{"-hello-", "hello"},
		{"---", ""},
		{"a b c", "abc"},
		{"a.b,c", "abc"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToPinyinSlug(tt.input)
			if result != tt.expected {
				t.Errorf("ToPinyinSlug(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestToPinyinSlug_Numbers(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"123", "123"},
		{"项目123", "xiangmu123"},
		{"123项目", "123xiangmu"},
		{"test123", "test123"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToPinyinSlug(tt.input)
			if result != tt.expected {
				t.Errorf("ToPinyinSlug(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestToBoardAlias_Basic(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"开发", "k"},
		{"项目", "x"},
		{"任务", "r"},
		{"看板", "k"},
		{"测试", "c"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToBoardAlias(tt.input)
			if result != tt.expected {
				t.Errorf("ToBoardAlias(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestToBoardAlias_Empty(t *testing.T) {
	tests := []string{"", "   ", "  "}

	for _, input := range tests {
		t.Run(input, func(t *testing.T) {
			result := utils.ToBoardAlias(input)
			if result != "b" {
				t.Errorf("ToBoardAlias(%q) = %q, want 'b'", input, result)
			}
		})
	}
}

func TestToBoardAlias_Mixed(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"开发项目", "k"},
		{"ABC", "a"},
		{"HelloWorld", "h"},
		{"test项目", "t"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.ToBoardAlias(tt.input)
			if result != tt.expected {
				t.Errorf("ToBoardAlias(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}

func TestSplitOrigins_Basic(t *testing.T) {
	tests := []struct {
		input    string
		expected []string
	}{
		{"http://localhost:3000", []string{"http://localhost:3000"}},
		{"http://localhost:3000,http://localhost:8080", []string{"http://localhost:3000", "http://localhost:8080"}},
		{" http://localhost:3000 ", []string{"http://localhost:3000"}},
		{"", []string{}},
		{"   ", []string{}},
		{"http://a.com, http://b.com, http://c.com", []string{"http://a.com", "http://b.com", "http://c.com"}},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := utils.SplitOrigins(tt.input)
			if len(result) != len(tt.expected) {
				t.Errorf("SplitOrigins(%q) = %v, want %v", tt.input, result, tt.expected)
				return
			}
			for i, v := range result {
				if v != tt.expected[i] {
					t.Errorf("SplitOrigins(%q)[%d] = %q, want %q", tt.input, i, v, tt.expected[i])
				}
			}
		})
	}
}
