package main

import (
	"context"
	"log"

	"github.com/redis/go-redis/v9"
)

func newRedisClient(cfg Config) *redis.Client {
	rdb := redis.NewClient(&redis.Options{
		Addr:     cfg.RedisAddr,
		Password: cfg.RedisPassword,
		DB:       0,

		// Connection pool — one server process, keep it lean
		PoolSize:     10,
		MinIdleConns: 2,
	})

	// Fail fast — if Redis is unreachable the server is useless
	ctx := context.Background()
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("redis: failed to connect to %s — %v", cfg.RedisAddr, err)
	}

	log.Printf("redis: connected to %s", cfg.RedisAddr)
	return rdb
}