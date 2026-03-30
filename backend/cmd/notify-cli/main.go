package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"os"
	"os/exec"
	"strings"

	"github.com/gorilla/websocket"
)

type EventRule struct {
	EventType string
	BoardIDs  []string
	Command   string
}

type TaskNotification struct {
	Type    string `json:"type"`
	BoardID string `json:"boardId"`
	TaskID  string `json:"taskId"`
	Action  string `json:"action"`
	Status  string `json:"status,omitempty"`
}

var (
	wsURL  string
	token  string
	rules  rulesFlag
	dryRun bool
)

type rulesFlag []string

func (r *rulesFlag) String() string {
	return strings.Join(*r, ",")
}

func (r *rulesFlag) Set(value string) error {
	*r = append(*r, value)
	return nil
}

func parseRule(raw string) (EventRule, error) {
	parts := strings.SplitN(raw, ":", 3)
	if len(parts) < 2 {
		return EventRule{}, fmt.Errorf("invalid rule format: %s (expected eventType:command or eventType:board1,board2:command)", raw)
	}
	rule := EventRule{
		EventType: parts[0],
		Command:   parts[len(parts)-1],
	}
	if len(parts) == 3 {
		rule.BoardIDs = strings.Split(parts[1], ",")
	}
	return rule, nil
}

func main() {
	flag.StringVar(&wsURL, "ws", "", "WebSocket URL (e.g., ws://localhost:8080/ws)")
	flag.StringVar(&wsURL, "websocket", "", "WebSocket URL (alias for -ws)")
	flag.StringVar(&token, "token", "", "Authentication token")
	flag.Var(&rules, "rule", "Event rule in format: eventType:command or eventType:board1,board2:command (can be repeated)")
	flag.BoolVar(&dryRun, "dry-run", false, "Print commands without executing")
	flag.Usage = func() {
		fmt.Fprintf(os.Stderr, "Usage: %s -ws <websocket-url> -token <token> -rule <eventType:command> [-rule ...]\n\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "Options:\n")
		flag.PrintDefaults()
		fmt.Fprintf(os.Stderr, "\nExamples:\n")
		fmt.Fprintf(os.Stderr, "  %s -ws ws://localhost:8080/ws -token xxx -rule \"create:/path/to/script.sh\"  # $0=event, $1=taskId, $2=status\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -ws ws://localhost:8080/ws -token xxx -rule \"create:echo 'New task {{.TaskID}}'\"\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -ws ws://localhost:8080/ws -token xxx -rule \"update:echo 'Updated'\" -rule \"update_status:board1,board2:echo 'Status changed'\"\n", os.Args[0])
		fmt.Fprintf(os.Stderr, "  %s -ws ws://localhost:8080/ws -token xxx -rule \"create:echo 'Board {{.BoardID}} Task {{.TaskID}}'\" -dry-run\n", os.Args[0])
	}
	flag.Parse()

	if wsURL == "" {
		fmt.Fprintf(os.Stderr, "Error: -ws is required\n\n")
		flag.Usage()
		os.Exit(1)
	}
	if token == "" {
		fmt.Fprintf(os.Stderr, "Error: -token is required\n\n")
		flag.Usage()
		os.Exit(1)
	}
	if len(rules) == 0 {
		fmt.Fprintf(os.Stderr, "Error: at least one -rule is required\n\n")
		flag.Usage()
		os.Exit(1)
	}

	parsedRules := make([]EventRule, 0, len(rules))
	for _, raw := range rules {
		rule, err := parseRule(raw)
		if err != nil {
			log.Fatalf("Failed to parse rule: %v", err)
		}
		parsedRules = append(parsedRules, rule)
	}

	url := fmt.Sprintf("%s?token=%s", wsURL, token)
	conn, _, err := websocket.DefaultDialer.Dial(url, nil)
	if err != nil {
		log.Fatalf("Failed to connect to WebSocket: %v", err)
	}
	defer conn.Close()

	log.Printf("Connected to WebSocket: %s", wsURL)

	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			log.Fatalf("WebSocket read error: %v", err)
		}

		var notification TaskNotification
		if err := json.Unmarshal(message, &notification); err != nil {
			continue
		}

		if notification.Type != "task_notification" {
			continue
		}

		log.Printf("Received notification: board=%s task=%s action=%s", notification.BoardID, notification.TaskID, notification.Action)

		for _, rule := range parsedRules {
			if rule.EventType != notification.Action {
				continue
			}
			if len(rule.BoardIDs) > 0 {
				found := false
				for _, bid := range rule.BoardIDs {
					if bid == notification.BoardID {
						found = true
						break
					}
				}
				if !found {
					continue
				}
			}

			var cmdStr string
			var cmd *exec.Cmd

			if strings.Contains(rule.Command, "{{") {
				cmdStr = expandCommand(rule.Command, notification)
				log.Printf("Executing (template): %s", cmdStr)
				if dryRun {
					fmt.Printf("[DRY-RUN] Would execute: %s\n", cmdStr)
					continue
				}
				cmd = exec.Command("bash", "-c", cmdStr)
			} else {
				cmdStr = fmt.Sprintf("'%s'", rule.Command)
				log.Printf("Executing (direct): bash -c %s with $0=%s $1=%s $2=%s", cmdStr, notification.Action, notification.TaskID, notification.Status)
				if dryRun {
					fmt.Printf("[DRY-RUN] Would execute: bash -c %s (event=%s taskId=%s status=%s)\n", cmdStr, notification.Action, notification.TaskID, notification.Status)
					continue
				}
				cmd = exec.Command("bash", "-c", cmdStr, notification.Action, notification.TaskID, notification.Status)
			}
			cmd.Stdout = os.Stdout
			cmd.Stderr = os.Stderr
			if err := cmd.Run(); err != nil {
				log.Printf("Command failed: %v", err)
			}
		}
	}
}

func expandCommand(template string, n TaskNotification) string {
	replacer := strings.NewReplacer(
		"{{.BoardID}}", n.BoardID,
		"{{.TaskID}}", n.TaskID,
		"{{.Action}}", n.Action,
		"{{.Type}}", n.Type,
		"{{.Status}}", n.Status,
	)
	return replacer.Replace(template)
}
