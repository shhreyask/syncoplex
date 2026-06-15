# Go Backend — Complete Design Document

---

## What This Server Is

A single Go binary. No framework. No runtime. Two external dependencies. It starts in milliseconds, idles at ~10MB of memory, and its entire job is routing small JSON messages between browsers as fast as possible. It is not a media server, not a database, and not an application framework. It is a message router with room state.

Every architectural decision in this document flows from four principles:
- **Secure** — hostile inputs, bad actors, and flaky clients never affect other users
- **Fast** — the server adds microseconds of latency, never milliseconds
- **Smooth** — reconnects are seamless, membership state is always accurate, no ghost users
- **Light** — minimal memory, minimal complexity, zero external infrastructure

---

## Stack

```
Language        Go (latest stable)
WebSocket       github.com/gorilla/websocket
Env loading     github.com/joho/godotenv
TLS             Caddy (reverse proxy, auto Let's Encrypt)
```

Two dependencies. That is the entire external surface area of this server. No database, no cache layer, no external process to deploy alongside the binary.

---

## Architecture — Two Layers

```
┌──────────────────────────────────────────────────────────┐
│                      HTTP Layer                          │
│         POST /rooms          GET /rooms/:code            │
│         Security middleware stack on every request       │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│                   WebSocket Layer                        │
│       One persistent connection per user per session     │
│       Single message envelope for all event types        │
│       Hub goroutine owns all state via typed event loop  │
│       Buffered per-client write channels                 │
└──────────────────────────────────────────────────────────┘
```

Each layer has one responsibility and never bleeds into another. All state — room existence, session tokens, live membership, playback positions — lives in-memory. No external persistence layer.

---

## File Responsibilities

```
server/
├── main.go           Starts the server, wires routes, creates stores
├── config.go         Environment variables, constants, room cap, playback limits
├── store.go          RoomStore and SessionStore — in-memory maps with TTL expiry
├── rooms.go          Code generation, room creation, room validation
├── hub.go            Hub struct, event loop, all hub handlers, WebSocket handler, read/write pumps
├── session.go        Session token issuance, reconnect identity claims
├── turn.go           TURN credential fetching and caching
└── middleware.go     Rate limiting, security headers, CORS, input validation
```

Every file has one clear owner. None of them know about the internals of the others.

---

## Source of Truth — Everything In-Memory

```
┌─────────────────────────────────────────────────────────┐
│  Question                        │  Answer lives in     │
├──────────────────────────────────┼──────────────────────┤
│  Does this room exist?           │  RoomStore           │
│  Who is connected right now?     │  Hub (h.rooms)       │
│  Who is the current host?        │  Hub (h.hostIds)     │
│  What is the current room state? │  Hub (h.playback...) │
│  Route this message to whom?     │  Hub (h.rooms)       │
│  Can this user reconnect?        │  SessionStore        │
└──────────────────────────────────┴──────────────────────┘
```

The Hub is the sole source of truth for live membership. The RoomStore answers one question: "is this room code valid right now?" The SessionStore holds disconnected sessions for the 5-minute reconnect window. All three are in-memory maps with background cleanup — no external process, no serialization, no network round-trips.

On server restart, all state is lost. Users reconnect and create new rooms. This is accepted for v1 — the server is stateless enough that a restart is a clean slate, not a data loss event.

---

## In-Memory Stores

### RoomStore

```go
type RoomStore struct {
    mu    sync.RWMutex
    rooms map[string]time.Time  // code → expiresAt
}
```

One entry per created room code. Tracks existence and TTL only. Accessed by HTTP goroutines (Create, Exists) and the hub goroutine (ResetTTL). `RWMutex` synchronises these — `Exists` takes `RLock`, everything else takes `Lock`.

The value is just `time.Time`. The room store answers exactly one question: "is this code valid right now?" No metadata stored — host tracking is owned by `h.hostIds` on the hub goroutine.

A background goroutine sweeps expired entries every 60 seconds.

### SessionStore

```go
type SessionStore struct {
    mu       sync.Mutex
    sessions map[string]sessionEntry  // token → entry
}

type sessionEntry struct {
    session   Session    // stored directly — no JSON serialization
    expiresAt time.Time
}
```

