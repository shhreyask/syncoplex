package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
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

// Step 1 — rate-limit fields added to Client
type Client struct {
	userId          string
	name            string
	roomCode        string
	sessionToken    string // held in memory; written to Redis only on disconnect
	isReconnect     bool
	conn            *websocket.Conn
	send            chan []byte
	hub             *Hub
	lastSyncWindow  int64 // unix ms — start of current 1-second rate-limit window
	syncCount       int   // commands received in the current window
}

type Message struct {
	roomCode     string
	senderUserId string
	data         []byte
}


type RoomPlaybackState struct {
	LastRecordedPosition float64 
	RecordedAt           int64   
	IsPlaying            bool    
}


type Hub struct {
	mu             sync.RWMutex
	rooms          map[string]map[string]*Client   
	hostIds        map[string]string               
	playbackStates map[string]RoomPlaybackState    
	rdb            *redis.Client                   
	register       chan *Client
	unregister     chan *Client
	broadcast      chan *Message
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
		rooms:          make(map[string]map[string]*Client),
		hostIds:        make(map[string]string),
		playbackStates: make(map[string]RoomPlaybackState),
		rdb:            rdb,
		register:       make(chan *Client),
		unregister:     make(chan *Client),
		broadcast:      make(chan *Message, 256),
	}
}

// ── Hub Run Loop ──────────────────────────────────────────────────────────────
//
// Single goroutine. Owns rooms and hostIds maps exclusively.
// Nothing else ever reads or writes these maps.

func (h *Hub) run() {
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case client := <-h.register:
			h.handleRegister(client)

		case client := <-h.unregister:
			h.handleUnregister(client)

		case msg := <-h.broadcast:
			h.handleBroadcast(msg)

		case <-ticker.C:
			h.handleHeartbeat()
		}
	}
}

// ── Register ──────────────────────────────────────────────────────────────────

