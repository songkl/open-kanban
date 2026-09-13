package oauth_test

import (
	"errors"
	"testing"

	"open-kanban/internal/oauth"
)

// Tests for the LookupAgent helper added in s-1112.2 to enforce the
// device-flow agent_id contract from plan §4.1.1:
//   - empty / unknown / disabled / non-AGENT ids map to AgentLookupInvalidRequest
//     (handler responds 400 invalid_request);
//   - ADMIN-role Agents reject non-ADMIN callers via AgentLookupForbidden
//     (handler responds 403 forbidden);
//   - empty callerRole skips the role gate entirely (read-only contexts).

func TestLookupAgentRejectsEmptyID(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()

	_, err := oauth.LookupAgent(db, "", "ADMIN")
	var lookupErr *oauth.AgentLookupError
	if !errors.As(err, &lookupErr) {
		t.Fatalf("expected *AgentLookupError, got %T (%v)", err, err)
	}
	if lookupErr.Reason != oauth.AgentLookupInvalidRequest {
		t.Errorf("expected invalid_request, got %q", lookupErr.Reason)
	}
}

func TestLookupAgentRejectsUnknownID(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()

	_, err := oauth.LookupAgent(db, "ghost-agent", "ADMIN")
	var lookupErr *oauth.AgentLookupError
	if !errors.As(err, &lookupErr) {
		t.Fatalf("expected *AgentLookupError, got %T (%v)", err, err)
	}
	if lookupErr.Reason != oauth.AgentLookupInvalidRequest {
		t.Errorf("expected invalid_request, got %q", lookupErr.Reason)
	}
	if lookupErr.AgentID != "ghost-agent" {
		t.Errorf("expected AgentID ghost-agent, got %q", lookupErr.AgentID)
	}
}

func TestLookupAgentRejectsDisabled(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	seedAgentWithRole(t, db, "agent-disabled", "Disabled", "ADMIN", false)

	_, err := oauth.LookupAgent(db, "agent-disabled", "ADMIN")
	var lookupErr *oauth.AgentLookupError
	if !errors.As(err, &lookupErr) {
		t.Fatalf("expected *AgentLookupError, got %T (%v)", err, err)
	}
	if lookupErr.Reason != oauth.AgentLookupInvalidRequest {
		t.Errorf("expected invalid_request, got %q", lookupErr.Reason)
	}
}

func TestLookupAgentRejectsHumanUser(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	seedHumanWithRole(t, db, "user-other", "Other Admin", "ADMIN")

	_, err := oauth.LookupAgent(db, "user-other", "ADMIN")
	var lookupErr *oauth.AgentLookupError
	if !errors.As(err, &lookupErr) {
		t.Fatalf("expected *AgentLookupError, got %T (%v)", err, err)
	}
	if lookupErr.Reason != oauth.AgentLookupInvalidRequest {
		t.Errorf("expected invalid_request, got %q", lookupErr.Reason)
	}
}

func TestLookupAgentAllowsAdminBindingAdminAgent(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	seedAgentWithRole(t, db, "agent-admin", "Admin Agent", "ADMIN", true)

	got, err := oauth.LookupAgent(db, "agent-admin", "ADMIN")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.ID != "agent-admin" || got.Role != "ADMIN" || !got.Enabled {
		t.Errorf("unexpected summary: %+v", got)
	}
}

func TestLookupAgentGatesAdminAgentToAdminCallers(t *testing.T) {
	db := setupAgentApprovalDB(t)
	defer db.Close()
	seedAgentWithRole(t, db, "agent-admin", "Admin Agent", "ADMIN", true)

	for _, role := range []string{"MEMBER", "VIEWER", ""} {
		_, err := oauth.LookupAgent(db, "agent-admin", role)
		if role == "" {
			// Empty callerRole is the read-only / no-permission-context
			// path; it skips the role gate.
			if err != nil {
				t.Errorf("callerRole=%q expected success, got %v", role, err)
			}
			continue
		}
		var lookupErr *oauth.AgentLookupError
		if !errors.As(err, &lookupErr) {
			t.Errorf("callerRole=%q expected *AgentLookupError, got %T (%v)", role, err, err)
			continue
		}
		if lookupErr.Reason != oauth.AgentLookupForbidden {
			t.Errorf("callerRole=%q expected forbidden, got %q", role, lookupErr.Reason)
		}
	}
}

func TestLookupAgentAllowsMemberBindingMemberAgent(t *testing.T) {
	// Phase 1 of plan §4.1.1 only restricts ADMIN-role Agents to ADMIN
	// approvers — a MEMBER-role Agent must remain bindable by any
	// authenticated approver so the existing CLI self-service flow
	// keeps working.
	db := setupAgentApprovalDB(t)
	defer db.Close()
	seedAgentWithRole(t, db, "agent-member", "Member Agent", "MEMBER", true)

	for _, role := range []string{"ADMIN", "MEMBER", "VIEWER"} {
		got, err := oauth.LookupAgent(db, "agent-member", role)
		if err != nil {
			t.Errorf("callerRole=%q expected success, got %v", role, err)
			continue
		}
		if got.Role != "MEMBER" {
			t.Errorf("callerRole=%q expected role MEMBER, got %q", role, got.Role)
		}
	}
}

func TestAgentLookupErrorMessage(t *testing.T) {
	// Surface a friendly, agent_id-aware error string so the
	// OAuth-style error_description field reads naturally to humans.
	cases := []struct {
		name string
		err  *oauth.AgentLookupError
		want string
	}{
		{
			name: "with detail",
			err:  &oauth.AgentLookupError{Reason: oauth.AgentLookupInvalidRequest, AgentID: "x", Detail: "disabled"},
			want: "agent_id x: disabled",
		},
		{
			name: "without detail",
			err:  &oauth.AgentLookupError{Reason: oauth.AgentLookupForbidden, AgentID: "x"},
			want: "agent_id x: forbidden",
		},
		{
			name: "nil receiver",
			err:  nil,
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.err.Error(); got != tc.want {
				t.Errorf("Error() = %q, want %q", got, tc.want)
			}
		})
	}
}