Written on disconnect (hub goroutine), read+deleted on reconnect (HTTP goroutine). One-time use — `Retrieve` atomically returns and deletes the entry. All three accessors (Store, Retrieve, cleanup) are writers — `sync.Mutex` is sufficient. No concurrent read-only path exists.

Storing the `Session` struct directly eliminates `json.Marshal` on every disconnect and `json.Unmarshal` on every reconnect — two fewer allocations per reconnect cycle.

A background goroutine sweeps expired entries every 60 seconds.

### TTL Strategy

```
Room codes         6 hour TTL
                   Reset ONLY on: user join, user leave, 30-minute heartbeat
                   Never reset on relay messages — those are high frequency
                   Collapses to 5 minute TTL after a room empties

Session tokens     5 minute TTL
                   Written to SessionStore only when the client disconnects —
                   this is when the reconnect window actually opens. The token
                   is held in memory on the Client struct while the connection
                   is live.
                   Swept automatically by background cleanup, no manual deletion needed.
```

Resetting TTL on every relay message at 30 messages/second/connection would mean thousands of unnecessary map writes per minute. TTL is a lifecycle signal, not an activity ping.

The session token is intentionally **not** written to the SessionStore on connect. It only needs to exist during the window after a disconnect. The clock starts when it matters — at the moment of disconnect.

---

## Room Codes

```
WOLF-BEAR-482134
```

Two words from a curated list of 50 common animals + 6 random digits:

```
50 × 50 × 900,000 = 2.25 billion possible codes
```

Brute force is computationally unreasonable. Combined with rate limiting on the validation endpoint, room enumeration attacks are effectively impossible.

**Why not UUIDs?** UUIDs are for machines. Room codes are typed and shared verbally between friends.

---

## Room Member Cap

**Hard cap: 6 members per room.**

The cap exists because of WebRTC full mesh topology:

```
N people → N×(N-1)/2 peer connections

2 people  →  1 connection
4 people  →  6 connections
6 people  →  15 connections
10 people →  45 connections
```

Beyond 6, average home upload bandwidth and device CPU become real constraints.

### Three Layers of Enforcement

**Layer 1 — GET /rooms/:code response:**
```json
{ "exists": true, "memberCount": 4, "full": false }
```
The frontend shows "Room is full" before attempting a WebSocket connection. Count is read from the Hub's live in-memory map via `roomMemberCount()`.

**Layer 2 — WebSocket upgrade handler:**
```go
if hub.roomMemberCount(code) >= MaxRoomMembers {
    http.Error(w, "Room is full", http.StatusForbidden)
    return
}
```
A 403 at HTTP level is cheaper than establishing and immediately closing a WebSocket.

**Layer 3 — Hub handleRegister (final backstop):**
```go
if !client.isReconnect && len(room) >= MaxRoomMembers {
    // reject — close and signal error
}
```
The cap is re-checked atomically with the insert inside the Hub goroutine. Reconnecting clients bypass this check — they are reclaiming a slot that already existed.

---

## Session Tokens and Reconnection Identity

### The Problem

Without session tokens, every WebSocket connect generates a fresh userId. A tab blip means Alice gets a new userId. The room briefly shows two Alices. In Step 6, WebRTC peer connections are keyed to userId — a new userId forces full renegotiation with every peer, dropping camera feeds for seconds.

### The Solution

**First Connect:**
```
Client connects with no token
    │
    ▼
Server generates:
    userId        = UUID v4
    sessionToken  = crypto/rand 32 bytes, hex encoded

Token held in memory on Client struct — NOT written to SessionStore yet.

conn.WriteMessage → { type: "session_token", payload: { sessionToken } }
    ← sent on raw connection BEFORE Hub registration
    ← client stores this before any room events arrive

hub.events <- RegisterEvent
    Hub goroutine sends:
        client.send ← { type: "session_init", payload: { userId } }
        client.send ← { type: "room_state",   payload: { members: [...] } }
```

**On Disconnect:**
```
Hub calls dropClient(client)
    │
    ▼
session stored in SessionStore, 5 min TTL
    │
    ▼
Reconnect clock starts here — not at connect time.
```

**Reconnect (within 5 minutes):**
```
Client sends: { type: "join", payload: { name: "Alice", sessionToken: "abc..." } }
    │
    ├── Token valid in SessionStore →
    │       token deleted (one-time use, atomic with retrieval)
    │       fresh token issued, held in memory
    │       userId/name restored, isReconnect = true
    │       broadcast: user_reconnected (not user_joined)
    │       WebRTC peer connections survive intact
    │
    └── Token expired/missing →
            fresh join, new userId and token
```

