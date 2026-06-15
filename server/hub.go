package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
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
	userId           string
	name             string
	roomCode         string
	sessionToken     string // held in memory; written to SessionStore only on disconnect
	isReconnect      bool
	conn             *websocket.Conn
	send             chan []byte
	hub              *Hub
	lastSyncWindow   time.Time // monotonic — start of current 1-second rate-limit window
	syncCount        int       // commands received in the current window
	fileVerifyValid  bool      // true only after server sends a valid verdict for this client
	webrtcSyncWindow time.Time // start of current 1-second WebRTC relay rate-limit window
	webrtcCount      int       // WebRTC relay messages received in the current window
}

type RoomPlaybackState struct {
	LastRecordedPosition float64
	RecordedAt           time.Time // time.Time preserves the monotonic clock reading;
	IsPlaying            bool      // use now.Sub(RecordedAt) for elapsed — immune to NTP steps
}

// RoomFileVerifyState holds the canonical hash for a room and tracks which
// users have been validated against it. Hub-goroutine-only — no mutex needed.
type RoomFileVerifyState struct {
	CanonicalHash   string
	CanonicalUserId string
	ValidatedUsers  map[string]bool // userId → true for all users who have passed
}

// SyncCommandPayload is the typed payload for both sync_command and sync_state
// messages. Using a struct instead of map[string]interface{} eliminates a
// heap allocation and a reflection-based marshal on every broadcast.
type SyncCommandPayload struct {
	Action    string  `json:"action"`
	Position  float64 `json:"position"`
	IsPlaying bool    `json:"isPlaying"`
}

// ── Event System ──────────────────────────────────────────────────────────────
//
// The Hub is an event loop. One goroutine, one inbox (h.events), sequential
// dispatch. All hub state mutations happen inside execute() on the hub goroutine.
//
// External goroutines (readPump, HTTP handlers) send typed events into h.events.
// Each event type carries exactly the data it needs — nothing more.
//
// The heartbeat ticker is handled directly in run() without going through
// h.events. The timer fires on the hub goroutine via ticker.C; sending a
// HeartbeatEvent into h.events would be a goroutine writing to its own channel
// — a deadlock if the buffer is full. Direct call is correct here.

type HubEvent interface {
	execute(h *Hub)
}

// RegisterEvent — a new client has completed the WebSocket handshake and is
// ready to join its room. Sent from handleWebSocket (HTTP goroutine).
type RegisterEvent struct {
	client *Client
}

// UnregisterEvent — a client's readPump has exited (disconnect or read error).
// Sent from readPump's deferred cleanup.
type UnregisterEvent struct {
	client *Client
}

// RelayEvent — a raw relay message to fan out to all room members except the
// sender. Replaces the old broadcast channel + Message struct.
type RelayEvent struct {
	roomCode     string
	senderUserId string
	data         []byte
}

// SyncEvent — a sync_command payload from a client's readPump, to be processed
// on the hub goroutine. Running handleSyncCommand here means h.rooms and
// h.playbackStates are safe to access without any mutex.
type SyncEvent struct {
	client *Client
	raw    json.RawMessage
}

// FileVerifyEvent — a file_fileVerify payload from a client's readPump.
// Hex has already been validated (length + charset) in readPump before enqueueing.
type FileVerifyEvent struct {
	client *Client
	hex    string
}

// WebRTCRelayEvent — a targeted WebRTC signaling message (offer, answer, or
// ICE candidate) from one peer to another. Routed to exactly one recipient
// in the same room. Rate-limited and sender-injected on the hub goroutine.
type WebRTCRelayEvent struct {
	client       *Client
	targetUserId string
	data         []byte
}

// MicStateEvent — broadcast mic mute/unmute to all other room members.
// senderUserId is server-injected so clients can't spoof identity.
type MicStateEvent struct {
	client *Client
	muted  bool
}

