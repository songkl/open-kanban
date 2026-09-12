package services

import (
	"context"
	"database/sql"
	"log/slog"
	"sync"
	"sync/atomic"
	"time"

	"open-kanban/internal/repositories"
)

// DefaultRunReaperInterval is the cadence at which the reaper
// scans task_runs for expired locks. §3.5 of
// devDoc/CLI_RUNNER_PLAN_2026-09-12.md prescribes 30s; tests
// override via NewRunReaperWithInterval so they don't have to
// wait that long.
const DefaultRunReaperInterval = 30 * time.Second

// RunReaper is the background goroutine that releases
// task_runs rows whose expires_at has elapsed. See §3.5 of
// devDoc/CLI_RUNNER_PLAN_2026-09-12.md for the canonical
// contract.
//
// One RunReaper is created per server boot. Start() launches
// the goroutine and returns immediately so the caller can keep
// doing boot work; Stop() is the symmetric shutdown hook used
// by main()'s signal handler so the reaper doesn't leak past
// a graceful shutdown.
type RunReaper struct {
	db       *sql.DB
	repo     *repositories.RunRepository
	interval time.Duration
	stopCh   chan struct{}
	doneCh   chan struct{}
	once     sync.Once
	started  atomic.Bool
}

// NewRunReaper wires a reaper onto the given database with the
// default (30s) cadence.
func NewRunReaper(db *sql.DB) *RunReaper {
	return NewRunReaperWithInterval(db, DefaultRunReaperInterval)
}

// NewRunReaperWithInterval is the test-friendly constructor —
// callers can dial the cadence down to milliseconds to keep the
// test suite fast.
func NewRunReaperWithInterval(db *sql.DB, interval time.Duration) *RunReaper {
	if interval <= 0 {
		interval = DefaultRunReaperInterval
	}
	return &RunReaper{
		db:       db,
		repo:     repositories.NewRunRepository(db),
		interval: interval,
		stopCh:   make(chan struct{}),
		doneCh:   make(chan struct{}),
	}
}

// Start launches the reaper loop in the background. Returns
// immediately; the loop runs until Stop() is called or ctx is
// cancelled. Safe to call exactly once per RunReaper; a second
// call is a no-op so a hot-reload path doesn't double-spawn.
func (r *RunReaper) Start(ctx context.Context) {
	r.once.Do(func() {
		r.started.Store(true)
		go r.loop(ctx)
	})
}

// Stop signals the loop to exit and blocks until it has
// finished its current pass. Idempotent — calling Stop more
// than once is safe. Also safe when Start was never called:
// the doneCh is left open so we must not block on it in that
// case (otherwise graceful-shutdown paths that race with the
// boot sequence would deadlock).
func (r *RunReaper) Stop() {
	select {
	case <-r.stopCh:
		return
	default:
		close(r.stopCh)
	}
	if !r.started.Load() {
		return
	}
	<-r.doneCh
}

// RunOnce performs a single sweep. Exposed so tests (and
// operators poking with a debug flag) can drive the reaper
// without waiting for the timer.
func (r *RunReaper) RunOnce() (int, error) {
	expired, err := r.repo.ReapExpiredRuns(true)
	if err != nil {
		return 0, err
	}
	if len(expired) > 0 {
		slog.Info("run_reaper: released expired task_runs",
			"count", len(expired),
			"task_ids", taskIDs(expired),
		)
	}
	return len(expired), nil
}

func (r *RunReaper) loop(ctx context.Context) {
	defer close(r.doneCh)

	// First sweep fires immediately so a server boot doesn't
	// have to wait `interval` for stale locks to clear. After
	// that we settle into the steady-state cadence.
	r.RunOnce()

	ticker := time.NewTicker(r.interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-r.stopCh:
			return
		case <-ticker.C:
			if _, err := r.RunOnce(); err != nil {
				slog.Error("run_reaper: sweep failed", "error", err)
			}
		}
	}
}

func taskIDs(expired []repositories.ExpiredRun) []string {
	ids := make([]string, 0, len(expired))
	for _, e := range expired {
		ids = append(ids, e.TaskID)
	}
	return ids
}
