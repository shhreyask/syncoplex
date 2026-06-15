package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"time"
)

// ── Session Data ──────────────────────────────────────────────────────────────

type Session struct {
	UserID   string
	Name     string
	RoomCode string
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
// Retrieves and deletes the session (one-time use), then issues a fresh
// token for the next potential reconnect window.
// Returns the restored session and the new token.

func reconnectSession(ss *SessionStore, token string) (*Session, string, error) {
	s := ss.Retrieve(token)
	if s == nil {
		// Token expired or never existed — caller treats this as a fresh join
		return nil, "", nil
	}

	// Issue a new token for the next reconnect window
	newToken, err := generateToken()
	if err != nil {
		return nil, "", err
	}

	return s, newToken, nil
}

// ── Write Session on Disconnect ───────────────────────────────────────────────
//
// Called from dropClient on the hub goroutine. Writes the session to the
// SessionStore — this is when the reconnect clock starts.

func writeSessionOnDisconnect(ss *SessionStore, client *Client) {
	if client.sessionToken == "" {
		return
	}
	ss.Store(client.sessionToken, Session{
		UserID:   client.userId,
		Name:     client.name,
		RoomCode: client.roomCode,
	}, SessionTTL*time.Second)
}