func (e *RegisterEvent)    execute(h *Hub) { h.handleRegister(e.client) }
func (e *UnregisterEvent)  execute(h *Hub) { h.handleUnregister(e.client) }
func (e *RelayEvent)       execute(h *Hub) { h.handleRelay(e) }
func (e *SyncEvent)        execute(h *Hub) { h.handleSyncCommand(e.client, e.raw) }
func (e *FileVerifyEvent)  execute(h *Hub) { h.handleFileVerifyCommand(e.client, e.hex) }
func (e *WebRTCRelayEvent) execute(h *Hub) { h.handleWebRTCRelay(e.client, e.targetUserId, e.data) }
func (e *MicStateEvent)    execute(h *Hub) { h.handleMicState(e.client, e.muted) }

// ── Hub ───────────────────────────────────────────────────────────────────────

type Hub struct {
	// mu guards h.rooms against concurrent reads from HTTP handler goroutines
	// (roomMemberCount). It is acquired for writes in handleRegister and
	// dropClient, and for reads in roomMemberCount only.
	//
	// h.hostIds, h.playbackStates, and h.fileVerifyStates are accessed
	// exclusively on the hub goroutine — they need no mutex.
	mu               sync.RWMutex
	rooms            map[string]map[string]*Client
	hostIds          map[string]string
	playbackStates   map[string]RoomPlaybackState
	fileVerifyStates map[string]RoomFileVerifyState
	roomStore        *RoomStore
	sessionStore     *SessionStore
	events           chan HubEvent // single inbox — replaces register, unregister, broadcast
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

func newHub(rs *RoomStore, ss *SessionStore) *Hub {
	return &Hub{
		rooms:            make(map[string]map[string]*Client),
		hostIds:          make(map[string]string),
		playbackStates:   make(map[string]RoomPlaybackState),
		fileVerifyStates: make(map[string]RoomFileVerifyState),
		roomStore:        rs,
		sessionStore:     ss,
		events:           make(chan HubEvent, 512),
	}
}

// ── Hub Run Loop ──────────────────────────────────────────────────────────────
//
// The hub goroutine. Owns rooms, hostIds, playbackStates, and fileVerifyStates
// exclusively. All mutations to these maps happen here, serialised through h.events.
//
// h.rooms writes also acquire h.mu so that roomMemberCount (HTTP goroutine)
// can read safely. All other hub state needs no synchronisation.

func (h *Hub) run() {
	ticker := time.NewTicker(30 * time.Minute)
	defer ticker.Stop()
	for {
		select {
		case ev := <-h.events:
			ev.execute(h)
		case <-ticker.C:
			// Direct call — already on the hub goroutine via ticker.C.
			// Never route this through h.events: a goroutine cannot safely
			// send to its own channel if the buffer happens to be full.
			h.handleHeartbeat()
		}
	}
}

// ── Register ──────────────────────────────────────────────────────────────────

func (h *Hub) handleRegister(client *Client) {
	// Lock only for the h.rooms write — synchronises with roomMemberCount.
	h.mu.Lock()
	if _, ok := h.rooms[client.roomCode]; !ok {
		h.rooms[client.roomCode] = make(map[string]*Client)
	}
	room := h.rooms[client.roomCode]

	// Authoritative cap check, atomic with the insert below.
	// Reconnecting clients are exempt — they are reclaiming an existing slot.
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

	// hostIds — hub goroutine only, no mutex needed.
	if isFirstMember {
		h.hostIds[client.roomCode] = client.userId
	}

	h.roomStore.ResetTTL(client.roomCode, RoomTTL*time.Second)

	client.send <- makeEnvelope("session_init", map[string]string{
		"userId": client.userId,
	})

	// Build member snapshot — safe to read the inner room map here; we are on
	// the hub goroutine and all writes to inner maps also happen here.
	members := make([]map[string]string, 0, len(room))
	for _, c := range room {
		if c.userId == client.userId {
			continue // exclude self
		}
		members = append(members, map[string]string{
			"userId": c.userId,
			"name":   c.name,
		})
	}
	client.send <- makeEnvelope("room_state", map[string]interface{}{
		"members": members,
	})

	msgType := "user_joined"
	if client.isReconnect {
		msgType = "user_reconnected"
	}
	h.broadcastToOthers(client.roomCode, client.userId, makeEnvelope(msgType, map[string]string{
		"userId": client.userId,
		"name":   client.name,
	}))
}

// ── Unregister ────────────────────────────────────────────────────────────────

func (h *Hub) handleUnregister(client *Client) {
	room, ok := h.rooms[client.roomCode]
	if !ok {
		return
	}
	// Stale pointer guard — a reconnect may have already replaced this client
	// in the room map before its old readPump's deferred unregister fires.
	if existing, exists := room[client.userId]; !exists || existing != client {
		return
	}
	h.dropClient(room, client)
}

// ── Relay ─────────────────────────────────────────────────────────────────────

func (h *Hub) handleRelay(e *RelayEvent) {
	room, ok := h.rooms[e.roomCode]
	if !ok {
		return
	}

	var toDrop []*Client
	for _, client := range room {
		if client.userId == e.senderUserId {
			continue // never echo back to sender
		}
		select {
		case client.send <- e.data:
		default:
			toDrop = append(toDrop, client)
		}
	}
	for _, client := range toDrop {
		h.dropClient(room, client)
	}
}

// ── WebRTC Relay ──────────────────────────────────────────────────────────────
//
// Targeted delivery: one sender → one recipient in the same room.
// Rate limited to 30 messages/second per sender — legitimate full-mesh
// negotiation for 6 users produces at most ~15 offers + ~15 answers + ~200
// ICE candidates spread across several seconds.
//
// senderUserId is always server-injected — a client cannot impersonate another.
// Both webrtcSyncWindow and webrtcCount are read/written only here on the hub
// goroutine. No mutex needed.

func (h *Hub) handleWebRTCRelay(sender *Client, targetUserId string, raw []byte) {
	now := time.Now()
	if now.Sub(sender.webrtcSyncWindow) > time.Second {
		sender.webrtcSyncWindow = now
		sender.webrtcCount = 0
	}
	sender.webrtcCount++
	if sender.webrtcCount > 30 {
		return // rate limit exceeded — drop silently
	}

	room, ok := h.rooms[sender.roomCode]
	if !ok {
		return
	}
	target, ok := room[targetUserId]
	if !ok {
		return // target not in room
	}
	if target == sender {
		return // self-send guard
	}

	// Parse the envelope to inject senderUserId into the payload.
	// The client sends:  { type, payload: { targetUserId, ... } }
	// The server strips targetUserId implicitly (not forwarded) and injects
	// senderUserId so the recipient knows who the message is from.
	var env struct {
		Type    string          `json:"type"`
		Payload json.RawMessage `json:"payload"`
	}
	if err := json.Unmarshal(raw, &env); err != nil {
		return
	}
	var payloadMap map[string]json.RawMessage
	if err := json.Unmarshal(env.Payload, &payloadMap); err != nil {
		return
	}
	senderIdBytes, _ := json.Marshal(sender.userId)
	payloadMap["senderUserId"] = senderIdBytes

	enrichedPayload, err := json.Marshal(payloadMap)
	if err != nil {
		return
	}
	out, err := json.Marshal(map[string]interface{}{
		"type":    env.Type,
		"payload": json.RawMessage(enrichedPayload),
	})
	if err != nil {
		return
	}

	select {
	case target.send <- out:
	default:
		h.dropClient(room, target)
	}
}

// ── Mic State Broadcast ───────────────────────────────────────────────────────

func (h *Hub) handleMicState(c *Client, muted bool) {
	h.broadcastToOthers(c.roomCode, c.userId, makeEnvelope("mic_state", map[string]interface{}{
		"senderUserId": c.userId,
		"muted":        muted,
	}))
}

// ── Broadcast Helpers ─────────────────────────────────────────────────────────
//
// Both helpers run only on the hub goroutine. h.rooms is safe to read without
// a lock — the only concurrent accessor is roomMemberCount (HTTP goroutine),
// which only reads.
// h.mu is acquired only when writing h.rooms (handleRegister, dropClient).

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

// ── Sync Command ──────────────────────────────────────────────────────────────
//
// Runs on the hub goroutine via SyncEvent.execute — h.rooms and h.playbackStates
// are safe to access with no lock. Rate-limit fields (lastSyncWindow, syncCount)
// live on the Client struct and are only ever touched here, so no additional
// synchronisation is needed for them either.
//
// RecordedAt is time.Time, not int64 unix ms. Go's time.Time preserves the
// monotonic clock reading; now.Sub(RecordedAt) is immune to NTP steps and
// wall-clock adjustments that would corrupt elapsed position calculations.

func (h *Hub) handleSyncCommand(c *Client, raw json.RawMessage) {
	// Server-side enforcement — a client who has not passed fileVerify
	// validation cannot affect room playback state regardless of what they send.
	// This gate is independent of the client-side UI gate in the lobby.
	if !c.fileVerifyValid {
		return
	}

	var p struct {
		Action   string  `json:"action"`
		Position float64 `json:"position"`
	}
	if err := json.Unmarshal(raw, &p); err != nil {
		return
	}

	// Zero-allocation validation — no map literal allocated per call.
	switch p.Action {
	case "play", "pause", "seek":
		// valid — continue
	default:
		return
	}

	// Rate limit — max 5 sync commands per second per client.
	// Compared with time.Duration arithmetic to stay on the monotonic clock.
	now := time.Now()
	if now.Sub(c.lastSyncWindow) > time.Second {
		c.lastSyncWindow = now
		c.syncCount = 0
	}
	c.syncCount++
	if c.syncCount > 5 {
		return
	}

	// playbackStates — hub goroutine only, no mutex.
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
		if state.IsPlaying {
			return // silent drop — already playing, no broadcast
		}
		// Position is unchanged — pause already recorded the canonical position.
		broadcastPosition = state.LastRecordedPosition
		state.RecordedAt = now
		state.IsPlaying = true
		broadcastIsPlaying = true

	case "pause":
		if !state.IsPlaying {
			return // silent drop — already paused, no broadcast
		}
		// Advance position by elapsed time since last record, then freeze it.
		// now.Sub(state.RecordedAt) uses the monotonic clock captured in now
		// and the monotonic reading stored in state.RecordedAt.
		state.LastRecordedPosition += now.Sub(state.RecordedAt).Seconds()
		state.RecordedAt = now
		state.IsPlaying = false
		broadcastPosition = state.LastRecordedPosition
		broadcastIsPlaying = false

	case "seek":
		if p.Position < 0 || p.Position >= MaxPlaybackPositionSeconds {
			return
		}
		state.LastRecordedPosition = p.Position
		state.RecordedAt = now
		// isPlaying is unchanged — seek does not affect play/pause state.
		broadcastPosition = p.Position
		broadcastIsPlaying = state.IsPlaying
	}

	h.playbackStates[c.roomCode] = state

	// Broadcast to all clients including the sender — the sender's video must
	// not respond until the server echo arrives (no local optimism).
	h.broadcastToRoom(c.roomCode, makeEnvelope("sync_command", SyncCommandPayload{
		Action:    p.Action,
		Position:  broadcastPosition,
		IsPlaying: broadcastIsPlaying,
	}))
}

