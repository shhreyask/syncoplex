package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"strings"
	"time"

	"github.com/redis/go-redis/v9"
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

// ── Redis Room Operations ─────────────────────────────────────────────────────

func createRoom(ctx context.Context, rdb *redis.Client, hostID string) (string, error) {
	code := generateRoomCode()
	key := "room:" + code

	err := rdb.HSet(ctx, key, map[string]interface{}{
		"hostId":    hostID,
		"createdAt": time.Now().UTC().Format(time.RFC3339),
		"status":    "active",
	}).Err()
	if err != nil {
		return "", fmt.Errorf("rooms: failed to create room in Redis — %w", err)
	}

	if err := rdb.Expire(ctx, key, RoomTTL*time.Second).Err(); err != nil {
		return "", fmt.Errorf("rooms: failed to set TTL — %w", err)
	}

	return code, nil
}

func roomExists(ctx context.Context, rdb *redis.Client, code string) (bool, error) {
	exists, err := rdb.Exists(ctx, "room:"+code).Result()
	if err != nil {
		return false, fmt.Errorf("rooms: Redis check failed — %w", err)
	}
	return exists > 0, nil
}

func resetRoomTTL(ctx context.Context, rdb *redis.Client, code string) {
	// Fire and forget — TTL reset is not critical path
	// Errors are logged but never returned to caller
	if err := rdb.Expire(ctx, "room:"+code, RoomTTL*time.Second).Err(); err != nil {
		// Non-fatal — room will eventually expire naturally
		_ = err
	}
}

// ── HTTP Handlers ─────────────────────────────────────────────────────────────

// POST /rooms
// Generates a room code, writes to Redis, returns the code.
// hostId is a placeholder at this stage — the real userId is
// issued by session.go when the host opens the WebSocket.
func handleCreateRoom(rdb *redis.Client) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.Error(w, "Method not allowed", http.StatusMethodNotAllowed)
			return
		}

		ctx := r.Context()

		// Placeholder hostId — overwritten in hub.go when host joins via WebSocket
		code, err := createRoom(ctx, rdb, "pending")
		if err != nil {
			http.Error(w, "Failed to create room", http.StatusInternalServerError)
			return
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusCreated)
		json.NewEncoder(w).Encode(map[string]string{
			"code": code,
		})
	}
}

// GET /rooms/:code
// Validates room exists, returns member count and full status.
// Member count comes from the Hub — Redis does not track live membership.
func handleGetRoom(rdb *redis.Client, hub *Hub) http.HandlerFunc {
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

		ctx := r.Context()

		exists, err := roomExists(ctx, rdb, code)
		if err != nil {
			http.Error(w, "Failed to check room", http.StatusInternalServerError)
			return
		}

		if !exists {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]interface{}{
				"exists": false,
			})
			return
		}

		// Live member count comes from Hub — not Redis
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