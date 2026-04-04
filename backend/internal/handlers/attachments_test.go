package handlers

import (
	"testing"
)

func TestIsAllowedFileType(t *testing.T) {
	tests := []struct {
		name     string
		mimeType string
		expected bool
	}{
		{"JPEG image is allowed", "image/jpeg", true},
		{"PNG image is allowed", "image/png", true},
		{"GIF image is allowed", "image/gif", true},
		{"WebP image is allowed", "image/webp", true},
		{"PDF document is allowed", "application/pdf", true},
		{"Word doc is allowed", "application/msword", true},
		{"Excel is allowed", "application/vnd.ms-excel", true},
		{"Text file is allowed", "text/plain", true},
		{"Executable is not allowed", "application/octet-stream", false},
		{"HTML is not allowed", "text/html", false},
		{"JavaScript is not allowed", "application/javascript", false},
		{"Empty string is not allowed", "", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := isAllowedFileType(tt.mimeType)
			if result != tt.expected {
				t.Errorf("isAllowedFileType(%q) = %v, want %v", tt.mimeType, result, tt.expected)
			}
		})
	}
}

func TestGenerateFileID(t *testing.T) {
	t.Run("generateFileID returns expected format", func(t *testing.T) {
		id := generateFileID()
		if len(id) < 10 {
			t.Errorf("expected ID length > 10, got %d", len(id))
		}
		if id[:4] != "att_" {
			t.Errorf("expected ID to start with 'att_', got %s", id[:4])
		}
	})

	t.Run("generateFileID returns unique IDs", func(t *testing.T) {
		ids := make(map[string]bool)
		for i := 0; i < 100; i++ {
			id := generateFileID()
			if ids[id] {
				t.Errorf("duplicate ID generated: %s", id)
			}
			ids[id] = true
		}
	})
}

func TestSanitizeFilename(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected string
	}{
		{"Simple filename", "test.txt", "test.txt"},
		{"Filename with path", "/path/to/test.txt", "test.txt"},
		{"Path traversal attempt", "../../../etc/passwd", "passwd"},
		{"Double dot in name", "file..txt", "filetxt"},
		{"Only dots", "...", "unnamed"},
		{"Empty string", "", "unnamed"},
		{"Just dot", ".", "unnamed"},
		{"Hidden file", ".hidden", ".hidden"},
		{"Filename with spaces", "my file.txt", "my file.txt"},
		{"Multiple slashes", "path///to//file.txt", "file.txt"},
		{"Unix hidden file path", "/path/to/.hidden", ".hidden"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := sanitizeFilename(tt.input)
			if result != tt.expected {
				t.Errorf("sanitizeFilename(%q) = %q, want %q", tt.input, result, tt.expected)
			}
		})
	}
}