// ── FileVerify Command ────────────────────────────────────────────────────────
//
// Runs on the hub goroutine via FileVerifyEvent.execute.
// h.fileVerifyStates is hub-goroutine-only — no mutex needed.

func (h *Hub) handleFileVerifyCommand(c *Client, hex string) {
	state := h.fileVerifyStates[c.roomCode] // zero value if not present

	var verdict string

	if state.CanonicalHash == "" {
		// Rule 1 — First fileVerify in becomes canonical.
		state.CanonicalHash = hex
		state.CanonicalUserId = c.userId
		if state.ValidatedUsers == nil {
			state.ValidatedUsers = make(map[string]bool)
		}
		state.ValidatedUsers[c.userId] = true
		c.fileVerifyValid = true
		verdict = "valid"

	} else if c.userId == state.CanonicalUserId {
		// Rule 3 — Canonical user is re-picking their file.
		delete(state.ValidatedUsers, c.userId)
		c.fileVerifyValid = false

		// Find a replacement canonical anchor from other validated users.
		promoted := false
		for uid := range state.ValidatedUsers {
			state.CanonicalUserId = uid
			// CanonicalHash stays the same — all validated users matched it.
			promoted = true
			break
		}

		if !promoted {
			// No other validated users — this user is alone; update canonical.
			state.CanonicalHash = hex
			state.CanonicalUserId = c.userId
			state.ValidatedUsers[c.userId] = true
			c.fileVerifyValid = true
			verdict = "valid"
		} else {
			if hex == state.CanonicalHash {
				state.ValidatedUsers[c.userId] = true
				c.fileVerifyValid = true
				verdict = "valid"
			} else {
				verdict = "mismatch"
			}
		}

	} else {
		// Rule 2 — Normal case: compare against canonical.
		if hex == state.CanonicalHash {
			state.ValidatedUsers[c.userId] = true
			c.fileVerifyValid = true
			verdict = "valid"
		} else {
			verdict = "mismatch"
		}
	}

	h.fileVerifyStates[c.roomCode] = state

	c.send <- makeEnvelope("fileVerify_verdict", map[string]string{
		"verdict": verdict,
	})

	if verdict == "valid" {
		if ps, exists := h.playbackStates[c.roomCode]; exists {
			position := ps.LastRecordedPosition
			if ps.IsPlaying {
				position += time.Since(ps.RecordedAt).Seconds()
			}
			c.send <- makeEnvelope("sync_state", SyncCommandPayload{
				Action:    "seek",
				Position:  position,
				IsPlaying: ps.IsPlaying,
			})
		}
	}
}

