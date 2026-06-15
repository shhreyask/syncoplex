package main

import (
	"sync"
	"time"
)

// ── Room Store ─────────────────────────────────────────────────────────────────
//
// Replaces room:{code} Redis hash. Tracks room existence and expiry only.
// Live membership is owned by Hub.rooms — RoomStore is the existence gate
// for HTTP handlers and the WebSocket upgrade path.
//
// Accessed by HTTP goroutines (Create, Exists) and the hub goroutine
// (ResetTTL via handleRegister, dropClient, handleHeartbeat).
// RWMutex synchronises these — Exists takes RLock, everything else takes Lock.

type RoomStore struct {
	mu    sync.RWMutex
	rooms map[string]time.Time // code → expiresAt
}

func newRoomStore() *RoomStore {
	rs := &RoomStore{
		rooms: make(map[string]time.Time),
	}
	go rs.cleanup()
	return rs
}

// Create adds a room code with the given TTL.
func (rs *RoomStore) Create(code string, ttl time.Duration) {
	rs.mu.Lock()
	rs.rooms[code] = time.Now().Add(ttl)
	rs.mu.Unlock()
}

// Exists returns true if the code is present and has not expired.
func (rs *RoomStore) Exists(code string) bool {
	rs.mu.RLock()
	expiresAt, ok := rs.rooms[code]
	rs.mu.RUnlock()
	return ok && time.Now().Before(expiresAt)
}

// ResetTTL extends the expiry for an existing room. No-op if the code
// does not exist — mirrors Redis EXPIRE on a missing key.
func (rs *RoomStore) ResetTTL(code string, ttl time.Duration) {
	rs.mu.Lock()
	if _, ok := rs.rooms[code]; ok {
		rs.rooms[code] = time.Now().Add(ttl)
	}
	rs.mu.Unlock()
}

// cleanup runs in a background goroutine. Sweeps expired entries every
// 60 seconds. At 1000 rooms the full scan takes microseconds.
func (rs *RoomStore) cleanup() {
	ticker := time.NewTicker(60 * time.Second)
	for range ticker.C {
		now := time.Now()
		rs.mu.Lock()
		for code, expiresAt := range rs.rooms {
			if now.After(expiresAt) {
				delete(rs.rooms, code)
			}
		}
		rs.mu.Unlock()
	}
}

// ── Session Store ──────────────────────────────────────────────────────────────
//
// Replaces session:{token} Redis strings. Written on disconnect (hub goroutine),
// read+deleted on reconnect (HTTP goroutine). One-time use — Retrieve atomically
// returns and deletes the entry.
//
// Stores the Session struct directly — no JSON marshal/unmarshal overhead.
//
// All three accessors (Store, Retrieve, cleanup) are writers — sync.Mutex is
// sufficient. No concurrent read-only path exists.

type sessionEntry struct {
	session   Session
	expiresAt time.Time
}

type SessionStore struct {
	mu       sync.Mutex
	sessions map[string]sessionEntry // token → entry
}

func newSessionStore() *SessionStore {
	ss := &SessionStore{
		sessions: make(map[string]sessionEntry),
	}
	go ss.cleanup()
	return ss
}

// Store writes a session entry with the given TTL. Called from the hub
// goroutine when a client disconnects — this is when the reconnect
// clock starts.
func (ss *SessionStore) Store(token string, s Session, ttl time.Duration) {
	ss.mu.Lock()
	ss.sessions[token] = sessionEntry{
		session:   s,
		expiresAt: time.Now().Add(ttl),
	}
	ss.mu.Unlock()
}

// Retrieve returns the session for the given token and deletes it
// atomically. Returns nil if the token does not exist or has expired.
// One-time use — a token can only be retrieved once.
func (ss *SessionStore) Retrieve(token string) *Session {
	ss.mu.Lock()
	entry, ok := ss.sessions[token]
	if ok {
		delete(ss.sessions, token)
	}
	ss.mu.Unlock()

	if !ok || time.Now().After(entry.expiresAt) {
		return nil
	}
	return &entry.session
}

// cleanup runs in a background goroutine. Sweeps expired entries every
// 60 seconds. At peak (4000 simultaneous disconnects), the scan takes
// microseconds.
func (ss *SessionStore) cleanup() {
	ticker := time.NewTicker(60 * time.Second)
	for range ticker.C {
		now := time.Now()
		ss.mu.Lock()
		for token, entry := range ss.sessions {
			if now.After(entry.expiresAt) {
				delete(ss.sessions, token)
			}
		}
		ss.mu.Unlock()
	}
}