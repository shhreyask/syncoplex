package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"time"

	"github.com/gorilla/websocket"
	"github.com/redis/go-redis/v9"
)

// ── Upgrader ──────────────────────────────────────────────────────────────────

func newUpgrader(allowedOrigin string) websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  1024,
		WriteBufferSize: 1024,
		CheckOrigin: func(r *http.Request) bool {
			return r.Header.Get("Origin") == allowedOrigin
		},
	}
}

// ── Types ─────────────────────────────────────────────────────────────────────

type Client struct {
	userId       string
	name         string
	roomCode     string
	sessionToken string // held in memory; written to Redis only on disconnect
	conn         *websocket.Conn
	send         chan []byte
	hub          *Hub
}

type Message struct {
	roomCode     string
	senderUserId string
	data         []byte
}

type Hub struct {
	rooms      map[string]map[string]*Client // roomCode → userId → *Client
	hostIds    map[string]string             // roomCode → userId (current host)
	rdb        *redis.Client                 // needed for session writes on drop
	register   chan *Client
	unregister chan *Client
	broadcast  chan *Message
}

// ── Envelope ──────────────────────────────────────────────────────────────────

type Envelope struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload"`
}

func makeEnvelope(msgType string, payload interface{}) []byte {
	p, _ := json.Marshal(payload)
	env, _ := json.Marshal(Envelope{Type: msgType, Payload: p})
	return env
}

// ── Hub Constructor ───────────────────────────────────────────────────────────

func newHub(rdb *redis.Client) *Hub {
	return &Hub{
		rooms:      make(map[string]map[string]*Client),
		hostIds:    make(map[string]string),
		rdb:        rdb,
		register:   make(chan *Client),
		unregister: make(chan *Client),
		broadcast:  make(chan *Message, 256),
	}
}

// ── Hub Run Loop ──────────────────────────────────────────────────────────────
//
// Single goroutine. Owns rooms and hostIds maps exclusively.
// Nothing else ever reads or writes these maps.

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.handleRegister(client)

		case client := <-h.unregister:
			h.handleUnregister(client)

		case msg := <-h.broadcast:
			h.handleBroadcast(msg)
		}
	}
}

// ── Register ──────────────────────────────────────────────────────────────────

func (h *Hub) handleRegister(client *Client) {
	ctx := context.Background()

	// Initialise room map if first member
	if _, ok := h.rooms[client.roomCode]; !ok {
		h.rooms[client.roomCode] = make(map[string]*Client)
	}

	room := h.rooms[client.roomCode]
	_, isReconnect := room[client.userId]
	room[client.userId] = client

	// First member becomes host — overwrite the Redis "pending" placeholder
	if len(room) == 1 {
		h.hostIds[client.roomCode] = client.userId
		h.rdb.HSet(ctx, "room:"+client.roomCode, "hostId", client.userId)
	}

	// Reset room TTL on join
	resetRoomTTL(ctx, h.rdb, client.roomCode)

	// Send session_init immediately
	client.send <- makeEnvelope("session_init", map[string]string{
		"userId": client.userId,
	})

	// Send current room state to the joining client
	members := make([]map[string]string, 0, len(room))
	for _, c := range room {
		if c.userId == client.userId {
			continue // exclude self from state snapshot
		}
		members = append(members, map[string]string{
			"userId": c.userId,
			"name":   c.name,
		})
	}
	client.send <- makeEnvelope("room_state", map[string]interface{}{
		"members": members,
	})

	// Broadcast to everyone else in the room
	msg := makeEnvelope(func() string {
		if isReconnect {
			return "user_reconnected"
		}
		return "user_joined"
	}(), map[string]string{
		"userId": client.userId,
		"name":   client.name,
	})
	h.broadcastToOthers(client.roomCode, client.userId, msg)
}

// ── Unregister ────────────────────────────────────────────────────────────────