// ── Drop Client ───────────────────────────────────────────────────────────────

func (h *Hub) dropClient(room map[string]*Client, client *Client) {
	// Write session first — this is when the reconnect clock starts.
	writeSessionOnDisconnect(h.sessionStore, client)

	// Lock only for the h.rooms write — synchronises with roomMemberCount.
	// hostIds, playbackStates, and fileVerifyStates are hub-goroutine-only;
	// updated after unlock.
	h.mu.Lock()
	delete(room, client.userId)
	remaining := len(room)
	if remaining == 0 {
		delete(h.rooms, client.roomCode)
	}
	h.mu.Unlock()

	// Update fileVerify state for the departing client — before the
	// room-empty check so the canonical shifts correctly for remaining users.
	// No verdict is sent — the departing client is gone.
	if fpState, ok := h.fileVerifyStates[client.roomCode]; ok {
		delete(fpState.ValidatedUsers, client.userId)

		if client.userId == fpState.CanonicalUserId {
			// Canonical user left — promote any remaining validated user.
			promoted := false
			for uid := range fpState.ValidatedUsers {
				fpState.CanonicalUserId = uid
				// CanonicalHash unchanged — all validated users matched it.
				promoted = true
				break
			}
			if !promoted {
				// No remaining validated users — reset entirely.
				// Next file_fileVerify sets a fresh canonical.
				fpState.CanonicalHash = ""
				fpState.CanonicalUserId = ""
			}
		}
		h.fileVerifyStates[client.roomCode] = fpState
	}

	// Cleanup hub-goroutine-only maps outside the lock.
	if remaining == 0 {
		delete(h.hostIds, client.roomCode)
		delete(h.playbackStates, client.roomCode)
		delete(h.fileVerifyStates, client.roomCode)
	}

	close(client.send)

	// Broadcast user_left before host migration so clients process in order
	h.broadcastToRoom(client.roomCode, makeEnvelope("user_left", map[string]string{
		"userId": client.userId,
		"name":   client.name,
	}))

	// Host migration
	if client.userId == h.hostIds[client.roomCode] && len(room) > 0 {
		for _, next := range room {
			h.hostIds[client.roomCode] = next.userId
			h.broadcastToRoom(client.roomCode, makeEnvelope("host_changed", map[string]string{
				"userId": next.userId,
				"name":   next.name,
			}))
			break
		}
	}

	// TTL: reset to full duration while members remain; shrink to grace period when empty
	if remaining > 0 {
		h.roomStore.ResetTTL(client.roomCode, RoomTTL*time.Second)
	} else {
		h.roomStore.ResetTTL(client.roomCode, 5*time.Minute)
	}
}