**Why sessionStorage and not localStorage:**
```
sessionStorage  →  survives tab blip, network drop, browser refresh
                →  cleared when tab is intentionally closed
localStorage    →  persists forever, wrong semantics for an ephemeral session
```

---

## Host Role and Host Departure

Host in v1 is not a permission gate — **everyone in the room can control playback**. Host is simply the room creator, tracked in `h.hostIds` on the hub goroutine.

- Everyone can play/pause/seek — no host-only restrictions
- When the host disconnects, host role migrates automatically to the next connected member
- `user_left` is always broadcast before `host_changed` — clients process membership loss before any role change

---

## The Hub — Concurrency Model

### The Event Loop

The Hub is an event loop. One goroutine, one inbox (`h.events`), sequential dispatch. All hub state mutations happen on the hub goroutine — no locks needed for `h.hostIds`, `h.playbackStates`, or `h.fileVerifyStates`.

```go
type HubEvent interface {
    execute(h *Hub)
}
```

Seven event types:

| Event | Sent from | Handled by |
|---|---|---|
| `RegisterEvent{client}` | HTTP goroutine (handleWebSocket) | `handleRegister` |
| `UnregisterEvent{client}` | readPump goroutine (deferred) | `handleUnregister` |
| `RelayEvent{roomCode, senderUserId, data}` | readPump goroutine | `handleRelay` |
| `SyncEvent{client, raw}` | readPump goroutine | `handleSyncCommand` |
| `FileVerifyEvent{client, hex}` | readPump goroutine | `handleFileVerifyCommand` |
| `WebRTCRelayEvent{client, targetUserId, data}` | readPump goroutine | `handleWebRTCRelay` |
| `MicStateEvent{client, muted}` | readPump goroutine | `handleMicState` |

The run loop:

```go
func (h *Hub) run() {
    ticker := time.NewTicker(30 * time.Minute)
    defer ticker.Stop()
    for {
        select {
        case ev := <-h.events:
            ev.execute(h)
        case <-ticker.C:
            h.handleHeartbeat() // direct call — already on hub goroutine, no channel crossing needed
        }
    }
}
```

**Why the heartbeat is a direct call and not a HeartbeatEvent:** the ticker fires on the hub goroutine via `ticker.C`. Sending a `HeartbeatEvent` into `h.events` would be a goroutine writing to its own channel — a deadlock if the buffer is full. Direct call is correct here.

**Why one channel replaces three:** the old design had `register chan *Client`, `unregister chan *Client`, and `broadcast chan *Message` — three separate inboxes for one entity that processes them on the same goroutine. One typed event channel eliminates the coupling and the priority question.

### Mutex Discipline

Three mutexes exist in the entire server. Each protects exactly one map against concurrent access from different goroutines:

```
h.mu (sync.RWMutex)
    Protects:  h.rooms writes ↔ roomMemberCount reads (HTTP goroutine)
    Acquired:  Lock in handleRegister, dropClient
               RLock in roomMemberCount only

RoomStore.mu (sync.RWMutex)
    Protects:  room existence map
    Acquired:  Lock in Create, ResetTTL, cleanup
               RLock in Exists only

SessionStore.mu (sync.Mutex)
    Protects:  session token map
    Acquired:  Lock in Store, Retrieve, cleanup
    (No RLock — all accessors are writers)
```

Everything else needs no synchronisation:

```
No mutex for:    h.hostIds          (hub goroutine only)
                 h.playbackStates   (hub goroutine only)
                 h.fileVerifyStates (hub goroutine only)
                 Client rate-limit fields (hub goroutine only)
```

### Data Structures