func (h *Hub) handleUnregister(client *Client) {
	ctx := context.Background()
	room, ok := h.rooms[client.roomCode]
	if !ok {
		return
	}

	// Guard — only unregister if this is still the active client for this userId
	// A reconnect may have already replaced the client pointer
	if existing, exists := room[client.userId]; !exists || existing != client {
		return
	}

	// Write session to Redis NOW — this is when the reconnect clock starts.
	// The token was held in memory since connect; only at disconnect does it matter.
	writeSessionOnDisconnect(ctx, h.rdb, client)

	delete(room, client.userId)
	close(client.send)

	// Reset TTL on leave
	resetRoomTTL(ctx, h.rdb, client.roomCode)

	// Broadcast user_left before host migration so clients process in order
	h.broadcastToRoom(client.roomCode, makeEnvelope("user_left", map[string]string{
		"userId": client.userId,
		"name":   client.name,
	}))

	// Host migration
	if client.userId == h.hostIds[client.roomCode] && len(room) > 0 {
		for _, next := range room {
			h.hostIds[client.roomCode] = next.userId
			h.rdb.HSet(ctx, "room:"+client.roomCode, "hostId", next.userId)
			h.broadcastToRoom(client.roomCode, makeEnvelope("host_changed", map[string]string{
				"userId": next.userId,
				"name":   next.name,
			}))
			break
		}
	}

	// Room is empty — clean up in-memory, let Redis TTL expire the key after 5 minutes
	if len(room) == 0 {
		delete(h.rooms, client.roomCode)
		delete(h.hostIds, client.roomCode)
		h.rdb.Expire(ctx, "room:"+client.roomCode, 5*time.Minute)
	}
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

func (h *Hub) handleBroadcast(msg *Message) {
	room, ok := h.rooms[msg.roomCode]
	if !ok {
		return
	}
	for _, client := range room {
		if client.userId == msg.senderUserId {
			continue // never echo back to sender
		}
		select {
		case client.send <- msg.data:
			// Delivered to buffer — Hub moves on immediately
		default:
			// Buffer full — client is too slow or dead — drop it.
			// Write session now since handleUnregister will never be called for this client.
			writeSessionOnDisconnect(context.Background(), h.rdb, client)
			close(client.send)
			delete(room, client.userId)
		}
	}
}

// ── Broadcast Helpers ─────────────────────────────────────────────────────────

func (h *Hub) broadcastToRoom(roomCode string, data []byte) {
	room, ok := h.rooms[roomCode]
	if !ok {
		return
	}
	for _, client := range room {
		select {
		case client.send <- data:
		default:
			writeSessionOnDisconnect(context.Background(), h.rdb, client)
			close(client.send)
			delete(room, client.userId)
		}
	}
}

func (h *Hub) broadcastToOthers(roomCode, excludeUserId string, data []byte) {
	room, ok := h.rooms[roomCode]
	if !ok {
		return
	}
	for _, client := range room {
		if client.userId == excludeUserId {
			continue
		}
		select {
		case client.send <- data:
		default:
			writeSessionOnDisconnect(context.Background(), h.rdb, client)
			close(client.send)
			delete(room, client.userId)
		}
	}
}

// ── Session Write on Disconnect ───────��───────────────────────────────────────
//
// Called in handleUnregister and in every broadcast drop path.
// This is the single place where a session token is written to Redis —
// only when the client actually disconnects, starting the reconnect TTL clock.

func writeSessionOnDisconnect(ctx context.Context, rdb *redis.Client, client *Client) {
	if client.sessionToken == "" {
		return
	}
	s := Session{
		UserID:   client.userId,
		Name:     client.name,
		RoomCode: client.roomCode,
	}
	if err := storeSession(ctx, rdb, client.sessionToken, s); err != nil {
		log.Printf("hub: failed to write session on disconnect for %s — %v", client.userId, err)
	}
}

// ── Room Member Count (called from rooms.go) ──────────────────────────────────
//
// This is the only public-facing read of the rooms map.
// It is NOT called from the Hub goroutine — it reads the map from outside.
// Safe at Step 1 scale; a channel-based query can replace this in future steps
// if contention becomes measurable.

func (h *Hub) roomMemberCount(roomCode string) int {
	room, ok := h.rooms[roomCode]
	if !ok {
		return 0
	}
	return len(room)
}

// ── TTL Heartbeat ─────────────────────────────────────────────────────────────

func (h *Hub) ttlHeartbeat() {
	ticker := time.NewTicker(30 * time.Minute)
	for range ticker.C {
		ctx := context.Background()
		for roomCode, room := range h.rooms {
			if len(room) > 0 {
				if err := h.rdb.Expire(ctx, "room:"+roomCode, RoomTTL*time.Second).Err(); err != nil {
					log.Printf("hub: TTL heartbeat failed for room %s — %v", roomCode, err)
				}
			}
		}
	}
}

// ── WebSocket Handler ─────────────────────────────────────────────────────────

func handleWebSocket(hub *Hub, rdb *redis.Client, upgrader websocket.Upgrader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		// Extract room code from path — /ws/:code
		code := r.URL.Path[len("/ws/"):]
		code = sanitizeName(code) // trim whitespace
		code = stringToUpper(code)

		if !validRoomCode(code) {
			http.Error(w, "Invalid room code", http.StatusBadRequest)
			return
		}

		ctx := r.Context()

		// Room must exist in Redis before a WebSocket is accepted
		exists, err := roomExists(ctx, rdb, code)
		if err != nil || !exists {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		// Enforce member cap BEFORE upgrading — reject at HTTP level
		if hub.roomMemberCount(code) >= MaxRoomMembers {
			http.Error(w, "Room is full", http.StatusForbidden)
			return
		}

		// Upgrade to WebSocket
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("hub: upgrade failed — %v", err)
			return
		}

		// Per-connection constraints
		conn.SetReadLimit(MaxMessageSize)
		conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
			return nil
		})

		// Read the first message — must be a join
		_, raw, err := conn.ReadMessage()
		if err != nil {
			conn.Close()
			return
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil || env.Type != "join" {
			conn.WriteMessage(websocket.TextMessage,
				makeEnvelope("error", map[string]string{
					"code":    "BAD_HANDSHAKE",
					"message": "First message must be type join",
				}))
			conn.Close()
			return
		}

		var joinPayload struct {
			Name         string `json:"name"`
			SessionToken string `json:"sessionToken"`
		}
		if err := json.Unmarshal(env.Payload, &joinPayload); err != nil {
			conn.Close()
			return
		}

		name := sanitizeName(joinPayload.Name)
		if name == "" {
			conn.WriteMessage(websocket.TextMessage,
				makeEnvelope("error", map[string]string{
					"code":    "BAD_NAME",
					"message": "Display name is required",
				}))
			conn.Close()
			return
		}

		// Resolve identity — reconnect or fresh join
		var userID, sessionToken string

		if joinPayload.SessionToken != "" {
			session, newToken, err := reconnectSession(ctx, rdb, joinPayload.SessionToken)
			if err != nil {
				log.Printf("hub: session retrieve error — %v", err)
			}
			if session != nil && session.RoomCode == code {
				// Valid reconnect — restore identity, hold new token in memory
				userID = session.UserID
				sessionToken = newToken
				name = session.Name // always restore original name
			}
		}

		if userID == "" {
			// Fresh join — generate identity and token
			uid, token, err := newSession(name, code)
			if err != nil {
				log.Printf("hub: session create error — %v", err)
				conn.WriteMessage(websocket.TextMessage,
					makeEnvelope("error", map[string]string{
						"code":    "INTERNAL",
						"message": "Failed to create session",
					}))
				conn.Close()
				return
			}
			userID = uid
			sessionToken = token
		}

		client := &Client{
			userId:       userID,
			name:         name,
			roomCode:     code,
			sessionToken: sessionToken, // held in memory until disconnect
			conn:         conn,
			send:         make(chan []byte, SendBufferSize),
			hub:          hub,
		}

		// Send session token to client before registering with Hub
		// so the client can store it before any room events arrive
		conn.WriteMessage(websocket.TextMessage,
			makeEnvelope("session_token", map[string]string{
				"sessionToken": sessionToken,
			}))

		hub.register <- client

		// Start write pump in its own goroutine
		go client.writePump()

		// Read pump runs on the current goroutine — blocks until disconnect
		client.readPump()
	}
}

// ── Read Pump ─────────────────────────────────────────────────────────────────

func (c *Client) readPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			// Normal disconnect or read deadline exceeded — exit cleanly
			break
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			// Malformed message — drop silently, keep connection alive
			continue
		}

		// Only relay is handled in Step 1
		// Step 3 will add: play, pause, seek
		switch env.Type {
		case "relay":
			c.hub.broadcast <- &Message{
				roomCode:     c.roomCode,
				senderUserId: c.userId,
				data:         raw,
			}
		default:
			// Unknown type — drop silently
		}
	}
}

// ── Write Pump ────────────────────────────────────────────────────────────────

func (c *Client) writePump() {
	defer c.conn.Close()

	for msg := range c.send {
		c.conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			// Write failed — connection is dead
			break
		}
	}
}

// ── Utility ───────────────────────────────────────────────────────────────────

func stringToUpper(s string) string {
	result := make([]byte, len(s))
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c >= 'a' && c <= 'z' {
			result[i] = c - 32
		} else {
			result[i] = c
		}
	}
	return string(result)
}