// ── Room Member Count ─────────────────────────────────────────────────────────
//
// Called from HTTP handler goroutines. RLock synchronises with the Lock
// acquired during h.rooms writes in handleRegister and dropClient.

func (h *Hub) roomMemberCount(roomCode string) int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms[roomCode])
}

// ── TTL Heartbeat ─────────────────────────────────────────────────────────────
//
// Called directly from run()'s ticker case — never routed through h.events.
// Runs on the hub goroutine; h.rooms is safe to iterate with no lock.

func (h *Hub) handleHeartbeat() {
	for roomCode, room := range h.rooms {
		if len(room) > 0 {
			h.roomStore.ResetTTL(roomCode, RoomTTL*time.Second)
		}
	}
}

// ── WebSocket Handler ─────────────────────────────────────────────────────────

func handleWebSocket(hub *Hub, upgrader websocket.Upgrader) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		code := r.URL.Path[len("/ws/"):]
		code = sanitizeName(code)
		code = stringToUpper(code)

		if !validRoomCode(code) {
			http.Error(w, "Invalid room code", http.StatusBadRequest)
			return
		}

		if !hub.roomStore.Exists(code) {
			http.Error(w, "Room not found", http.StatusNotFound)
			return
		}

		// Enforce member cap before upgrading — reject at HTTP level so we
		// never burn a WebSocket upgrade on a connection we'll immediately close.
		if hub.roomMemberCount(code) >= MaxRoomMembers {
			http.Error(w, "Room is full", http.StatusForbidden)
			return
		}

		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			log.Printf("hub: upgrade failed — %v", err)
			return
		}

		// Per-connection constraints applied immediately on every connection.
		conn.SetReadLimit(MaxMessageSize)
		conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
		conn.SetPongHandler(func(string) error {
			conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
			return nil
		})

		// First message must be a join — read synchronously before registering
		// with the Hub so we have identity before any room events could arrive.
		_, raw, err := conn.ReadMessage()
		if err != nil {
			conn.Close()
			return
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil || env.Type != "join" {
			writeErrorAndClose(conn, "BAD_HANDSHAKE", "First message must be type join")
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
			writeErrorAndClose(conn, "BAD_NAME", "Display name is required")
			return
		}

		// Resolve identity — reconnect (token present and valid) or fresh join.
		var userID, sessionToken string
		var isReconnect bool

		if joinPayload.SessionToken != "" {
			session, newToken, err := reconnectSession(hub.sessionStore, joinPayload.SessionToken)
			if err != nil {
				log.Printf("hub: session retrieve error — %v", err)
			}
			if session != nil && session.RoomCode == code {
				// Valid reconnect — restore identity, issue a fresh token.
				userID = session.UserID
				sessionToken = newToken
				name = session.Name // always restore original name
				isReconnect = true
			}
		}

		if userID == "" {
			// Fresh join — generate identity and token.
			uid, token, err := newSession()
			if err != nil {
				log.Printf("hub: session create error — %v", err)
				writeErrorAndClose(conn, "INTERNAL", "Failed to create session")
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
			// fileVerifyValid starts false — every connect and reconnect
			// begins unvalidated regardless of previous session state.
		}

		// Send session token directly on the raw connection BEFORE registering
		// with the Hub — the client must store it before any room events arrive
		// (user_joined, room_state) so it can reconnect if it immediately drops.
		conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
		conn.WriteMessage(websocket.TextMessage,
			makeEnvelope("session_token", map[string]string{
				"sessionToken": sessionToken,
			}))
		conn.SetWriteDeadline(time.Time{}) // clear it; writePump manages its own

		hub.events <- &RegisterEvent{client: client}

		// writePump in its own goroutine — drains client.send at its own pace.
		// readPump blocks here until the client disconnects.
		go client.writePump()
		client.readPump()
	}
}

