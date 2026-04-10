package handlers

import (
	"encoding/json"
	"log/slog"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

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

type broadcastMessage struct {
	msgType int
	data    any
}

var (
	broadcastQueue = make(chan broadcastMessage, 1000)
	broadcastWg    sync.WaitGroup
	broadcastDone  = make(chan struct{})
	broadcastOnce  sync.Once
)

func initBroadcastWorker() {
	broadcastOnce.Do(func() {
		broadcastWg.Add(1)
		go func() {
			defer broadcastWg.Done()
			for {
				select {
				case <-broadcastDone:
					return
				case msg := <-broadcastQueue:
					processBroadcast(msg)
				}
			}
		}()
	})
}

func stopBroadcastWorker() {
	close(broadcastDone)
	broadcastWg.Wait()
}

func enqueueBroadcast(msgType int, data any) bool {
	select {
	case broadcastQueue <- broadcastMessage{msgType: msgType, data: data}:
		return true
	default:
		slog.Warn("Broadcast queue full, dropping message")
		return false
	}
}

func processBroadcast(msg broadcastMessage) {
	clientsMux.RLock()
	conns := make([]*websocket.Conn, 0, len(clients))
	for conn := range clients {
		conns = append(conns, conn)
	}
	clientsMux.RUnlock()

	data, err := json.Marshal(msg.data)
	if err != nil {
		slog.Error("Failed to marshal broadcast message", "error", err)
		return
	}

	for _, conn := range conns {
		conn.SetWriteDeadline(time.Now().Add(5 * time.Second))
		if err := conn.WriteMessage(websocket.TextMessage, data); err != nil {
			slog.Warn("Failed to broadcast to client", "error", err)
			safeRemoveClient(conn)
		}
	}
}

func safeRemoveClient(conn *websocket.Conn) {
	clientsMux.Lock()
	if _, ok := clients[conn]; ok {
		delete(clients, conn)
		clientsMux.Unlock()
		conn.Close()
	} else {
		clientsMux.Unlock()
	}
}

func BroadcastActivity(activity any) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Recovered from panic in BroadcastActivity", "panic", r)
		}
	}()

	message := ActivityMessage{Type: "new_activity", Activity: sanitizeActivity(activity)}
	enqueueBroadcast(websocket.TextMessage, message)
}

func BroadcastRefresh() {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Recovered from panic in BroadcastRefresh", "panic", r)
		}
	}()

	message := map[string]string{"type": "refresh"}
	enqueueBroadcast(websocket.TextMessage, message)
}

func BroadcastTaskNotification(boardID, taskID, action string) {
	defer func() {
		if r := recover(); r != nil {
			slog.Error("Recovered from panic in BroadcastTaskNotification", "panic", r)
		}
	}()

	notification := TaskNotification{
		Type:    "task_notification",
		BoardID: sanitizeString(boardID),
		TaskID:  sanitizeString(taskID),
		Action:  sanitizeString(action),
	}
	enqueueBroadcast(websocket.TextMessage, notification)
}
