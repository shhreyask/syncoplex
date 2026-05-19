package main

import (
	"log"
	"os"
	"strconv"
)

const (
	MaxRoomMembers             = 6
	RoomTTL                    = 6 * 60 * 60    // 6 hours in seconds
	SessionTTL                 = 5 * 60         // 5 minutes in seconds
	MaxMessageSize             = 4096           // 4KB
	WriteWait                  = 10             // seconds — write deadline per message
	PongWait                   = 60             // seconds — max silence before drop
	SendBufferSize             = 256            // buffered send channel size per client
	MaxNameLength              = 32
	RateRoomCreate             = 20  			// requests per minute per IP
	RateRoomLookup             = 10  			// requests per minute per IP
	RateTurnCredentials        = 30  			// requests per minute per IP
	MaxPlaybackPositionSeconds = 86400 			// max seconds in a movie
)

type Config struct {
	Port          string
	RedisAddr     string
	RedisPassword string
	AllowedOrigin string

	// Metered TURN — managed TURN service 
	MeteredTurnHost   string
	MeteredUsername   string
	MeteredCredential string
}

func LoadConfig() Config {
	cfg := Config{
		Port:              getEnv("PORT", "8080"),
		RedisAddr:         getEnv("REDIS_ADDR", "127.0.0.1:6379"),
		RedisPassword:     getEnv("REDIS_PASSWORD", ""),
		AllowedOrigin:     getEnv("ALLOWED_ORIGIN", "https://syncoplex.app"),
		MeteredStunURL:    getEnv("METERED_STUN_URL", ""),
		MeteredTurnHost:   getEnv("METERED_TURN_HOST", ""),
		MeteredUsername:    getEnv("METERED_USERNAME", ""),
		MeteredCredential: getEnv("METERED_CREDENTIAL", ""),
	}

	// Validate port is a real number — fail fast on bad config
	if _, err := strconv.Atoi(cfg.Port); err != nil {
		log.Fatalf("config: PORT must be a number, got %q", cfg.Port)
	}

	if cfg.RedisPassword == "" {
		log.Println("config: WARNING — REDIS_PASSWORD is not set")
	}

	if cfg.MeteredTurnHost == "" || cfg.MeteredUsername == "" || cfg.MeteredCredential == "" {
		log.Println("config: WARNING — METERED_TURN_HOST, METERED_USERNAME, or METERED_CREDENTIAL not set — TURN relay disabled, direct P2P only")
	}

	return cfg
}

func getEnv(key, fallback string) string {
	if val, ok := os.LookupEnv(key); ok && val != "" {
		return val
	}
	return fallback
}