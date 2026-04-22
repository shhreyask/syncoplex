package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"log"
	"time"

	"github.com/redis/go-redis/v9"
)

// ── Session Data ──────────────────────────────────────────────────────────────

type Session struct {
	UserID   string `json:"userId"`
	Name     string `json:"name"`
	RoomCode string `json:"roomCode"`
}

// ── Token Generation ──────────────────────────────────────────────────────────

func generateToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("session: failed to generate token — %w", err)
	}
	return hex.EncodeToString(bytes), nil
}

func generateUserID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("session: failed to generate userId — %w", err)
	}
	// Format as UUID v4
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x",
		bytes[0:4], bytes[4:6], bytes[6:8], bytes[8:10], bytes[10:16]), nil
}

// ── Redis Store / Retrieve ────────────────────────────────────────────────────

func storeSession(ctx context.Context, rdb *redis.Client, token string, s Session) error {
	data, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("session: failed to marshal — %w", err)
	}

	key := "session:" + token
	if err := rdb.Set(ctx, key, data, SessionTTL*time.Second).Err(); err != nil {
		return fmt.Errorf("session: failed to store in Redis — %w", err)
	}

	return nil
}

func retrieveSession(ctx context.Context, rdb *redis.Client, token string) (*Session, error) {
	if token == "" {
		return nil, nil
	}

	key := "session:" + token
	data, err := rdb.Get(ctx, key).Bytes()
	if err == redis.Nil {
		// Token expired or never existed — not an error, treat as fresh join
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("session: Redis read failed — %w", err)
	}

	var s Session
	if err := json.Unmarshal(data, &s); err != nil {
		return nil, fmt.Errorf("session: failed to unmarshal — %w", err)
	}

	// Delete immediately — one-time use token
	if err := rdb.Del(ctx, key).Err(); err != nil {
		// Non-fatal — log and continue, session is still valid
		log.Printf("session: failed to delete token after retrieval — %v", err)
	}

	return &s, nil
}

// ── New Session ───────────────────────────────────────────────────────────────
//
// Called on every fresh connect (no token, or expired token).
// Returns the userId and sessionToken to send back to the client.

func newSession() (string, string, error) {
	userID, err := generateUserID()
	if err != nil {
		return "", "", err
	}

	token, err := generateToken()
	if err != nil {
		return "", "", err
	}

	return userID, token, nil
}

// ── Reconnect Session ─────────────────────────────────────────────────────────
//
// Called when a client presents a sessionToken on connect.
// Issues a fresh token for the next potential reconnect window.
// Returns the restored session and the new token.

func reconnectSession(ctx context.Context, rdb *redis.Client, token string) (*Session, string, error) {
	s, err := retrieveSession(ctx, rdb, token)
	if err != nil {
		return nil, "", err
	}
	if s == nil {
		// Token expired — caller treats this as a fresh join
		return nil, "", nil
	}

	// Issue a new token for the next reconnect window
	newToken, err := generateToken()
	if err != nil {
		return nil, "", err
	}

	return s, newToken, nil
}