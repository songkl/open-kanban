package handlers

import (
	"database/sql"
	"log/slog"
	"net"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

	"open-kanban/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

func splitOrigins(origins string) []string {
	var result []string
	for _, o := range strings.Split(origins, ",") {
		o = strings.TrimSpace(o)
		if o != "" {
			result = append(result, o)
		}
	}
	return result
}

func isOriginAllowed(origin string) bool {
	if origin == "" {
		return false
	}
	allowedOrigins := splitOrigins(os.Getenv("ALLOWED_ORIGINS"))
	for _, allowed := range allowedOrigins {
		if origin == allowed {
			return true
		}
	}
	return false
}

func SplitOriginsForTest(origins string) []string {
	return splitOrigins(origins)
}

func IsOriginAllowedForTest(origin string) bool {
	return isOriginAllowed(origin)
}

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			origin := r.Header.Get("Origin")
			if origin == "" {
				return false
			}
			return isOriginAllowed(origin)
		},
	}
	clients          = make(map[*websocket.Conn]bool)
	clientsMux       sync.RWMutex
	userConnCount    = make(map[string]int)
	userConnCountMux sync.Mutex
)

func getConnectionCount() int {
	clientsMux.RLock()
	defer clientsMux.RUnlock()
	return len(clients)
}

func GetConnectionCount() int {
	return getConnectionCount()
}

func GetMaxConnections() int {
	return config.GetConfig().WebSocket.MaxConnections
}

func isConnectionAllowed() bool {
	maxConns := config.GetConfig().WebSocket.MaxConnections
	if maxConns == 0 {
		return true
	}
	clientsMux.RLock()
	allowed := len(clients) < maxConns
	clientsMux.RUnlock()
	return allowed
}

func isUserConnectionAllowed(userID string) bool {
	maxConnsPerUser := config.GetConfig().WebSocket.MaxConnectionsPerUser
	if maxConnsPerUser == 0 {
		return true
	}
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	count := userConnCount[userID]
	return count < maxConnsPerUser
}

func incrementUserConnCount(userID string) {
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	userConnCount[userID]++
}

func decrementUserConnCount(userID string) {
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	userConnCount[userID]--
	if userConnCount[userID] <= 0 {
		delete(userConnCount, userID)
	}
}

// WebSocketHandler handles WebSocket connections
func WebSocketHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		tokenKey := ""

		if authHeader := c.GetHeader("Authorization"); authHeader != "" {
			if strings.HasPrefix(authHeader, "Bearer ") {
				tokenKey = strings.TrimPrefix(authHeader, "Bearer ")
			}
		}

		if tokenKey == "" {
			if cookie, err := c.Cookie("kanban-token"); err == nil && cookie != "" {
				tokenKey = cookie
			}
		}

		if tokenKey == "" {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Not logged in"})
			return
		}

		user := getCurrentUserFromToken(db, tokenKey)
		if user == nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid session"})
			return
		}
		userID := user.ID

		if !isConnectionAllowed() {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Server at capacity"})
			return
		}

		if !isUserConnectionAllowed(userID) {
			c.JSON(http.StatusServiceUnavailable, gin.H{"error": "Too many connections for this user"})
			return
		}

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			slog.Error("WebSocket upgrade failed", "error", err, "request_id", GetRequestID(c), "user_id", userID)
			return
		}

		requestID := GetRequestID(c)

		conn.SetPongHandler(func(appData string) error {
			conn.SetReadDeadline(time.Now().Add(config.GetConfig().WebSocket.ReadDeadline))
			return nil
		})

		clientsMux.Lock()
		clients[conn] = true
		clientsMux.Unlock()
		incrementUserConnCount(userID)
		initBroadcastWorker()

		slog.Info("WebSocket client connected", "request_id", requestID, "user_id", userID, "total_clients", getConnectionCount(), "user_connections", userConnCount[userID])

		var wg sync.WaitGroup
		wg.Add(1)
		done := make(chan struct{})

		go func() {
			defer wg.Done()
			pingTicker := time.NewTicker(config.GetConfig().WebSocket.PingInterval)
			defer pingTicker.Stop()

			for {
				select {
				case <-done:
					return
				case <-pingTicker.C:
					conn.SetWriteDeadline(time.Now().Add(config.GetConfig().WebSocket.PingWriteDeadline))
					if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
						slog.Warn("Failed to send ping to client", "request_id", requestID, "user_id", userID, "error", err)
						return
					}
				}
			}
		}()

		for {
			conn.SetReadDeadline(time.Now().Add(config.GetConfig().WebSocket.ReadDeadline))
			msgType, _, err := conn.ReadMessage()
			if err != nil {
				if closeErr, ok := err.(*websocket.CloseError); ok && closeErr.Code == websocket.CloseProtocolError {
					slog.Warn("WebSocket client sent invalid data", "request_id", requestID, "user_id", userID, "error", err)
				} else if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
					slog.Warn("WebSocket read error", "request_id", requestID, "user_id", userID, "error", err)
				} else if netErr, ok := err.(net.Error); ok && netErr.Timeout() {
					slog.Warn("WebSocket connection timeout", "request_id", requestID, "user_id", userID, "reason", "no activity detected")
				}
				break
			}
			if msgType == websocket.TextMessage {
				conn.SetWriteDeadline(time.Now().Add(config.GetConfig().WebSocket.PingWriteDeadline))
				if err := conn.WriteMessage(websocket.TextMessage, []byte(`{"type":"heartbeat_ack"}`)); err != nil {
					slog.Warn("Failed to send heartbeat_ack to client", "request_id", requestID, "user_id", userID, "error", err)
					break
				}
			}
		}

		close(done)
		wg.Wait()

		safeRemoveClient(conn)
		decrementUserConnCount(userID)

		slog.Info("WebSocket client disconnected", "request_id", requestID, "user_id", userID, "total_clients", getConnectionCount(), "user_connections", userConnCount[userID])
	}
}
