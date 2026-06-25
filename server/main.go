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

	roomStore := newRoomStore()
	sessionStore := newSessionStore()

	hub := newHub(roomStore, sessionStore)
	go hub.run()

	upgrader := newUpgrader(cfg.AllowedOrigin)

	// ── Rate Limiters ─────────────────────────────────────────────────────────
	roomCreateLimiter := newRateLimiter(RateRoomCreate, time.Minute)
	roomLookupLimiter := newRateLimiter(RateRoomLookup, time.Minute)
	turnLimiter       := newRateLimiter(RateTurnCredentials, time.Minute)

	wrap := func(handler http.Handler, limiter *rateLimiter) http.Handler {
	return securityHeaders(cfg.AllowedOrigin)(cors(cfg.AllowedOrigin)(limiter.middleware(handler)))
	}

	// ── Static File Server ────────────────────────────────────────────────────

	publicDir := cfg.PublicDir
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

	mux.Handle("/rooms", wrap(handleCreateRoom(roomStore), roomCreateLimiter))
	mux.Handle("/rooms/", wrap(handleGetRoom(roomStore, hub), roomLookupLimiter))
	mux.Handle("/api/turn-credentials", wrap(http.HandlerFunc(handleTurnCredentials(cfg)), turnLimiter))
	mux.Handle("/ws/", securityHeaders(cfg.AllowedOrigin)(cors(cfg.AllowedOrigin)(
		http.HandlerFunc(handleWebSocket(hub, upgrader)),
	)))
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	})
	mux.Handle("/", securityHeaders(cfg.AllowedOrigin)(staticHandler))

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