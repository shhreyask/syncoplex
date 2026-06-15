package main

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"time"
)

// ── Word List ─────────────────────────────────────────────────────────────────

var animals = []string{
	"BEAR", "BIRD", "BOAR", "BUCK", "BULL", "CALF", "CLAM", "COLT", "CRAB",
	"CROW", "DEER", "DOVE", "DUCK", "ORCA", "FAWN", "FISH", "FLEA", "FROG",
	"GNAT", "GOAT", "HAWK", "HARE", "IBIS", "KITE", "LAMB", "LARK", "LION",
	"LYNX", "MINK", "MOLE", "MOTH", "MULE", "NEWT", "PONY", "PUMA", "QUAIL",
	"RAMS", "ROOK", "SEAL", "SLUG", "SWAN", "TOAD", "VOLE", "WASP", "WOLF",
	"WORM", "WREN", "YAKS", "ZEBU", "FINCH",
}

// ── Code Generation ───────────────────────────────────────────────────────────

func generateRoomCode() string {
	word1 := animals[rand.Intn(len(animals))]
	word2 := animals[rand.Intn(len(animals))]
	digits := rand.Intn(900000) + 100000 // always 6 digits
	return fmt.Sprintf("%s-%s-%d", word1, word2, digits)
}

// ── Room Operations ───────────────────────────────────────────────────────────

func createRoom(rs *RoomStore) string {
	code := generateRoomCode()
	rs.Create(code, RoomTTL*time.Second)
	return code
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

// POST /rooms
// Generates a room code, stores it in the room store, returns the code.
func handleCreateRoom(rs *RoomStore) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		code := createRoom(rs)

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{
			"code": code,
		})
	}
}

// GET /rooms/:code
// Validates room exists, returns member count and full status.
// Member count comes from the Hub — the room store does not track live membership.
func handleGetRoom(rs *RoomStore, hub *Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		// Extract code from path — /rooms/:code
		code := strings.TrimPrefix(r.URL.Path, "/rooms/")
		code = strings.ToUpper(strings.TrimSpace(code))

		if !validRoomCode(code) {
			http.Error(w, "Invalid room code", http.StatusBadRequest)
			return
		}

		if !rs.Exists(code) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"exists": false,
			})
			return
		}

		// Live member count comes from Hub — not the room store
		memberCount := hub.roomMemberCount(code)
		full := memberCount >= MaxRoomMembers

		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(map[string]interface{}{
			"exists":      true,
			"memberCount": memberCount,
			"full":        full,
		})
	}
}