package handlers

import (
	"context"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

type rateLimitEntry struct {
	count     int
	resetTime time.Time
}

var (
	rateLimitMap  = make(map[string]*rateLimitEntry)
	rateLimitMux  sync.Mutex
	rateLimitOpts = struct {
		maxRequests int
		windowSecs  int
	}{
		maxRequests: 5,
		windowSecs:  60,
	}
)

type globalRateLimitEntry struct {
	count     int
	resetTime time.Time
}

var (
	globalRateLimitMap  = make(map[string]*globalRateLimitEntry)
	globalRateLimitMux  sync.Mutex
	globalRateLimitOpts = struct {
		maxRequests int
		windowSecs  int
	}{
		maxRequests: 100,
		windowSecs:  60,
	}
)

type rateLimitStore interface {
	check(key string, maxRequests int, windowSecs int) bool
}

type memoryRateLimitStore struct{}

func (m *memoryRateLimitStore) check(key string, maxRequests int, windowSecs int) bool {
	rateLimitMux.Lock()
	defer rateLimitMux.Unlock()

	now := time.Now()
	entry, exists := rateLimitMap[key]

	if !exists || now.After(entry.resetTime) {
		rateLimitMap[key] = &rateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(windowSecs) * time.Second),
		}
		return true
	}

	if entry.count >= maxRequests {
		return false
	}

	entry.count++
	return true
}

type redisRateLimitStore struct {
	client *redis.Client
	ctx    context.Context
}

func (r *redisRateLimitStore) check(key string, maxRequests int, windowSecs int) bool {
	rlKey := "ratelimit:" + key

	count, err := r.client.Incr(r.ctx, rlKey).Result()
	if err != nil {
		return true
	}

	if count == 1 {
		r.client.Expire(r.ctx, rlKey, time.Duration(windowSecs)*time.Second)
	}

	return count <= int64(maxRequests)
}

var (
	rateLimitStoreInstance rateLimitStore
	redisClient            *redis.Client
)

func cleanupRateLimitMap() {
	for {
		time.Sleep(5 * time.Minute)
		rateLimitMux.Lock()
		now := time.Now()
		for key, entry := range rateLimitMap {
			if now.After(entry.resetTime) {
				delete(rateLimitMap, key)
			}
		}
		rateLimitMux.Unlock()
	}
}

func cleanupGlobalRateLimitMap() {
	for {
		time.Sleep(5 * time.Minute)
		globalRateLimitMux.Lock()
		now := time.Now()
		for key, entry := range globalRateLimitMap {
			if now.After(entry.resetTime) {
				delete(globalRateLimitMap, key)
			}
		}
		globalRateLimitMux.Unlock()
	}
}

func ResetRateLimitMapForTest() {
	rateLimitMux.Lock()
	defer rateLimitMux.Unlock()
	rateLimitMap = make(map[string]*rateLimitEntry)
}

func ResetGlobalRateLimitMapForTest() {
	globalRateLimitMux.Lock()
	defer globalRateLimitMux.Unlock()
	globalRateLimitMap = make(map[string]*globalRateLimitEntry)
}