```go
type Client struct {
    userId           string
    name             string
    roomCode         string
    sessionToken     string          // held in memory; written to SessionStore only on disconnect
    isReconnect      bool
    conn             *websocket.Conn
    send             chan []byte      // buffered — Hub never blocks on this client
    hub              *Hub
    lastSyncWindow   time.Time       // monotonic — start of current rate-limit window
    syncCount        int             // commands received in the current window
    fileVerifyValid  bool            // true only after server sends a valid verdict
    webrtcSyncWindow time.Time       // start of current 1-second WebRTC relay rate-limit window
    webrtcCount      int             // WebRTC relay messages received in the current window
}

type RoomPlaybackState struct {
    LastRecordedPosition float64
    RecordedAt           time.Time  // time.Time preserves the monotonic clock reading
    IsPlaying            bool       // elapsed = now.Sub(RecordedAt).Seconds() — NTP-immune
}

// SyncCommandPayload is used for both sync_command and sync_state messages.
// Typed struct instead of map[string]interface{} — zero heap allocation per broadcast.
type SyncCommandPayload struct {
    Action    string  `json:"action"`
    Position  float64 `json:"position"`
    IsPlaying bool    `json:"isPlaying"`
}

type Hub struct {
    mu               sync.RWMutex
    rooms            map[string]map[string]*Client
    hostIds          map[string]string
    playbackStates   map[string]RoomPlaybackState
    fileVerifyStates map[string]RoomFileVerifyState
    roomStore        *RoomStore
    sessionStore     *SessionStore
    events           chan HubEvent   // single inbox, buffered (512)
}
```

**Why `RoomPlaybackState.RecordedAt` is `time.Time` not `int64`:** Go's `time.Time` preserves the monotonic clock reading captured at `time.Now()`. All elapsed calculations use `now.Sub(state.RecordedAt)` which operates on the monotonic component, making them immune to NTP corrections and wall-clock adjustments that would corrupt position calculations.

### Goroutine Topology

```
┌─────────────────────────────────────────────┐
│  Hub Goroutine  (1, runs for server lifetime)│
│  Owns all hub state exclusively              │
│  Processes events from h.events sequentially │
│  Heartbeat via direct ticker.C case          │
└─────────────────────────────────────────────┘

Background cleanup (2 goroutines, one per store):
┌──────────────┐      ┌──────────────┐
│  RoomStore   │      │ SessionStore │
│  cleanup     │      │ cleanup      │
│  ticker: 60s │      │ ticker: 60s  │
└──────────────┘      └──────────────┘

Per connected user (2 goroutines each):
┌──────────────┐      ┌──────────────┐
│  readPump    │      │  writePump   │
│              │      │              │
│  Blocks on   │      │  Blocks on   │
│  WebSocket   │      │  send chan   │
│  read        │      │              │
│  Sends typed │      │  Writes to   │
│  HubEvents   │      │  WebSocket   │
│  to h.events │      │  conn        │
└──────────────┘      └──────────────┘
```

### The Critical Broadcast Pattern

The Hub **never writes to a WebSocket directly.** It puts messages into each client's buffered `send` channel and moves on immediately. Clients whose buffers are full are collected into a `toDrop` slice and disconnected after the broadcast loop completes:

```go
for _, client := range room {
    select {
    case client.send <- data:
        // Delivered to buffer — Hub moves on immediately
    default:
        // Buffer full — client is too slow or dead
        toDrop = append(toDrop, client)
    }
}
for _, client := range toDrop {
    h.dropClient(room, client)
}
```

The `select` with `default` is the most important detail in the entire codebase. A slow or dead client never stalls the Hub. Every other room and every other user is completely unaffected.

### The Stale Client Guard

When a client reconnects, the new `*Client` pointer replaces the old one in the room map before the old readPump finishes. Without a guard, the old pump's deferred `UnregisterEvent` would evict the new connection:

```go
func (h *Hub) handleUnregister(client *Client) {
    room, ok := h.rooms[client.roomCode]
    if !ok { return }
    if existing, exists := room[client.userId]; !exists || existing != client {
        return // stale pointer — a reconnect already replaced this client
    }
    h.dropClient(room, client)
}
```

---

## Sync Engine — Server Side

### Room Playback State

One `RoomPlaybackState` per room, stored in `h.playbackStates` on the Hub. Hub-goroutine-only — no mutex needed.

```
State fields:
    LastRecordedPosition float64    canonical position at RecordedAt
    RecordedAt           time.Time  when this position was recorded (monotonic)
    IsPlaying            bool       true = playing, false = paused
```

**Initialisation:** written on the first `sync_command` received for a room with no existing playback state. Defaults to position 0, paused.

**Cleanup:** deleted in `dropClient` when the room empties — prevents unbounded map growth on a long-running server with many transient rooms.

### Rate Limiting

