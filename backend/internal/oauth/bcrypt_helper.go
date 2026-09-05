package oauth

import "golang.org/x/crypto/bcrypt"

// bcryptDefaultCost is exposed so tests can reference the constant value
// without importing bcrypt directly.
const bcryptDefaultCost = bcrypt.DefaultCost

// bcryptGenerateFromPassword wraps bcrypt.GenerateFromPassword so callers in
// device.go can hash secrets without importing bcrypt there.
func bcryptGenerateFromPassword(password []byte, cost int) ([]byte, error) {
	return bcrypt.GenerateFromPassword(password, cost)
}
