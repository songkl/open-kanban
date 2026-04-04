package handlers

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"sync"

	"open-kanban/internal/database"

	"golang.org/x/crypto/bcrypt"
)

var (
	avatarOptions = []string{
		"😊", "😎", "🙂", "😇", "🤗",
		"😸", "😻", "🌟", "💫", "✨",
		"🦊", "🐱", "🐶", "🐼", "🐨",
		"🦁", "🐯", "🦄", "🐲", "🦋",
		"🍎", "🍊", "🍓", "🥝", "🍇",
		"🌈", "☀️", "🌙", "⭐", "🔥",
	}
	salt     string
	saltOnce sync.Once
)

func getSalt() (string, error) {
	var err error
	saltOnce.Do(func() {
		salt, err = loadOrGenerateSalt()
	})
	return salt, err
}

func loadOrGenerateSalt() (string, error) {
	db, err := database.InitDB()
	if err != nil {
		return "", fmt.Errorf("failed to init database: %w", err)
	}
	defer db.Close()

	var existingSalt string
	err = db.QueryRow("SELECT value FROM app_config WHERE key = 'password_salt'").Scan(&existingSalt)
	if err == nil && len(existingSalt) >= 32 {
		return existingSalt, nil
	}

	saltBytes := make([]byte, 32)
	if _, err := rand.Read(saltBytes); err != nil {
		return "", fmt.Errorf("failed to generate salt: %w", err)
	}
	newSalt := hex.EncodeToString(saltBytes)

	_, err = db.Exec("INSERT OR REPLACE INTO app_config (key, value) VALUES ('password_salt', ?)", newSalt)
	if err != nil {
		return "", fmt.Errorf("failed to save salt: %w", err)
	}

	return newSalt, nil
}

func hashWithSalt(input string) (string, error) {
	salt, err := getSalt()
	if err != nil {
		return "", err
	}
	combined := salt + input
	hash, err := bcrypt.GenerateFromPassword([]byte(combined), bcrypt.DefaultCost)
	if err != nil {
		return "", err
	}
	return string(hash), nil
}

func verifyWithSalt(input, hash string) bool {
	salt, err := getSalt()
	if err != nil {
		return false
	}
	combined := salt + input
	err = bcrypt.CompareHashAndPassword([]byte(hash), []byte(combined))
	return err == nil
}

func HashPasswordWithSalt(password string) (string, error) {
	return hashWithSalt(password)
}
