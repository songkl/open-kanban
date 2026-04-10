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
	"open-kanban/internal/utils"

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

type connectionCounter interface {
	GetTotalConnections() (int64, error)
	IncrTotal() (int64, error)
	DecrTotal() (int64, error)
	GetUserConnections(userID string) (int64, error)
	IncrUser(userID string) (int64, error)
	DecrUser(userID string) (int64, error)
}

type memoryConnectionCounter struct{}

func (m *memoryConnectionCounter) GetTotalConnections() (int64, error) {
	clientsMux.RLock()
	defer clientsMux.RUnlock()
	return int64(len(clients)), nil
}

func (m *memoryConnectionCounter) IncrTotal() (int64, error) {
	clientsMux.Lock()
	defer clientsMux.Unlock()
	return int64(len(clients) + 1), nil
}

func (m *memoryConnectionCounter) DecrTotal() (int64, error) {
	clientsMux.Lock()
	defer clientsMux.Unlock()
	return int64(len(clients) - 1), nil
}

func (m *memoryConnectionCounter) GetUserConnections(userID string) (int64, error) {
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	return int64(userConnCount[userID]), nil
}

func (m *memoryConnectionCounter) IncrUser(userID string) (int64, error) {
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	userConnCount[userID]++
	return int64(userConnCount[userID]), nil
}

func (m *memoryConnectionCounter) DecrUser(userID string) (int64, error) {
	userConnCountMux.Lock()
	defer userConnCountMux.Unlock()
	userConnCount[userID]--
	if userConnCount[userID] <= 0 {
		delete(userConnCount, userID)
	}
	return int64(userConnCount[userID]), nil
}

type redisConnectionCounter struct {
	counter *utils.RedisConnectionCounter
}

func (r *redisConnectionCounter) GetTotalConnections() (int64, error) {
	return r.counter.GetTotalConnections()
}

func (r *redisConnectionCounter) IncrTotal() (int64, error) {
	return r.counter.IncrTotal()
}

func (r *redisConnectionCounter) DecrTotal() (int64, error) {
	return r.counter.DecrTotal()
}

func (r *redisConnectionCounter) GetUserConnections(userID string) (int64, error) {
	return r.counter.GetUserConnections(userID)
}

func (r *redisConnectionCounter) IncrUser(userID string) (int64, error) {
	return r.counter.IncrUser(userID)
}

func (r *redisConnectionCounter) DecrUser(userID string) (int64, error) {
	return r.counter.DecrUser(userID)
}

var (
	connCounter     connectionCounter
	connCounterOnce sync.Once
)

func initConnectionCounter() {
	connCounterOnce.Do(func() {
		redisCounter, err := utils.NewRedisConnectionCounter()
		if err == nil && utils.IsRedisAvailable() {
			connCounter = &redisConnectionCounter{counter: redisCounter}
		} else {
			connCounter = &memoryConnectionCounter{}
		}
	})
}

func getConnectionCount() int {
	count, _ := connCounter.GetTotalConnections()
	return int(count)
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
	count, _ := connCounter.GetTotalConnections()
	return count < int64(maxConns)
}

func isUserConnectionAllowed(userID string) bool {
	maxConnsPerUser := config.GetConfig().WebSocket.MaxConnectionsPerUser
	if maxConnsPerUser == 0 {
		return true
	}
	count, _ := connCounter.GetUserConnections(userID)
	return count < int64(maxConnsPerUser)
}

func incrementUserConnCount(userID string) {
	connCounter.IncrUser(userID)
}

func decrementUserConnCount(userID string) {
	connCounter.DecrUser(userID)
}

// WebSocketHandler handles WebSocket connections
func WebSocketHandler(db *sql.DB) gin.HandlerFunc {
	return func(c *gin.Context) {
		initConnectionCounter()

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
		connCounter.IncrTotal()
		incrementUserConnCount(userID)
		initBroadcastWorker()

		userConns, _ := connCounter.GetUserConnections(userID)
		slog.Info("WebSocket client connected", "request_id", requestID, "user_id", userID, "total_clients", getConnectionCount(), "user_connections", userConns)

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
		connCounter.DecrTotal()
		decrementUserConnCount(userID)

		userConns, _ = connCounter.GetUserConnections(userID)
		slog.Info("WebSocket client disconnected", "request_id", requestID, "user_id", userID, "total_clients", getConnectionCount(), "user_connections", userConns)
	}
}

func init() {
	initConnectionCounter()
}
