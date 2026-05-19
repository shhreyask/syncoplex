package main

import (
	"encoding/json"
	"net/http"
	"time"
)

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

		iceServers := []map[string]interface{}{
			{"urls": "stun:stun.l.google.com:19302"},
			{"urls": "stun:stun1.l.google.com:19302"},
			{"urls": "stun:stun.cloudflare.com:3478"},
		}

		// Metered TURN — all transport variants in priority order:
		// UDP (fastest), TCP (if UDP blocked), TLS/443 (corporate/campus firewalls)
		if cfg.MeteredTurnHost != "" && cfg.MeteredUsername != "" && cfg.MeteredCredential != "" {
			iceServers = append(iceServers, map[string]interface{}{
				"urls": []string{
					"turn:" + cfg.MeteredTurnHost + ":80",
					"turn:" + cfg.MeteredTurnHost + ":80?transport=tcp",
					"turns:" + cfg.MeteredTurnHost + ":443?transport=tcp",
				},
				"username":   cfg.MeteredUsername,
				"credential": cfg.MeteredCredential,
			})
		}

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"iceServers": iceServers,
			"expiresAt":  time.Now().Add(time.Hour).UnixMilli(),
		})
	}
}