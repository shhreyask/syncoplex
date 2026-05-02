package main

import (
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/joho/godotenv"
)

func main() {
	_ = godotenv.Load("../.env")

	cfg := LoadConfig()

	rdb := newRedisClient(cfg)

	hub := newHub(rdb)
	go hub.run()

	upgrader := newUpgrader(cfg.AllowedOrigin)

	// ── Rate Limiters ─────────────────────────────────────────────────────────
	roomCreateLimiter := newRateLimiter(RateRoomCreate, time.Minute)
	roomLookupLimiter := newRateLimiter(RateRoomLookup, time.Minute)

	wrap := func(handler http.Handler, limiter *rateLimiter) http.Handler {
		return securityHeaders(cors(cfg.AllowedOrigin)(limiter.middleware(handler)))
	}

	// ── Static File Server ────────────────────────────────────────────────────

	const publicDir = "../frontend/public"
	fileServer := http.FileServer(http.Dir(publicDir))

	staticHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path

		// /room/:code — SPA route, serve index.html
		if strings.HasPrefix(path, "/room/") {
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeFile(w, r, publicDir+"/index.html")
			return
		}

		// Cache headers
		if strings.HasSuffix(path, ".js") || strings.HasSuffix(path, ".css") {
			w.Header().Set("Cache-Control", "max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}

		fileServer.ServeHTTP(w, r)
	})

	// ── Routes ────────────────────────────────────────────────────────────────

	mux := http.NewServeMux()

	mux.Handle("/rooms", wrap(handleCreateRoom(rdb), roomCreateLimiter))
	mux.Handle("/rooms/", wrap(handleGetRoom(rdb, hub), roomLookupLimiter))
	mux.Handle("/ws/", securityHeaders(cors(cfg.AllowedOrigin)(
		http.HandlerFunc(handleWebSocket(hub, rdb, upgrader)),
	)))
	mux.Handle("/", securityHeaders(staticHandler))

	// ── Server ────────────────────────────────────────────────────────────────

	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      mux,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 15 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	log.Printf("syncoplex: listening on :%s (frontend: %s)", cfg.Port, publicDir)
	if err := srv.ListenAndServe(); err != nil {
		log.Fatalf("syncoplex: server error — %v", err)
	}
}