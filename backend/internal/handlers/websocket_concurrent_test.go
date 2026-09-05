package handlers_test

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"open-kanban/internal/handlers"

	"github.com/gorilla/websocket"
)

func TestGetClientWriteLockReturnsSameMutexForSameConn(t *testing.T) {
	conn, cleanup := newTestWebSocket(t)
	defer cleanup()

	handlers.AddClientForTest(conn)
	defer handlers.RemoveAllClientsForTest()

	mux1 := handlers.GetClientWriteLockForTest(conn)
	mux2 := handlers.GetClientWriteLockForTest(conn)

	if mux1 == nil || mux2 == nil {
		t.Fatalf("expected non-nil mutex for registered conn, got %v / %v", mux1, mux2)
	}
	if mux1 != mux2 {
		t.Errorf("expected same mutex pointer for same conn, got different pointers")
	}
}

func TestGetClientWriteLockReturnsNilForUnknownConn(t *testing.T) {
	conn, cleanup := newTestWebSocket(t)
	defer cleanup()

	mux := handlers.GetClientWriteLockForTest(conn)
	if mux != nil {
		t.Errorf("expected nil mutex for unregistered conn, got non-nil")
	}
}

func TestGetClientWriteLockReturnsDifferentMutexForDifferentConns(t *testing.T) {
	conn1, cleanup1 := newTestWebSocket(t)
	defer cleanup1()
	conn2, cleanup2 := newTestWebSocket(t)
	defer cleanup2()

	handlers.AddClientForTest(conn1)
	handlers.AddClientForTest(conn2)
	defer handlers.RemoveAllClientsForTest()

	mux1 := handlers.GetClientWriteLockForTest(conn1)
	mux2 := handlers.GetClientWriteLockForTest(conn2)

	if mux1 == nil || mux2 == nil {
		t.Fatalf("expected non-nil mutexes, got %v / %v", mux1, mux2)
	}
	if mux1 == mux2 {
		t.Errorf("expected different mutex pointers for different conns")
	}
}

func TestSafeRemoveClientClearsRegistration(t *testing.T) {
	conn, cleanup := newTestWebSocket(t)
	defer cleanup()

	handlers.AddClientForTest(conn)
	if handlers.GetClientWriteLockForTest(conn) == nil {
		t.Fatalf("setup: expected conn to be registered")
	}

	handlers.SafeRemoveClientForTest(conn)

	if handlers.GetClientWriteLockForTest(conn) != nil {
		t.Errorf("expected conn to be removed from clients map after safeRemoveClient")
	}
}

func TestSafeRemoveClientIsIdempotent(t *testing.T) {
	conn, cleanup := newTestWebSocket(t)
	defer cleanup()

	handlers.AddClientForTest(conn)
	handlers.SafeRemoveClientForTest(conn)
	handlers.SafeRemoveClientForTest(conn)
}

func TestConcurrentWritersDoNotPanic(t *testing.T) {
	serverConnCh := make(chan *websocket.Conn, 1)

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnCh <- c
	}))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	clientConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("client dial failed: %v", err)
	}
	defer clientConn.Close()

	serverConn := <-serverConnCh
	defer serverConn.Close()

	handlers.AddClientForTest(clientConn)
	defer handlers.RemoveAllClientsForTest()

	mux := handlers.GetClientWriteLockForTest(clientConn)
	if mux == nil {
		t.Fatalf("expected client conn to be registered with a write mutex")
	}

	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		mux.Lock()
		_ = clientConn.WriteMessage(websocket.PingMessage, nil)
		mux.Unlock()
	}()

	go func() {
		defer wg.Done()
		mu := handlers.GetClientWriteLockForTest(clientConn)
		mu.Lock()
		_ = clientConn.WriteMessage(websocket.TextMessage, []byte(`{"type":"heartbeat_ack"}`))
		mu.Unlock()
	}()

	doneCh := make(chan struct{})
	go func() {
		wg.Wait()
		close(doneCh)
	}()

	select {
	case <-doneCh:
	case <-time.After(5 * time.Second):
		t.Fatalf("concurrent writes did not complete in time")
	}
}

func newTestWebSocket(t *testing.T) (*websocket.Conn, func()) {
	t.Helper()

	serverConnCh := make(chan *websocket.Conn, 1)

	upgrader := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		serverConnCh <- c
	}))

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	clientConn, _, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		server.Close()
		t.Fatalf("client dial failed: %v", err)
	}

	serverConn := <-serverConnCh

	cleanup := func() {
		clientConn.Close()
		serverConn.Close()
		server.Close()
	}

	return clientConn, cleanup
}
