package services

import (
	"encoding/json"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Event is the interface every event the service layer
// publishes through the EventBus must satisfy. The fields
// exposed here correspond 1:1 to the envelope (plan §3.1 in
// docs/EVENT_CENTER_PLAN_s-1138.md): EventType powers the
// dispatcher's fan-out across webhook rows, EnvelopeID is
// stamped on webhook_deliveries.event_id for receiver-side
// dedupe, OccurredAt renders the envelope's occurredAt
// timestamp, and Data is the event-specific payload rendered
// under envelope.data.
//
// Implementations should be cheap to construct and free of
// side effects: Publish is called inline from the HTTP
// request goroutine, and the dispatcher re-reads Data() on
// its own goroutine.
type Event interface {
	EventType() string
	EnvelopeID() string
	OccurredAt() time.Time
	Data() any
}

// Actor describes the entity (USER / AGENT / SYSTEM) that
// triggered an event. Mirrors the actor object on the
// envelope (plan §3.1). Optional: when the bus publishes
// events from background goroutines (system heartbeats,
// sweepers) the actor may be left zero — the dispatcher
// omits the actor block from the rendered envelope in that
// case.
type Actor struct {
	Type     string `json:"type"`
	ID       string `json:"id,omitempty"`
	Nickname string `json:"nickname,omitempty"`
}

// BoardRef is the per-event board reference on the envelope.
// Omitted for board-level events (board.created /
// board.updated / board.deleted) per plan §3.1.
type BoardRef struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

// Envelope is the JSON wrapper every webhook receiver gets
// (plan §3.1). The dispatcher renders it once per event and
// reuses the bytes for every webhook that matches so
// downstream receivers can dedupe on envelope.id.
type Envelope struct {
	ID          string    `json:"id"`
	Type        string    `json:"type"`
	OccurredAt  time.Time `json:"occurredAt"`
	DeliveredAt time.Time `json:"deliveredAt"`
	Actor       Actor     `json:"actor,omitempty"`
	Board       *BoardRef `json:"board,omitempty"`
	Data        any       `json:"data"`
}

// MarshalEnvelope renders the envelope to JSON. Centralised
// so the test suite and the production dispatcher agree on
// the wire shape (key order, omitempty semantics).
func MarshalEnvelope(env Envelope) ([]byte, error) {
	return json.Marshal(env)
}

// EventBus is the front door for any code path that wants to
// notify webhooks. The contract is intentionally tiny: the
// dispatcher / worker pool / signing logic all live behind
// the EventCenter so the bus can be swapped (tests, dry
// runs) by injecting an alternate implementation.
//
// The synchronous-enqueue requirement (s-1141 spec) means
// Publish MUST block until the event has been accepted by the
// bus. Callers can rely on the event being safely in the
// pipeline when Publish returns nil.
type EventBus interface {
	Publish(event Event) error
	Close() error
	Channel() <-chan Event
}

// ErrBusClosed is returned by Publish when Close has been
// called. The dispatcher still drains any in-flight events
// on the channel — this error is purely advisory so the
// caller can decide whether to retry, log, or silently drop.
var ErrBusClosed = errors.New("event_bus: closed")

// ChannelEventBus is the default EventBus: a buffered channel
// drained by the EventCenter dispatcher goroutine. Capacity
// is fixed at construction time; once full, Publish blocks
// until the dispatcher catches up, which is the behaviour
// the synchronous-enqueue requirement wants.
type ChannelEventBus struct {
	ch        chan Event
	closeOnce sync.Once
	closed    chan struct{}
}

// NewChannelEventBus constructs a bus with the supplied
// channel capacity. Capacity should match (or exceed) the
// expected peak burst; passing <= 0 falls back to a 256-slot
// default. Tests typically use a small capacity (1-4) so they
// can exercise back-pressure without flooding the queue.
func NewChannelEventBus(capacity int) *ChannelEventBus {
	if capacity <= 0 {
		capacity = 256
	}
	return &ChannelEventBus{
		ch:     make(chan Event, capacity),
		closed: make(chan struct{}),
	}
}

// Publish synchronously enqueues event onto the bus. Returns
// nil on success, ErrBusClosed if Close has been called. The
// nil-event guard surfaces a programming error early instead
// of panicking inside the dispatcher.
func (b *ChannelEventBus) Publish(event Event) error {
	if event == nil {
		return fmt.Errorf("event_bus: cannot publish nil event")
	}
	select {
	case <-b.closed:
		return ErrBusClosed
	default:
	}
	select {
	case <-b.closed:
		return ErrBusClosed
	case b.ch <- event:
		return nil
	}
}

// Close marks the bus as closed so any subsequent Publish
// returns ErrBusClosed. The underlying channel is left open
// so the dispatcher can drain whatever is already queued
// before it returns. Idempotent.
func (b *ChannelEventBus) Close() error {
	b.closeOnce.Do(func() {
		close(b.closed)
	})
	return nil
}

// Channel exposes the read end of the bus for the
// dispatcher. Kept package-internal in spirit — only the
// EventCenter calls it; the rest of the codebase interacts
// through Publish.
func (b *ChannelEventBus) Channel() <-chan Event {
	return b.ch
}