Max 5 sync commands per second per client. Enforced in `handleSyncCommand` before any state mutation:

```
lastSyncWindow  time.Time   start of the current 1-second window (monotonic)
syncCount       int         commands received in the current window
```

Both fields live on `Client` and are read/written only in `handleSyncCommand`, which runs on the hub goroutine. No mutex needed.

Rate comparison uses `now.Sub(c.lastSyncWindow) > time.Second` — monotonic arithmetic, immune to clock adjustments.

### Command Processing

```
play  →  silent drop if already playing
         broadcastPosition = LastRecordedPosition (unchanged — pause recorded it)
         RecordedAt = now, IsPlaying = true

pause →  silent drop if already paused
         elapsed = now.Sub(RecordedAt).Seconds()
         LastRecordedPosition += elapsed  ← advance lazily
         RecordedAt = now, IsPlaying = false
         broadcastPosition = LastRecordedPosition

seek  →  validate: 0 ≤ position < MaxPlaybackPositionSeconds
         LastRecordedPosition = position
         RecordedAt = now
         IsPlaying unchanged
         broadcastPosition = position
```

All broadcasts go to every client in the room **including the sender** — the sender's video must not respond until the server echo arrives (no local optimism).

### Late Joiner — sync_state

When a client receives a valid file verification verdict and a `RoomPlaybackState` exists for the room, the Hub sends a `sync_state` message to that client:

```go
position := state.LastRecordedPosition
if state.IsPlaying {
    position += time.Since(state.RecordedAt).Seconds()
}
// Send computed position — do NOT persist. Original RecordedAt stays unchanged
// so all future elapsed calculations remain correct regardless of how many
// clients join.
client.send <- makeEnvelope("sync_state", SyncCommandPayload{
    Action:    "seek",
    Position:  position,
    IsPlaying: state.IsPlaying,
})
```

The `time.Since(state.RecordedAt)` call uses the monotonic component stored in `state.RecordedAt` — correct and NTP-immune.

### Action Validation

Zero-allocation switch instead of a map literal allocated per call:

```go
switch p.Action {
case "play", "pause", "seek":
    // valid
default:
    return
}
```

### Broadcast Payload

`SyncCommandPayload` struct replaces `map[string]interface{}` for all sync messages. One typed struct, compile-time safe, no per-broadcast map allocation on the hot path.

---

## Message Envelope

Every WebSocket message in both directions:

```json
{
    "type": "user_joined",
    "payload": {}
}
```

`type` routes the message. `payload` carries the data. Unknown types are dropped silently — never processed, never forwarded. This envelope is the contract between client and server for the lifetime of the project.

### Message Types

```
Client → Server:
    join              { name, sessionToken? }
    relay             { ...any... }              ← fanned out to room, sender excluded
    sync_command      { action, position? }      ← play | pause | seek
    file_fileVerify   { fileVerify }             ← 64 char hex string
    webrtc_offer      { targetUserId, ... }      ← SDP offer
    webrtc_answer     { targetUserId, ... }      ← SDP answer
    ice_candidate     { targetUserId, ... }      ← ICE candidate
    mic_state         { muted }                  ← mic mute/unmute

Server → Client:
    session_token       { sessionToken }             ← raw conn, BEFORE Hub registration
    session_init        { userId }
    room_state          { members: [{ userId, name }] }
    user_joined         { userId, name }
    user_left           { userId, name }
    user_reconnected    { userId, name }
    host_changed        { userId, name }
    sync_command        { action, position, isPlaying }  ← authoritative broadcast, all clients
    sync_state          { action, position, isPlaying }  ← on valid file verify verdict
    fileVerify_verdict  { verdict }                      ← targeted, requesting client only
    mic_state           { senderUserId, muted }          ← broadcast to room
    error               { code, message }
```

---

## HTTP Layer

### Two Endpoints

```
POST /rooms          Generate code, store in RoomStore, return code
GET  /rooms/:code    Validate room exists, return memberCount and full status
```

### Middleware Stack

```
Incoming Request
        │
        ▼
Security Headers      CSP, X-Frame-Options, nosniff, Referrer-Policy
        │
        ▼
CORS Validation       Only https://syncoplex.app — never wildcard
        │
        ▼
Rate Limiter          IP-based token bucket (per-route limits)
        │
        ▼
Handler               Business logic
```

