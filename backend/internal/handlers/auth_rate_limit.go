package handlers

import (
	"context"
	"net/http"
	"os"
	"sync"
	"time"

	"open-kanban/internal/config"

	"github.com/gin-gonic/gin"
	"github.com/redis/go-redis/v9"
)

type rateLimitEntry struct {
	count     int
	resetTime time.Time
}

func getMaxRateLimitEntries() int {
	return config.GetConfig().RateLimit.MaxRateLimitEntries
}

var (
	rateLimitMap      = make(map[string]*rateLimitEntry)
	rateLimitMux      sync.Mutex
	rateLimitMapOrder []string
	rateLimitOpts     = struct {
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

func getMaxGlobalRateLimitEntries() int {
	return config.GetConfig().RateLimit.MaxGlobalRateLimitEntries
}

var (
	globalRateLimitMap      = make(map[string]*globalRateLimitEntry)
	globalRateLimitMux      sync.Mutex
	globalRateLimitMapOrder []string
	globalRateLimitOpts     = struct {
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
		if len(rateLimitMap) >= getMaxRateLimitEntries() {
			cleanupOldRateLimitEntriesLocked(now)
		}
		rateLimitMap[key] = &rateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(windowSecs) * time.Second),
		}
		rateLimitMapOrder = append(rateLimitMapOrder, key)
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

func cleanupOldRateLimitEntriesLocked(now time.Time) {
	for key, entry := range rateLimitMap {
		if now.After(entry.resetTime) {
			delete(rateLimitMap, key)
		}
	}
	if len(rateLimitMap) >= getMaxRateLimitEntries() {
		targetSize := getMaxRateLimitEntries() / 2
		for len(rateLimitMap) > targetSize && len(rateLimitMapOrder) > 0 {
			oldestKey := rateLimitMapOrder[0]
			rateLimitMapOrder = rateLimitMapOrder[1:]
			delete(rateLimitMap, oldestKey)
		}
	}
}

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

func cleanupOldGlobalRateLimitEntriesLocked(now time.Time) {
	for key, entry := range globalRateLimitMap {
		if now.After(entry.resetTime) {
			delete(globalRateLimitMap, key)
		}
	}
	if len(globalRateLimitMap) >= getMaxGlobalRateLimitEntries() {
		targetSize := getMaxGlobalRateLimitEntries() / 2
		for len(globalRateLimitMap) > targetSize && len(globalRateLimitMapOrder) > 0 {
			oldestKey := globalRateLimitMapOrder[0]
			globalRateLimitMapOrder = globalRateLimitMapOrder[1:]
			delete(globalRateLimitMap, oldestKey)
		}
	}
}

func CheckGlobalRateLimit(key string, maxRequests int, windowSecs int) bool {
	globalRateLimitMux.Lock()
	defer globalRateLimitMux.Unlock()

	now := time.Now()
	entry, exists := globalRateLimitMap[key]

	if !exists || now.After(entry.resetTime) {
		if len(globalRateLimitMap) >= getMaxGlobalRateLimitEntries() {
			cleanupOldGlobalRateLimitEntriesLocked(now)
		}
		globalRateLimitMap[key] = &globalRateLimitEntry{
			count:     1,
			resetTime: now.Add(time.Duration(windowSecs) * time.Second),
		}
		globalRateLimitMapOrder = append(globalRateLimitMapOrder, key)
		return true
	}

	if entry.count >= maxRequests {
		return false
	}

	entry.count++
	return true
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
	rateLimitMapOrder = nil
}

func ResetGlobalRateLimitMapForTest() {
	globalRateLimitMux.Lock()
	defer globalRateLimitMux.Unlock()
	globalRateLimitMap = make(map[string]*globalRateLimitEntry)
	globalRateLimitMapOrder = nil
}

func checkRateLimit(key string) bool {
	return rateLimitStoreInstance.check(key, rateLimitOpts.maxRequests, rateLimitOpts.windowSecs)
}

func checkGlobalRateLimit(key string) bool {
	return rateLimitStoreInstance.check(key, globalRateLimitOpts.maxRequests, globalRateLimitOpts.windowSecs)
}

func GlobalRateLimitMiddleware() gin.HandlerFunc {
	return func(c *gin.Context) {
		key := "global:" + c.ClientIP()

		if !checkGlobalRateLimit(key) {
			c.JSON(http.StatusTooManyRequests, gin.H{"error": "Too many requests, please try again later"})
			c.Abort()
			return
		}

		c.Next()
	}
}

func init() {
	if maxReq := getEnvInt("RATE_LIMIT_MAX_REQUESTS", 5); maxReq > 0 {
		rateLimitOpts.maxRequests = maxReq
	}
	if windowSec := getEnvInt("RATE_LIMIT_WINDOW_SECONDS", 60); windowSec > 0 {
		rateLimitOpts.windowSecs = windowSec
	}
	if globalMaxReq := getEnvInt("GLOBAL_RATE_LIMIT_MAX_REQUESTS", 100); globalMaxReq > 0 {
		globalRateLimitOpts.maxRequests = globalMaxReq
	}
	if globalWindowSec := getEnvInt("GLOBAL_RATE_LIMIT_WINDOW_SECONDS", 60); globalWindowSec > 0 {
		globalRateLimitOpts.windowSecs = globalWindowSec
	}

	rateLimitStoreType := os.Getenv("RATE_LIMIT_STORE")
	if rateLimitStoreType == "redis" {
		redisAddr := os.Getenv("REDIS_URL")
		if redisAddr == "" {
			redisAddr = "localhost:6379"
		}
		redisClient = redis.NewClient(&redis.Options{
			Addr: redisAddr,
		})
		ctx := context.Background()
		_, err := redisClient.Ping(ctx).Result()
		if err == nil {
			rateLimitStoreInstance = &redisRateLimitStore{
				client: redisClient,
				ctx:    ctx,
			}
		} else {
			rateLimitStoreInstance = &memoryRateLimitStore{}
		}
	} else {
		rateLimitStoreInstance = &memoryRateLimitStore{}
	}

	if rateLimitStoreInstance == nil {
		rateLimitStoreInstance = &memoryRateLimitStore{}
	}

	go cleanupRateLimitMap()
	go cleanupGlobalRateLimitMap()
	go cleanupTokenCache()
}
