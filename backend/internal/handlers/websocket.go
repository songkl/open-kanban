package handlers

import (
	"database/sql"
	"log"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"

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

const (
	pingInterval = 30 * time.Second
	pongTimeout  = 10 * time.Second
	readDeadline = pongTimeout + pingInterval
)

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
	clients    = make(map[*websocket.Conn]bool)
	clientsMux sync.RWMutex
)

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

		// Verify token
		var userID string
		err := db.QueryRow("SELECT user_id FROM tokens WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)", tokenKey, time.Now()).Scan(&userID)
		if err != nil {
			c.JSON(http.StatusUnauthorized, gin.H{"error": "Invalid session"})
			return
		}

		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("WebSocket upgrade failed: %v", err)
			return
		}
		defer conn.Close()

		// Set initial read deadline for authentication/initial connection
		conn.SetReadDeadline(time.Now().Add(readDeadline))
		conn.SetPongHandler(func(appData string) error {
			conn.SetReadDeadline(time.Now().Add(readDeadline))
			return nil
		})

		// Register client with user info
		clientsMux.Lock()
		clients[conn] = true
		clientsMux.Unlock()

		log.Printf("WebSocket client connected (user: %s), total clients: %d", userID, len(clients))

		// Start ping ticker for this connection
		pingTicker := time.NewTicker(pingInterval)
		defer pingTicker.Stop()

		// Keep connection alive and handle disconnect
		for {
			select {
			case <-pingTicker.C:
				if err := conn.WriteMessage(websocket.PingMessage, nil); err != nil {
					log.Printf("Failed to send ping to client (user: %s): %v", userID, err)
					goto cleanup
				}
			default:
				conn.SetReadDeadline(time.Now().Add(readDeadline))
				_, _, err := conn.ReadMessage()
				if err != nil {
					if closeErr, ok := err.(*websocket.CloseError); ok && closeErr.Code == websocket.CloseProtocolError {
						log.Printf("WebSocket client sent invalid data (user: %s): %v", userID, err)
					} else if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
						log.Printf("WebSocket read error (user: %s): %v", userID, err)
					}
					goto cleanup
				}
			}
		}

	cleanup:
		pingTicker.Stop()
		clientsMux.Lock()
		delete(clients, conn)
		clientsMux.Unlock()
		log.Printf("WebSocket client disconnected (user: %s), total clients: %d", userID, len(clients))
	}
}

type ActivityMessage struct {
	Type     string `json:"type"`
	Activity any    `json:"activity"`
}

type TaskNotification struct {
	Type    string `json:"type"`
	BoardID string `json:"boardId"`
	TaskID  string `json:"taskId"`
	Action  string `json:"action"`
}

// BroadcastActivity sends a new activity to all connected WebSocket clients
func BroadcastActivity(activity any) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic in BroadcastActivity: %v", r)
		}
	}()

	clientsMux.RLock()
	var clientList []*websocket.Conn
	for client := range clients {
		clientList = append(clientList, client)
	}
	clientsMux.RUnlock()

	message := ActivityMessage{Type: "new_activity", Activity: activity}
	writeDeadline := time.Now().Add(2 * time.Second)

	for _, client := range clientList {
		if err := client.SetWriteDeadline(writeDeadline); err != nil {
			log.Printf("Failed to set write deadline: %v", err)
			continue
		}
		err := client.WriteJSON(message)
		if err != nil {
			clientsMux.Lock()
			delete(clients, client)
			clientsMux.Unlock()
			client.Close()
		}
	}
}

// BroadcastRefresh sends a refresh message to all connected WebSocket clients
func BroadcastRefresh() {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic in BroadcastRefresh: %v", r)
		}
	}()

	clientsMux.RLock()
	var clientList []*websocket.Conn
	for client := range clients {
		clientList = append(clientList, client)
	}
	clientsMux.RUnlock()

	message := map[string]string{"type": "refresh"}
	writeDeadline := time.Now().Add(2 * time.Second)

	for _, client := range clientList {
		if err := client.SetWriteDeadline(writeDeadline); err != nil {
			log.Printf("Failed to set write deadline: %v", err)
			continue
		}
		err := client.WriteJSON(message)
		if err != nil {
			clientsMux.Lock()
			delete(clients, client)
			clientsMux.Unlock()
			client.Close()
		}
	}
}

// BroadcastTaskNotification sends a minimal task notification to all connected clients
func BroadcastTaskNotification(boardID, taskID, action string) {
	defer func() {
		if r := recover(); r != nil {
			log.Printf("Recovered from panic in BroadcastTaskNotification: %v", r)
		}
	}()

	clientsMux.RLock()
	var clientList []*websocket.Conn
	for client := range clients {
		clientList = append(clientList, client)
	}
	clientsMux.RUnlock()

	notification := TaskNotification{
		Type:    "task_notification",
		BoardID: boardID,
		TaskID:  taskID,
		Action:  action,
	}
	writeDeadline := time.Now().Add(2 * time.Second)

	for _, client := range clientList {
		if err := client.SetWriteDeadline(writeDeadline); err != nil {
			log.Printf("Failed to set write deadline: %v", err)
			continue
		}
		err := client.WriteJSON(notification)
		if err != nil {
			clientsMux.Lock()
			delete(clients, client)
			clientsMux.Unlock()
			client.Close()
		}
	}
}
