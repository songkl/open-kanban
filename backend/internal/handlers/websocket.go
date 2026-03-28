package handlers

import (
	"log"
	"net/http"
	"sync"

	"github.com/gin-gonic/gin"
	"github.com/gorilla/websocket"
)

var (
	upgrader = websocket.Upgrader{
		CheckOrigin: func(r *http.Request) bool {
			return true // Allow all origins for development
		},
	}
	clients    = make(map[*websocket.Conn]bool)
	clientsMux sync.RWMutex
)

// WebSocketHandler handles WebSocket connections
func WebSocketHandler() gin.HandlerFunc {
	return func(c *gin.Context) {
		conn, err := upgrader.Upgrade(c.Writer, c.Request, nil)
		if err != nil {
			log.Printf("WebSocket upgrade failed: %v", err)
			return
		}
		defer conn.Close()

		// Register client
		clientsMux.Lock()
		clients[conn] = true
		clientsMux.Unlock()

		log.Printf("WebSocket client connected, total clients: %d", len(clients))

		// Keep connection alive and handle disconnect
		for {
			_, _, err := conn.ReadMessage()
			if err != nil {
				// Client disconnected
				clientsMux.Lock()
				delete(clients, conn)
				clientsMux.Unlock()
				log.Printf("WebSocket client disconnected, total clients: %d", len(clients))
				break
			}
		}
	}
}

// BroadcastRefresh sends a refresh message to all connected WebSocket clients
func BroadcastRefresh() {
	clientsMux.RLock()
	// Copy clients to a slice to avoid holding lock during iteration
	var clientList []*websocket.Conn
	for client := range clients {
		clientList = append(clientList, client)
	}
	clientsMux.RUnlock()

	message := map[string]string{"type": "refresh"}

	for _, client := range clientList {
		err := client.WriteJSON(message)
		if err != nil {
			// Client might be disconnected, remove it
			clientsMux.Lock()
			delete(clients, client)
			clientsMux.Unlock()
			client.Close()
		}
	}
}