Security headers and CORS are outermost — applied even to rejected requests.

---

## Security

### Transport

```
All traffic  →  TLS (HTTPS + WSS)
Caddy        →  syncoplex.app { reverse_proxy localhost:8080 }
Go server    →  plain HTTP internally, never exposed directly
```

### WebSocket Origin Validation

```go
CheckOrigin: func(r *http.Request) bool {
    return r.Header.Get("Origin") == allowedOrigin
}
```

Any connection not originating from the frontend is rejected at the upgrade handshake.

### Per-Connection Constraints

```go
conn.SetReadLimit(MaxMessageSize)                              // 16KB max message size
conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))  // drop silent connections
conn.SetPongHandler(func(string) error {                       // reset deadline on heartbeat
    conn.SetReadDeadline(time.Now().Add(PongWait * time.Second))
    return nil
})
```

### Rate Limits

```
POST /rooms              20 requests / IP / minute
GET  /rooms/:code        10 requests / IP / minute
/api/turn-credentials    30 requests / IP / minute
sync_command             5 commands / client / second   ← enforced in handleSyncCommand
WebRTC relay             30 messages / client / second  ← enforced in handleWebRTCRelay
file_fileVerify          3 messages / client / second   ← enforced in readPump
```

### HTTP Security Headers

```
Content-Security-Policy   default-src 'self';
                          connect-src 'self' wss://syncoplex.app;
                          media-src blob:;
                          script-src 'self';
                          style-src 'self'
X-Frame-Options           DENY
X-Content-Type-Options    nosniff
Referrer-Policy           strict-origin-when-cross-origin
Permissions-Policy        camera=*, microphone=*
```

### Input Validation

```
Room code        ^[A-Z]+-[A-Z]+-[0-9]+$  before any store access
Display name     strip HTML tags, trim whitespace, cap 32 Unicode chars
sync position    0 ≤ position < MaxPlaybackPositionSeconds (86400)
file_fileVerify  exactly 64 lowercase hex chars, validated in readPump
WebRTC target    non-empty, max 64 chars
Message type     unknown types dropped silently
Message size     hard cap 16KB via SetReadLimit
```

### Dependency Auditing

```bash
govulncheck ./...    ← run before every deploy
```

---

## The Join Flow — End to End

```
1. Host opens app
   POST /rooms
   ← { code: "WOLF-BEAR-482134" }
   RoomStore: Create("WOLF-BEAR-482134", 6h TTL)
   Browser navigates to /room/WOLF-BEAR-482134

2. Host enters name, clicks Join
   WebSocket → wss://syncoplex.app/ws/WOLF-BEAR-482134
   Origin validated ← rejected if not frontend
   Room existence checked via RoomStore.Exists ← 404 if missing
   Member count checked via Hub ← 403 if full
   Sends: { type: "join", payload: { name: "Host" } }

   Server:
   Generates userId + sessionToken
   Token held in memory on Client struct — NOT written to SessionStore
   conn.WriteMessage → { type: "session_token", ... }  ← before Hub registration
   hub.events <- RegisterEvent
   Hub: hostId set for this room
   Hub: client.send ← session_init { userId }
   Hub: client.send ← room_state   { members: [] }

3. Friend receives code, opens app
   GET /rooms/WOLF-BEAR-482134
   ← { exists: true, memberCount: 1, full: false }

4. Friend enters name, clicks Join
   WebSocket → same flow as step 2
   Hub: client.send ← room_state { members: [{ host }] }
   Hub: broadcastToOthers → user_joined { userId, name: "Alice" }

5. Alice's network blips
   readPump exits → hub.events <- UnregisterEvent
   Hub: stale pointer guard passes
   Hub: dropClient
     → writeSessionOnDisconnect: session stored in SessionStore, 5 min TTL
     → delete alice from room (under h.mu.Lock)
     → delete playbackStates entry if room empties
     → close alice.send
     → roomStore.ResetTTL
     → broadcastToRoom: user_left { userId }
     → no host migration (alice is not host)

   Alice reconnects automatically
   Sends: { type: "join", payload: { name: "Alice", sessionToken: "abc..." } }
   Token found in SessionStore → deleted atomically, fresh token issued, isReconnect = true
   hub.events <- RegisterEvent
   Hub: cap check bypassed (isReconnect)
   Hub: client.send ← session_init, room_state
   Hub: broadcastToOthers → user_reconnected (NOT user_joined)

6. Host closes tab
   Hub: dropClient
     → writeSessionOnDisconnect
     → delete host from room
     → broadcastToRoom: user_left
     → host migration: next member → hostIds updated, broadcastToRoom host_changed

7. Last person leaves
   Hub: dropClient → room empties
   Hub: delete h.rooms[roomCode] (under h.mu.Lock)
   Hub: delete h.hostIds[roomCode], h.playbackStates[roomCode],
        h.fileVerifyStates[roomCode] (after unlock, hub goroutine only)
   RoomStore: TTL collapsed to 5 minutes → cleaned up by background sweep
```

