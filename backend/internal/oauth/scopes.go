package oauth

import (
	"strings"
)

// Standard scope identifiers. The scope string is space-separated as required
// by RFC 6749 §3.3. We always normalise to a sorted, de-duplicated set.
const (
	ScopeKanbanRead    = "kanban:read"
	ScopeTasksWrite    = "tasks:write"
	ScopeCommentsWrite = "comments:write"
	ScopeBoardsAdmin   = "boards:admin"
	ScopeAgentsManage  = "agents:manage"
	ScopeKanbanAll     = "kanban:*"
)

// SupportedScopes returns the canonical list of scopes this AS advertises.
func SupportedScopes() []string {
	return []string{
		ScopeKanbanRead,
		ScopeTasksWrite,
		ScopeCommentsWrite,
		ScopeBoardsAdmin,
		ScopeAgentsManage,
	}
}

// ScopeSet is an immutable ordered set of scope strings.
type ScopeSet struct {
	tokens []string
}

// ParseScopes parses a space-separated scope string into a ScopeSet.
func ParseScopes(raw string) ScopeSet {
	if raw == "" {
		return ScopeSet{}
	}
	seen := map[string]struct{}{}
	out := make([]string, 0, 8)
	for _, tok := range strings.Fields(raw) {
		if _, ok := seen[tok]; ok {
			continue
		}
		seen[tok] = struct{}{}
		out = append(out, tok)
	}
	return ScopeSet{tokens: out}
}

// Has returns true if the ScopeSet contains the given token.
func (s ScopeSet) Has(token string) bool {
	for _, t := range s.tokens {
		if t == token {
			return true
		}
	}
	return false
}

// HasAll returns true when every required token is present.
func (s ScopeSet) HasAll(required []string) bool {
	for _, r := range required {
		if !s.Has(r) {
			return false
		}
	}
	return true
}

// HasAny returns true when at least one of the required tokens is present.
func (s ScopeSet) HasAny(required []string) bool {
	if len(required) == 0 {
		return true
	}
	for _, r := range required {
		if s.Has(r) {
			return true
		}
	}
	return false
}

// String returns the canonical space-separated representation.
func (s ScopeSet) String() string {
	return strings.Join(s.tokens, " ")
}

// Tokens returns a copy of the underlying slice.
func (s ScopeSet) Tokens() []string {
	out := make([]string, len(s.tokens))
	copy(out, s.tokens)
	return out
}

// IsSubsetOf returns true when every token in s is contained in other.
func (s ScopeSet) IsSubsetOf(other ScopeSet) bool {
	for _, t := range s.tokens {
		if !other.Has(t) {
			return false
		}
	}
	return true
}

// Union returns a ScopeSet containing tokens from both s and other.
func (s ScopeSet) Union(other ScopeSet) ScopeSet {
	return ParseScopes(s.String() + " " + other.String())
}

// Intersect returns the common tokens.
func (s ScopeSet) Intersect(other ScopeSet) ScopeSet {
	common := make([]string, 0, len(s.tokens))
	for _, t := range s.tokens {
		if other.Has(t) {
			common = append(common, t)
		}
	}
	return ScopeSet{tokens: common}
}

// IsScopeAllowed validates that every requested scope is in the allowed list.
// Unknown scopes are rejected.
func IsScopeAllowed(requested, allowed []string) bool {
	allowedSet := make(map[string]struct{}, len(allowed))
	for _, a := range allowed {
		allowedSet[a] = struct{}{}
	}
	for _, r := range requested {
		if _, ok := allowedSet[r]; !ok {
			return false
		}
	}
	return true
}
