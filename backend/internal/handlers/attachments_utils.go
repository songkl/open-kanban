package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"path/filepath"
	"strings"
)

const (
	MaxFileSize       = 10 * 1024 * 1024 // 10MB
	UploadDir         = "./uploads"
	AllowedImageTypes = "image/jpeg,image/png,image/gif,image/webp"
	AllowedDocTypes   = "application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/plain"
)

func isAllowedFileType(mimeType string) bool {
	allowedTypes := AllowedImageTypes + "," + AllowedDocTypes
	for _, t := range strings.Split(allowedTypes, ",") {
		if strings.TrimSpace(t) == mimeType {
			return true
		}
	}
	return false
}

func generateFileID() string {
	bytes := make([]byte, 16)
	rand.Read(bytes)
	return "att_" + hex.EncodeToString(bytes)
}

func sanitizeFilename(filename string) string {
	filename = filepath.Base(filename)
	filename = strings.ReplaceAll(filename, string(filepath.Separator), "")
	filename = strings.ReplaceAll(filename, "/", "")
	filename = strings.ReplaceAll(filename, "\\", "")
	filename = strings.ReplaceAll(filename, "..", "")
	if filename == "" || filename == "." {
		filename = "unnamed"
	}
	return filename
}
