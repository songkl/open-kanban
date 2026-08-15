package oauth_test

import (
	"encoding/json"
	"testing"

	"open-kanban/internal/oauth"
)

func TestParseScopesDedupesAndOrders(t *testing.T) {
	s := oauth.ParseScopes("b a b c a")
	if got := s.String(); got != "b a c" {
		t.Errorf("expected 'b a c', got %q", got)
	}
}

func TestScopeSetHasAndHasAll(t *testing.T) {
	s := oauth.ParseScopes("kanban:read tasks:write")
	if !s.Has("kanban:read") {
		t.Error("expected to find kanban:read")
	}
	if s.Has("tasks:delete") {
		t.Error("did not expect tasks:delete")
	}
	if !s.HasAll([]string{"kanban:read", "tasks:write"}) {
		t.Error("expected HasAll to be true")
	}
	if s.HasAll([]string{"kanban:read", "tasks:delete"}) {
		t.Error("expected HasAll to be false")
	}
}

func TestScopeSetHasAny(t *testing.T) {
	s := oauth.ParseScopes("kanban:read")
	if !s.HasAny([]string{"kanban:read", "x"}) {
		t.Error("expected HasAny to be true")
	}
	if s.HasAny([]string{"y", "z"}) {
		t.Error("expected HasAny to be false")
	}
	if !oauth.ParseScopes("").HasAny(nil) {
		t.Error("empty scope set should satisfy empty requirement")
	}
}

func TestScopeSetUnionAndIntersect(t *testing.T) {
	a := oauth.ParseScopes("a b c")
	b := oauth.ParseScopes("b c d")
	if got := a.Union(b).String(); got != "a b c d" {
		t.Errorf("expected 'a b c d', got %q", got)
	}
	if got := a.Intersect(b).String(); got != "b c" {
		t.Errorf("expected 'b c', got %q", got)
	}
}

func TestScopeSetIsSubsetOf(t *testing.T) {
	a := oauth.ParseScopes("a b")
	b := oauth.ParseScopes("a b c")
	if !a.IsSubsetOf(b) {
		t.Error("a should be subset of b")
	}
	if b.IsSubsetOf(a) {
		t.Error("b should not be subset of a")
	}
}

func TestIsScopeAllowed(t *testing.T) {
	allowed := oauth.SupportedScopes()
	if !oauth.IsScopeAllowed([]string{"kanban:read"}, allowed) {
		t.Error("kanban:read should be allowed")
	}
	if oauth.IsScopeAllowed([]string{"admin:everything"}, allowed) {
		t.Error("admin:everything should not be allowed")
	}
}

func TestSupportedScopesList(t *testing.T) {
	got := oauth.SupportedScopes()
	want := []string{
		oauth.ScopeKanbanRead,
		oauth.ScopeTasksWrite,
		oauth.ScopeCommentsWrite,
		oauth.ScopeBoardsAdmin,
		oauth.ScopeAgentsManage,
	}
	if len(got) != len(want) {
		t.Fatalf("expected %d scopes, got %d", len(want), len(got))
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("scope[%d]: expected %s, got %s", i, want[i], got[i])
		}
	}
}

func TestSupportedScopesJSONShape(t *testing.T) {
	scopes := oauth.SupportedScopes()
	b, err := json.Marshal(scopes)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	// scopes_supported must be a JSON array of strings (RFC 8414)
	var arr []string
	if err := json.Unmarshal(b, &arr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(arr) == 0 {
		t.Fatal("expected non-empty scopes array")
	}
}