---

## Performance Profile

### Message Latency

```
WebSocket message received
    → readPump receives bytes              ~microseconds
    → sends HubEvent to h.events          ~microseconds  (non-blocking)
    → Hub goroutine executes event        ~microseconds  (map lookup + chan sends)
    → writePump writes to WebSocket       ~microseconds
    ──────────────────────────────────────────────────
    Total server processing               < 1ms

Network latency between users dominates entirely.
The server is never the bottleneck.
```

### Memory at 1000 Concurrent Rooms (4 users each)

```
Go runtime baseline                     ~4MB
Hub maps (rooms, hosts, playback, etc)  ~10MB
8000 goroutines × 4KB stack             ~32MB
Send channel buffers (256 × ~1KB)       ~50MB
RoomStore (1000 entries)                ~0.1MB
SessionStore (worst case: 4000 entries) ~0.5MB
────────────────────────────────────────────
Total                                   ~97MB
```

A single $5/month VPS with 1 GB RAM handles this with room to spare.

### Store Operation Cost

```
Per room create       1 map write (RoomStore, under Lock)
Per join              1 map read  (RoomStore, under RLock) + 1 map write (ResetTTL, under Lock)
Per leave             1 map write (SessionStore, under Lock) + 1 map write (ResetTTL, under Lock)
Per relay message     0 store operations
Per sync_command      0 store operations
Every 30 minutes      N map writes (N = active rooms, ResetTTL under Lock)
Every 60 seconds      2 cleanup sweeps (one per store, under Lock)
```

All operations are in-memory map lookups — microseconds, not milliseconds. No network round-trips, no serialization.

---

## What The Server Deliberately Does Not Do

| Thing | Reason |
|---|---|
| Handle video or audio bytes | P2P WebRTC — server is never in the media path |
| Store user data | No database, no privacy surface |
| Authenticate users | Room code is the auth — friction is the enemy |
| Know what movie is playing | Completely irrelevant to the server |
| Use an external database or cache | In-memory stores are sufficient — no persistence needed for ephemeral sessions |
| Reset TTL on relay messages | Thousands of unnecessary map writes per minute |
| Write to WebSocket directly from Hub | writePump handles that — Hub never blocks |
| Use a web framework | net/http stdlib is sufficient |
| Write session token to store on connect | Only matters after disconnect — writing earlier starts the TTL clock at the wrong time |
| Use a channel per event type | One typed event channel is cleaner and prevents coupling between message flows |
| Use map[string]interface{} for sync payloads | Typed SyncCommandPayload struct — zero allocation, compile-time safe |
| Use int64 unix ms for RecordedAt | time.Time preserves the monotonic clock — NTP-immune elapsed calculation |
| Persist room metadata (createdAt, status) | Never read back — storing it would violate Light |
| Store hostId separately from Hub | h.hostIds is the sole owner — no redundant writes |

Each omission is a feature. Everything the server does not do is something that cannot go wrong.

---

## Build Order

```
1. config.go        Environment variables, constants (MaxRoomMembers, MaxPlaybackPositionSeconds, ...)
2. store.go         RoomStore and SessionStore — in-memory maps with TTL and background cleanup
3. middleware.go    Rate limiter, security headers, CORS, input validation
4. session.go       Token generation, store/retrieve via SessionStore, reconnect identity
5. rooms.go         Code generation, POST /rooms, GET /rooms/:code via RoomStore
6. hub.go           Hub struct, event types, run loop, all handlers,
                    WebSocket handler, readPump, writePump
7. turn.go          TURN credential fetching and caching
8. main.go          Wire all of the above, start server
```

Each file depends only on what came before it.