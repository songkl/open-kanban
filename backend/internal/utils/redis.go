package utils

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/redis/go-redis/v9"
)

func encodeJSON(v interface{}) (string, error) {
	data, err := json.Marshal(v)
	if err != nil {
		return "", err
	}
	return string(data), nil
}

func decodeJSON(data string, v interface{}) error {
	return json.Unmarshal([]byte(data), v)
}

var (
	redisClient      *redis.Client
	redisClientOnce  sync.Once
	redisInitErr     error
	redisEnabled     bool
	redisEnabledOnce sync.Once
)

func isRedisEnabled() bool {
	redisEnabledOnce.Do(func() {
		redisEnabled = os.Getenv("REDIS_ENABLED") == "true"
	})
	return redisEnabled
}

func GetRedisClient() (*redis.Client, error) {
	if !isRedisEnabled() {
		return nil, fmt.Errorf("redis is not enabled, set REDIS_ENABLED=true to enable")
	}
	redisClientOnce.Do(func() {
		redisAddr := os.Getenv("REDIS_URL")
		if redisAddr == "" {
			redisAddr = "localhost:6379"
		}
		password := os.Getenv("REDIS_PASSWORD")
		db := 0

		redisClient = redis.NewClient(&redis.Options{
			Addr:     redisAddr,
			Password: password,
			DB:       db,
		})

		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()

		if _, err := redisClient.Ping(ctx).Result(); err != nil {
			redisInitErr = fmt.Errorf("failed to connect to Redis at %s: %w", redisAddr, err)
			redisClient = nil
		}
	})

	if redisClient == nil {
		return nil, redisInitErr
	}
	return redisClient, nil
}

func IsRedisAvailable() bool {
	if !isRedisEnabled() {
		return false
	}
	client, err := GetRedisClient()
	if err != nil {
		return false
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err = client.Ping(ctx).Result()
	return err == nil
}

type TokenCacheEntry struct {
	UserID    string    `json:"user_id"`
	Username  string    `json:"username"`
	Nickname  string    `json:"nickname"`
	Avatar    string    `json:"avatar"`
	Type      string    `json:"type"`
	Role      string    `json:"role"`
	Enabled   bool      `json:"enabled"`
	ExpiresAt time.Time `json:"expires_at"`
}

type RedisTokenCache struct {
	client *redis.Client
	ctx    context.Context
}

func NewRedisTokenCache() (*RedisTokenCache, error) {
	client, err := GetRedisClient()
	if err != nil {
		return nil, err
	}
	return &RedisTokenCache{
		client: client,
		ctx:    context.Background(),
	}, nil
}

func (r *RedisTokenCache) tokenKey(token string) string {
	return "token:" + token
}

func (r *RedisTokenCache) Load(token string) (*TokenCacheEntry, bool, error) {
	key := r.tokenKey(token)
	val, err := r.client.Get(r.ctx, key).Result()
	if err == redis.Nil {
		return nil, false, nil
	}
	if err != nil {
		return nil, false, err
	}

	var entry TokenCacheEntry
	if err := decodeJSON(val, &entry); err != nil {
		return nil, false, err
	}

	if time.Now().After(entry.ExpiresAt) {
		r.client.Del(r.ctx, key)
		return nil, false, nil
	}

	return &entry, true, nil
}

func (r *RedisTokenCache) Store(token string, entry *TokenCacheEntry, duration time.Duration) error {
	key := r.tokenKey(token)
	data, err := encodeJSON(entry)
	if err != nil {
		return err
	}
	return r.client.Set(r.ctx, key, data, duration).Err()
}

func (r *RedisTokenCache) Delete(token string) error {
	key := r.tokenKey(token)
	return r.client.Del(r.ctx, key).Err()
}

type RedisConnectionCounter struct {
	client *redis.Client
	ctx    context.Context
}

func NewRedisConnectionCounter() (*RedisConnectionCounter, error) {
	client, err := GetRedisClient()
	if err != nil {
		return nil, err
	}
	return &RedisConnectionCounter{
		client: client,
		ctx:    context.Background(),
	}, nil
}

func (r *RedisConnectionCounter) totalConnectionsKey() string {
	return "ws:connections:total"
}

func (r *RedisConnectionCounter) userConnectionsKey(userID string) string {
	return "ws:connections:user:" + userID
}

func (r *RedisConnectionCounter) GetTotalConnections() (int64, error) {
	val, err := r.client.Get(r.ctx, r.totalConnectionsKey()).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return val, err
}

func (r *RedisConnectionCounter) IncrTotal() (int64, error) {
	return r.client.Incr(r.ctx, r.totalConnectionsKey()).Result()
}

func (r *RedisConnectionCounter) DecrTotal() (int64, error) {
	val, err := r.client.Decr(r.ctx, r.totalConnectionsKey()).Result()
	if val < 0 {
		r.client.Set(r.ctx, r.totalConnectionsKey(), 0, 0)
		return 0, nil
	}
	return val, err
}

func (r *RedisConnectionCounter) GetUserConnections(userID string) (int64, error) {
	val, err := r.client.Get(r.ctx, r.userConnectionsKey(userID)).Int64()
	if err == redis.Nil {
		return 0, nil
	}
	return val, err
}

func (r *RedisConnectionCounter) IncrUser(userID string) (int64, error) {
	return r.client.Incr(r.ctx, r.userConnectionsKey(userID)).Result()
}

func (r *RedisConnectionCounter) DecrUser(userID string) (int64, error) {
	val, err := r.client.Decr(r.ctx, r.userConnectionsKey(userID)).Result()
	if val < 0 {
		r.client.Del(r.ctx, r.userConnectionsKey(userID))
		return 0, nil
	}
	return val, err
}

func (r *RedisConnectionCounter) CleanupUser(userID string) error {
	return r.client.Del(r.ctx, r.userConnectionsKey(userID)).Err()
}