func (h *Hub) handleRegister(client *Client) {
	ctx := context.Background()

	h.mu.Lock()

	// Initialise room map if first member
	if _, ok := h.rooms[client.roomCode]; !ok {
		h.rooms[client.roomCode] = make(map[string]*Client)
	}

	room := h.rooms[client.roomCode]

	// Authoritative cap check — atomic with the insert below.
	// Reconnecting clients are exempt: they are reclaiming an existing slot.
	if !client.isReconnect && len(room) >= MaxRoomMembers {
		h.mu.Unlock()
		client.conn.WriteMessage(websocket.TextMessage,
			makeEnvelope("error", map[string]string{
				"code":    "ROOM_FULL",
				"message": "Room is full",
			}))
		close(client.send)
		client.conn.Close()
		return
	}

	room[client.userId] = client

	isFirstMember := len(room) == 1

	h.mu.Unlock()
	// Lock released — all Redis calls and sends happen outside it.

	// First member becomes host — overwrite the Redis "pending" placeholder
	if isFirstMember {
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

	h.mu.RLock()
	state, exists := h.playbackStates[client.roomCode]
	h.mu.RUnlock()

	if exists {
		now := time.Now().UnixMilli()
		position := state.LastRecordedPosition
		if state.IsPlaying {
			elapsed := float64(now-state.RecordedAt) / 1000.0
			position = position + elapsed
		}
		// Compute position locally for this send — do NOT persist the rebase.
		client.send <- makeEnvelope("sync_state", map[string]interface{}{
			"action":    "seek",
			"position":  position,
			"isPlaying": state.IsPlaying,
		})
	}

	// Broadcast to everyone else in the room
	msg := makeEnvelope(func() string {
		if client.isReconnect {
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
	room, ok := h.rooms[client.roomCode]
	if !ok {
		return
	}

	// Guard — only unregister if this is still the active client for this userId
	// A reconnect may have already replaced the client pointer
	if existing, exists := room[client.userId]; !exists || existing != client {
		return
	}

	h.dropClient(room, client)
}

// ── Broadcast ─────────────────────────────────────────────────────────────────

func (h *Hub) handleBroadcast(msg *Message) {
	room, ok := h.rooms[msg.roomCode]
	if !ok {
		return
	}

	var toDrop []*Client
	for _, client := range room {
		if client.userId == msg.senderUserId {
			continue // never echo back to sender
		}
		select {
		case client.send <- msg.data:
			// Delivered to buffer — Hub moves on immediately
		default:
			// Buffer full — client is too slow or dead — drop it.
			toDrop = append(toDrop, client)
		}
	}

	for _, client := range toDrop {
		h.dropClient(room, client)
	}
}

// ── Broadcast Helpers ─────────────────────────────────────────────────────────

func (h *Hub) broadcastToRoom(roomCode string, data []byte) {
	room, ok := h.rooms[roomCode]
	if !ok {
		return
	}

	var toDrop []*Client
	for _, client := range room {
		select {
		case client.send <- data:
		default:
			toDrop = append(toDrop, client)
		}
	}

	for _, client := range toDrop {
		h.dropClient(room, client)
	}
}

func (h *Hub) broadcastToOthers(roomCode, excludeUserId string, data []byte) {
	room, ok := h.rooms[roomCode]
	if !ok {
		return
	}

	var toDrop []*Client
	for _, client := range room {
		if client.userId == excludeUserId {
			continue
		}
		select {
		case client.send <- data:
		default:
			toDrop = append(toDrop, client)
		}
	}

	for _, client := range toDrop {
		h.dropClient(room, client)
	}
}

// ── Sync Helper ────────────────────────────────────────────────

func (h *Hub) handleSyncCommand(c *Client, raw json.RawMessage) {
	var p struct {
		Action   string  `json:"action"`
		Position float64 `json:"position"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return
	}

	// Validate action
	validActions := map[string]bool{"play": true, "pause": true, "seek": true}
	if !validActions[p.Action] {
		return
	}

	// Rate limit — max 5 sync commands per second per client
	// lastSyncWindow and syncCount are read/written only in readPump — no mutex needed
	now := time.Now().UnixMilli()
	if now-c.lastSyncWindow > 1000 {
		c.lastSyncWindow = now
		c.syncCount = 0
	}
	c.syncCount++
	if c.syncCount > 5 {
		return
	}

	h.mu.Lock()
	state, exists := h.playbackStates[c.roomCode]
	if !exists {
		state = RoomPlaybackState{
			LastRecordedPosition: 0,
			RecordedAt:           now,
			IsPlaying:            false,
		}
	}

	var broadcastPosition float64
	var broadcastIsPlaying bool

	switch p.Action {
	case "play":
		// Silent drop if already playing
		if state.IsPlaying {
			h.mu.Unlock()
			return
		}
		broadcastPosition = state.LastRecordedPosition
		state.RecordedAt = now
		state.IsPlaying = true
		broadcastIsPlaying = true

	case "pause":
		// Silent drop if already paused
		if !state.IsPlaying {
			h.mu.Unlock()
			return
		}
		elapsed := float64(now-state.RecordedAt) / 1000.0
		state.LastRecordedPosition = state.LastRecordedPosition + elapsed
		state.RecordedAt = now
		state.IsPlaying = false
		broadcastPosition = state.LastRecordedPosition
		broadcastIsPlaying = false

	case "seek":
		if p.Position < 0 || p.Position >= 86400 {
			h.mu.Unlock()
			return
		}
		state.LastRecordedPosition = p.Position
		state.RecordedAt = now
		// isPlaying remains unchanged
		broadcastPosition = p.Position
		broadcastIsPlaying = state.IsPlaying
	}

	h.playbackStates[c.roomCode] = state
	h.mu.Unlock()

	// Broadcast to all clients including sender
	h.broadcastToRoom(c.roomCode, makeEnvelope("sync_command", map[string]interface{}{
		"action":    p.Action,
		"position":  broadcastPosition,
		"isPlaying": broadcastIsPlaying,
	}))
}

// ── Session Write on Disconnect ───────────────────────────────────────────────

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

func (h *Hub) dropClient(room map[string]*Client, client *Client) {
	ctx := context.Background()
	writeSessionOnDisconnect(ctx, h.rdb, client)

	h.mu.Lock()
	delete(room, client.userId)
	remaining := len(room)
	if remaining == 0 {
		delete(h.rooms, client.roomCode)
		delete(h.hostIds, client.roomCode)
		delete(h.playbackStates, client.roomCode)
	}
	h.mu.Unlock()

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

	// Room is empty — let Redis TTL expire the key after 5 minutes
	if remaining == 0 {
		h.rdb.Expire(ctx, "room:"+client.roomCode, 5*time.Minute)
	}
}

// ── Room Member Count ─────────────────────────────────────────────────────────

func (h *Hub) roomMemberCount(roomCode string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[roomCode])
}

// ── TTL Heartbeat ─────────────────────────────────────────────────────────────

func (h *Hub) handleHeartbeat() {
	ctx := context.Background()
	for roomCode, room := range h.rooms {
		if len(room) > 0 {
			if err := h.rdb.Expire(ctx, "room:"+roomCode, RoomTTL*time.Second).Err(); err != nil {
				log.Printf("hub: TTL heartbeat failed for room %s — %v", roomCode, err)
			}
		}
	}
}

// ── WebSocket Handler ─────────────────────────────────────────────────────────

func handleWebSocket(hub *Hub, rdb *redis.Client, upgrader websocket.Upgrader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Path[len("/ws/"):]
		code = sanitizeName(code)
		code = stringToUpper(code)

		if !validRoomCode(code) {
			http.Error(w, "Invalid room code", http.StatusBadRequest)
			return
		}

		ctx := r.Context()

		exists, err := roomExists(ctx, rdb, code)
		if err != nil || !exists {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		if hub.roomMemberCount(code) >= MaxRoomMembers {
			http.Error(w, "Room is full", http.StatusForbidden)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("hub: upgrade failed — %v", err)
			return
		}

		conn.SetReadLimit(MaxMessageSize)
		conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
			return nil
		})

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

		var userID, sessionToken string
		var isReconnect bool

		if joinPayload.SessionToken != "" {
			session, newToken, err := reconnectSession(ctx, rdb, joinPayload.SessionToken)
			if err != nil {
				log.Printf("hub: session retrieve error — %v", err)
			}
			if session != nil && session.RoomCode == code {
				userID = session.UserID
				sessionToken = newToken
				name = session.Name
				isReconnect = true
			}
		}

		if userID == "" {
			uid, token, err := newSession()
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
			sessionToken: sessionToken,
			isReconnect:  isReconnect,
			conn:         conn,
			send:         make(chan []byte, SendBufferSize),
			hub:          hub,
		}

		conn.WriteMessage(websocket.TextMessage,
			makeEnvelope("session_token", map[string]string{
				"sessionToken": sessionToken,
			}))

		hub.register <- client

		go client.writePump()
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
			break
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}

		// Step 3 — sync_command added alongside relay
		switch env.Type {
		case "relay":
			c.hub.broadcast <- &Message{
				roomCode:     c.roomCode,
				senderUserId: c.userId,
				data:         raw,
			}
		case "sync_command":
			c.hub.handleSyncCommand(c, env.Payload)
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