package database

import (
	"reflect"
	"testing"
)

// TestSupportedDBTypesRegistryPrimitives exercises the register/read
// mechanism without relying on the build-tag-conditional init()s in
// db_mysql.go / db_sqlite.go. The build-specific behavior (i.e. which
// types actually register) is covered by the *_test.go files next to
// each driver.
func TestSupportedDBTypesRegistryPrimitives(t *testing.T) {
	// Snapshot the registry as it was when the test process started so
	// we can restore it and not leak state to other tests in the same
	// package.
	saved := append([]string(nil), supportedDBTypes...)
	t.Cleanup(func() {
		supportedDBTypes = saved
	})

	startLen := len(supportedDBTypes)

	// registerDBType should append and SupportedDBTypes should return a
	// defensive copy (so callers can't mutate the registry).
	registerDBType("test-driver-a")
	registerDBType("test-driver-b")

	got := SupportedDBTypes()
	if len(got) != startLen+2 {
		t.Fatalf("SupportedDBTypes len = %d, want %d (got=%v)", len(got), startLen+2, got)
	}
	if !reflect.DeepEqual(got[startLen:], []string{"test-driver-a", "test-driver-b"}) {
		t.Errorf("newly-registered tail = %v, want [test-driver-a test-driver-b]", got[startLen:])
	}

	// Mutating the returned slice must not affect a subsequent read.
	got[startLen] = "mutated"
	again := SupportedDBTypes()
	if again[startLen] != "test-driver-a" {
		t.Errorf("SupportedDBTypes returned a shared slice; got %v after mutation", again)
	}
}
