package main

import (
	"net/http"
	"regexp"
	"strings"
	"sync"
	"time"
)

// ── Security Headers ─────────────────────────────────────────────────────────

func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy",
			"default-src 'self'; connect-src 'self' wss://syncoplex.app; media-src blob:; script-src 'self'; style-src 'self'")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "strict-origin-when-cross-origin")
		w.Header().Set("Permissions-Policy", "camera=*, microphone=*")
		next.ServeHTTP(w, r)
	})
}

// ── CORS ─────────────────────────────────────────────────────────────────────

func cors(allowedOrigin string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")

			if origin == allowedOrigin {
				w.Header().Set("Access-Control-Allow-Origin", allowedOrigin)
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
				w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			}

			// Preflight — respond and stop
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// ── Rate Limiter ──────────────────────────────────────────────────────────────
//
// Token bucket per IP address.
// Each IP gets `rate` tokens per minute, refilled every minute.
// Once the bucket is empty, requests are rejected with 429.

type bucket struct {
	tokens    int
	lastReset time.Time
}

type rateLimiter struct {
	mu       sync.Mutex
	buckets  map[string]*bucket
	rate     int           // max requests per window
	window   time.Duration // refill window
}

func newRateLimiter(rate int, window time.Duration) *rateLimiter {
	rl := &rateLimiter{
		buckets: make(map[string]*bucket),
		rate:    rate,
		window:  window,
	}
	// Background cleanup — remove stale IPs every 5 minutes
	go rl.cleanup()
	return rl
}

func (rl *rateLimiter) allow(ip string) bool {
	rl.mu.Lock()
	defer rl.mu.Unlock()

	b, ok := rl.buckets[ip]
	if !ok {
		rl.buckets[ip] = &bucket{tokens: rl.rate - 1, lastReset: time.Now()}
		return true
	}

	if time.Since(b.lastReset) >= rl.window {
		b.tokens = rl.rate
		b.lastReset = time.Now()
	}

	if b.tokens <= 0 {
		return false
	}

	b.tokens--
	return true
}

func (rl *rateLimiter) cleanup() {
	ticker := time.NewTicker(5 * time.Minute)
	for range ticker.C {
		rl.mu.Lock()
		for ip, b := range rl.buckets {
			if time.Since(b.lastReset) > 10*time.Minute {
				delete(rl.buckets, ip)
			}
		}
		rl.mu.Unlock()
	}
}

func (rl *rateLimiter) middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		ip := extractIP(r)
		if !rl.allow(ip) {
			http.Error(w, "Too many requests", http.StatusTooManyRequests)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func extractIP(r *http.Request) string {
	// Caddy sets X-Forwarded-For — trust it since Redis is behind Caddy
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		// Take the first IP — the real client
		if idx := strings.Index(xff, ","); idx != -1 {
			return strings.TrimSpace(xff[:idx])
		}
		return strings.TrimSpace(xff)
	}
	// Fallback — direct connection (local dev)
	if idx := strings.LastIndex(r.RemoteAddr, ":"); idx != -1 {
		return r.RemoteAddr[:idx]
	}
	return r.RemoteAddr
}

// ── Input Validation ──────────────────────────────────────────────────────────

var roomCodeRegex = regexp.MustCompile(`^[A-Z]+-[A-Z]+-[0-9]+$`)

func validRoomCode(code string) bool {
	return roomCodeRegex.MatchString(code)
}

func sanitizeName(name string) string {
	// Strip all HTML tags
	name = regexp.MustCompile(`<[^>]*>`).ReplaceAllString(name, "")
	// Collapse whitespace
	name = strings.TrimSpace(name)
	// Cap at MaxNameLength
	if len(name) > MaxNameLength {
		name = name[:MaxNameLength]
	}
	return name
}