// ── Read Pump ─────────────────────────────────────────────────────────────────

func (c *Client) readPump() {
	defer func() {
		c.hub.events <- &UnregisterEvent{client: c}
		c.conn.Close()
	}()

	var (
		lastFileVerify  time.Time
		fileVerifyCount int
	)

	for {
		_, raw, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var env Envelope
		if err := json.Unmarshal(raw, &env); err != nil {
			continue
		}

		switch env.Type {
		case "relay":
			c.hub.events <- &RelayEvent{
				roomCode:     c.roomCode,
				senderUserId: c.userId,
				data:         raw,
			}
		case "sync_command":
			c.hub.events <- &SyncEvent{
				client: c,
				raw:    env.Payload,
			}
		case "file_fileVerify":
			var p struct {
				FileVerify string `json:"fileVerify"`
			}
			if err := json.Unmarshal(env.Payload, &p); err != nil {
				continue
			}
			if len(p.FileVerify) != 64 {
				continue
			}
			valid := true
			for _, ch := range p.FileVerify {
				if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
					valid = false
					break
				}
			}
			if !valid {
				continue
			}
			now := time.Now()
			if now.Sub(lastFileVerify) > time.Second {
				lastFileVerify = now
				fileVerifyCount = 0
			}
			fileVerifyCount++
			if fileVerifyCount > 3 {
				continue
			}
			c.hub.events <- &FileVerifyEvent{client: c, hex: p.FileVerify}

		case "webrtc_offer", "webrtc_answer", "ice_candidate":
			var p struct {
				TargetUserId string `json:"targetUserId"`
			}
			if err := json.Unmarshal(env.Payload, &p); err != nil {
				continue
			}
			if p.TargetUserId == "" || len(p.TargetUserId) > 64 {
				continue
			}
			c.hub.events <- &WebRTCRelayEvent{
				client:       c,
				targetUserId: p.TargetUserId,
				data:         raw,
			}

		case "mic_state":
			var p struct {
				Muted bool `json:"muted"`
			}
			if err := json.Unmarshal(env.Payload, &p); err != nil {
				continue
			}
			c.hub.events <- &MicStateEvent{client: c, muted: p.Muted}

		default:
			// Unknown type — drop silently.
		}
	}
}

// ── Write Pump ────────────────────────────────────────────────────────────────

func (c *Client) writePump() {
	pingTicker := time.NewTicker(((PongWait * time.Second) * 9) / 10) // ~54s
	defer func() {
		pingTicker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			if !ok {
				// Channel closed — send close frame.
				c.conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
				c.conn.WriteMessage(websocket.CloseMessage,
					websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
				return
			}
			c.conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
			if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
				return
			}
		case <-pingTicker.C:
			c.conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
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

func writeErrorAndClose(conn *websocket.Conn, code, message string) {
	conn.SetWriteDeadline(time.Now().Add(WriteWait * time.Second))
	conn.WriteMessage(websocket.TextMessage,
		makeEnvelope("error", map[string]string{
			"code":    code,
			"message": message,
		}))
	conn.Close()
}