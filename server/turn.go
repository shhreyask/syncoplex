package main

import (
	"encoding/json"
	"io"
	"log"
	"fmt"
	"net/http"
	"sync"
	"time"
)

// ── Ephemeral TURN Credential Cache ──────────────────────────────────────
//
// Metered's REST API returns short-lived credentials. We cache the response
// server-side to avoid hammering their API on every client request.
//
// Cache TTL: 10 minutes. Credential TTL requested from Metered: 4 hours.
// So cached credentials always have at least ~3h50m of life remaining.
//
// The API key never leaves the server. Clients receive only ephemeral creds.

var (
	turnCacheMu     sync.RWMutex
	turnCacheData   []any
	turnCacheExpiry time.Time
)

const (
	turnCacheTTL      = 10 * time.Minute
	turnCredentialTTL = 6 * 60 * 60 // 4 hours in seconds
)

func fetchMeteredCredentials(cfg Config) ([]any, error) {
	// Check cache first
	turnCacheMu.RLock()
	if turnCacheData != nil && time.Now().Before(turnCacheExpiry) {
		cached := turnCacheData
		turnCacheMu.RUnlock()
		return cached, nil
	}
	turnCacheMu.RUnlock()

	// Cache miss — call Metered REST API
	url := "https://" + cfg.MeteredTurnHost + "/api/v1/turn/credentials?apiKey=" + cfg.MeteredAPIKey +
		"&expiresIn=" + itoa(turnCredentialTTL)

	resp, err := http.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}

	if resp.StatusCode != 200 {
		log.Printf("turn: Metered API returned %d: %s", resp.StatusCode, string(body))
		return nil, err
	}

	var iceServers []any
	if err := json.Unmarshal(body, &iceServers); err != nil {
		return nil, err
	}

	// Update cache
	turnCacheMu.Lock()
	turnCacheData = iceServers
	turnCacheExpiry = time.Now().Add(turnCacheTTL)
	turnCacheMu.Unlock()

	return iceServers, nil
}

func itoa(n int) string {
	return fmt.Sprintf("%d", n)
}

func handleTurnCredentials(cfg Config) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		origin := r.Header.Get("Origin")
		if origin != "" && origin != cfg.AllowedOrigin {
			http.Error(w, "Forbidden", http.StatusForbidden)
			return
		}

		// Base STUN servers — free, no credentials needed
		iceServers := []any{
			map[string]any{"urls": "stun:stun.l.google.com:19302"},
			map[string]any{"urls": "stun:stun1.l.google.com:19302"},
			map[string]any{"urls": "stun:stun.cloudflare.com:3478"},
		}

		// Append ephemeral TURN credentials from Metered
		if cfg.MeteredTurnHost != "" && cfg.MeteredAPIKey != "" {
			turnServers, err := fetchMeteredCredentials(cfg)
			if err != nil {
				log.Printf("turn: failed to fetch Metered credentials: %v", err)
				// Fall through — client gets STUN only, P2P still works
			} else {
				iceServers = append(iceServers, turnServers...)
			}
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]any{
			"iceServers": iceServers,
			"expiresAt":  time.Now().Add(turnCacheTTL).UnixMilli(),
		})
		w.Header().Set("Cache-Control", "no-store")
	}
}