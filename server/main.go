package main

import (
	"log"
	"net/http"
	"time"

	"github.com/joho/godotenv"
)

func main() {
	// Load .env — ignore error in production (env vars set externally)
	_ = godotenv.Load("../.env")

	cfg := LoadConfig()

	rdb := newRedisClient(cfg)

	hub := newHub(rdb)
	go hub.run()

	upgrader := newUpgrader(cfg.AllowedOrigin)

	// ── Rate Limiters ─────────────────────────────────────────────────────────
	roomCreateLimiter := newRateLimiter(RateRoomCreate, time.Minute)
	roomLookupLimiter := newRateLimiter(RateRoomLookup, time.Minute)

	// ── Middleware Stack ──────────────────────────────────────────────────────
	//
	// Every request passes through:
	//   security headers → CORS → rate limiter → handler
	//
	// Rate limiters are applied per-route with their own limits.

	wrap := func(handler http.Handler, limiter *rateLimiter) http.Handler {
		return securityHeaders(cors(cfg.AllowedOrigin)(limiter.middleware(handler)))
	}

	// ── Routes ────────────────────────────────────────────────────────────────

	mux := http.NewServeMux()

	// POST /rooms — create a new room
	mux.Handle("/rooms", wrap(
		handleCreateRoom(rdb),
		roomCreateLimiter,
	))

	// GET /rooms/:code — check room exists, member count, full status
	mux.Handle("/rooms/", wrap(
		handleGetRoom(rdb, hub),
		roomLookupLimiter,
	))

	// GET /ws/:code — WebSocket upgrade, no rate limiter here
	// Rate limiting at WebSocket message level is handled inside readPump
	mux.Handle("/ws/", securityHeaders(cors(cfg.AllowedOrigin)(
		http.HandlerFunc(handleWebSocket(hub, rdb, upgrader)),
	)))

	// ── Server ────────────────────────────────────────────────────────────────

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("syncoplex: listening on :%s", cfg.Port)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("syncoplex: server error — %v", err)
	}
}