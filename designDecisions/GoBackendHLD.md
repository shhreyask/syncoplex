# Go Backend — Complete Design Document

---

## What This Server Is

A single Go binary. No framework. No runtime. Three external dependencies. It starts in milliseconds, idles at ~12MB of memory, and its entire job is routing small JSON messages between browsers as fast as possible. It never touches video, audio, or any media bytes. The moment WebRTC peer connections are established between users, the server steps aside and becomes irrelevant to the actual watch party experience.

Every architectural decision in this document flows from four principles:
- **Secure** — hostile inputs, bad actors, and flaky clients never affect other users
- **Fast** — the server adds microseconds of latency, never milliseconds
- **Smooth** — reconnects are seamless, membership state is always accurate, no ghost users
- **Light** — minimal memory, minimal Redis calls, minimal complexity

---

## Stack

```
Language        Go (latest stable)
WebSocket       github.com/gorilla/websocket
Redis client    github.com/redis/go-redis/v9
Env loading     github.com/joho/godotenv
TLS             Caddy (reverse proxy, auto Let's Encrypt)
Redis           Local instance, localhost only
```

Three dependencies. That is the entire external surface area of this server.

---

## Architecture — Three Layers

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
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│                    Redis Layer                           │
│       Room existence and metadata only                   │
│       NOT responsible for live membership                │
│       Auto-expiring TTL, no cleanup jobs                 │
│       Localhost only, password protected                 │
└──────────────────────────────────────────────────────────┘
```

Each layer has one responsibility and never bleeds into another.

---

## File Responsibilities

```
server/
├── main.go           Starts the server, wires routes, connects Redis
├── config.go         Environment variables, constants, room cap, playback limits
├── redis.go          go-redis singleton, connection config, pool sizing
├── rooms.go          Code generation, Redis read/write, room validation
├── hub.go            Hub struct, event loop, all hub handlers, WebSocket handler, read/write pumps
├── session.go        Session token issuance, reconnect identity claims
└── middleware.go     Rate limiting, security headers, CORS, input validation
```

Every file has one clear owner. None of them know about the internals of the others.

---

## Source of Truth — Strict Separation

```
┌─────────────────────────────────────────────────────────┐
│  Question                        │  Answer lives in     │
├──────────────────────────────────┼──────────────────────┤
│  Does this room exist?           │  Redis               │
│  Who created it? When?           │  Redis               │
│  Who is the current host?        │  Redis               │
│  Who is connected right now?     │  Hub (in-memory)     │
│  What is the current room state? │  Hub (in-memory)     │
│  Route this message to whom?     │  Hub (in-memory)     │
└──────────────────────────────────┴──────────────────────┘
```

The Hub is the sole source of truth for live membership. Redis never tracks who is connected. This eliminates the restart divergence problem entirely — the Hub starts empty on restart, users reconnect through the normal join flow, and the Hub repopulates itself naturally.

---

## Redis Schema

```
room:{code}     Hash    { hostId, createdAt, status }
session:{token} String  { userId, name, roomCode }    TTL: 5 minutes
```

The `room:{code}:members` Set is **removed entirely.** Redis does not track live membership.

### hostId Lifecycle

When a room is created via `POST /rooms`, the host's userId does not exist yet — the WebSocket connection hasn't been opened. The `hostId` field is written as `"pending"` at creation time and overwritten with the real userId when the first member joins via WebSocket.

### Redis Configuration

```
bind 127.0.0.1          ← Never exposed to the internet
requirepass {strong}    ← Password protected even on localhost
maxmemory-policy allkeys-lru
```

### Redis Connection Pool

```go
redis.NewClient(&redis.Options{
    Addr:         cfg.RedisAddr,
    Password:     cfg.RedisPassword,
    DB:           0,
    PoolSize:     10,   // one server process, keep it lean
    MinIdleConns: 2,
})
```

### TTL Strategy

```
room:{code}        6 hour TTL
                   Reset ONLY on: user join, user leave, 30-minute heartbeat
                   Never reset on relay messages — those are high frequency
                   Collapses to 5 minute TTL after a room empties

session:{token}    5 minute TTL
                   Written to Redis only when the client disconnects — this is
                   when the reconnect window actually opens. The token is held
                   in memory on the Client struct while the connection is live.
                   Expires automatically, no cleanup needed.
```

Resetting TTL on every relay message at 30 messages/second/connection would mean thousands of unnecessary Redis round trips per minute. TTL is a lifecycle signal, not an activity ping.

The session token is intentionally **not** written to Redis on connect. It only needs to exist during the window after a disconnect. The clock starts when it matters — at the moment of disconnect.

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
The frontend shows "Room is full" before attempting a WebSocket connection. Count is read from the Hub's live in-memory map via `roomMemberCount()` — not from Redis.

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

Without session tokens, every WebSocket connect generates a fresh userId. A tab blip means Alice gets a new userId. The room briefly shows two Alices. In Step 6, WebRTC peer connections are keyed to userId — a reconnect breaks every peer connection.

### The Solution

**First Connect:**
```
Client connects with no token
    │
    ▼
Server generates:
    userId        = UUID v4
    sessionToken  = crypto/rand 32 bytes, hex encoded

Token held in memory on Client struct — NOT written to Redis yet.

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
session:{token} → { userId, name, roomCode }  written to Redis, 5 min TTL
    │
    ▼
Reconnect clock starts here — not at connect time.
```

**Reconnect (within 5 minutes):**
```
Client sends: { type: "join", payload: { name: "Alice", sessionToken: "abc..." } }
    │
    ├── Token valid in Redis →
    │       token deleted (one-time use)
    │       fresh token issued, held in memory
    │       userId/name restored, isReconnect = true
    │       broadcast: user_reconnected (not user_joined)
    │       WebRTC peer connections survive intact
    │
    └── Token expired/invalid →
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

Host in v1 is not a permission gate — **everyone in the room can control playback**. Host is simply the room creator, stored in Redis for reference.

- Everyone can play/pause/seek — no host-only restrictions
- When the host disconnects, host role migrates automatically to the next connected member
- `user_left` is always broadcast before `host_changed` — clients process membership loss before any role change

---

## The Hub — Concurrency Model

### The Event Loop

The Hub is an event loop. One goroutine, one inbox (`h.events`), sequential dispatch. All hub state mutations happen on the hub goroutine — no locks needed for `h.rooms`, `h.hostIds`, or `h.playbackStates` within hub handlers.

```go
type HubEvent interface {
    execute(h *Hub)
}
```

Four event types:

| Event | Sent from | Handled by |
|---|---|---|
| `RegisterEvent{client}` | HTTP goroutine (handleWebSocket) | `handleRegister` |
| `UnregisterEvent{client}` | readPump goroutine (deferred) | `handleUnregister` |
| `RelayEvent{roomCode, senderUserId, data}` | readPump goroutine | `handleRelay` |
| `SyncEvent{client, raw}` | readPump goroutine | `handleSyncCommand` |

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

**Why the heartbeat is a direct call and not a HeartbeatEvent:** the ticker fires on the hub goroutine via `ticker.C`. Sending a `HeartbeatEvent` into `h.events` would be a goroutine writing to its own channel — a deadlock if the buffer is full. The event channel exists to bridge goroutine boundaries safely. When you're already on the right goroutine, the channel is the wrong tool.

**Why one channel replaces three:** the old design had `register chan *Client`, `unregister chan *Client`, and `broadcast chan *Message` — three separate inboxes for one entity that processes them one at a time anyway. The `select` in `run()` was already doing manual dispatch. The typed event channel makes the model explicit: one inbox, self-dispatching events. Adding a new event type in the future costs one struct and one `execute()` implementation — zero changes to `run()`, zero changes to other event types.

### The Single Mutex

`h.mu` has exactly one job: protecting `h.rooms` against `roomMemberCount` reads from HTTP handler goroutines. It is acquired for writes in `handleRegister` (insert) and `dropClient` (delete). It is acquired for reads in `roomMemberCount` only.

`h.hostIds` and `h.playbackStates` are accessed exclusively on the hub goroutine — they need no synchronisation at all.

```
h.mu protects:   h.rooms writes ↔ roomMemberCount reads (HTTP goroutine)
No mutex for:    h.hostIds        (hub goroutine only)
                 h.playbackStates (hub goroutine only)
```

### Data Structures

```go
type Client struct {
    userId         string
    name           string
    roomCode       string
    sessionToken   string          // held in memory; written to Redis only on disconnect
    isReconnect    bool
    conn           *websocket.Conn
    send           chan []byte      // buffered — Hub never blocks on this client
    hub            *Hub
    lastSyncWindow time.Time       // monotonic — start of current rate-limit window
    syncCount      int             // commands received in the current window
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
    mu             sync.RWMutex
    rooms          map[string]map[string]*Client
    hostIds        map[string]string
    playbackStates map[string]RoomPlaybackState
    rdb            *redis.Client
    events         chan HubEvent   // single inbox, buffered (512)
}
```

**Why `RoomPlaybackState.RecordedAt` is `time.Time` not `int64`:** Go's `time.Time` preserves the monotonic clock reading captured at `time.Now()`. All elapsed calculations use `now.Sub(state.RecordedAt).Seconds()`, which compares monotonic readings and is completely immune to NTP corrections, DST transitions, and manual clock adjustments. Using `time.Now().UnixMilli()` (int64) strips the monotonic component — an NTP step backward during a session would make elapsed go negative, corrupting `LastRecordedPosition` for every client in the room.

### Goroutine Topology

```
┌─────────────────────────────────────────────┐
│  Hub Goroutine  (1, runs for server lifetime)│
│  Owns all hub state exclusively              │
│  Processes events from h.events sequentially │
│  Heartbeat via direct ticker.C case          │
└─────────────────────────────────────────────┘

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

The Hub **never writes to a WebSocket directly.** It puts messages into each client's buffered `send` channel and moves on immediately. Clients whose buffers are full are collected into a `toDrop` slice and dropped after the range loop — never during iteration.

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

When a client reconnects, the new `*Client` pointer replaces the old one in the room map before the old readPump finishes. Without a guard, the old pump's deferred `UnregisterEvent` would evict the newly registered client:

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

When a client registers and a `RoomPlaybackState` exists for the room, the Hub sends a `sync_state` message before the `user_joined` broadcast:

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
    join            { name, sessionToken? }
    relay           { ...any... }            ← fanned out to room, sender excluded
    sync_command    { action, position? }    ← play | pause | seek

Server → Client:
    session_token       { sessionToken }             ← raw conn, BEFORE Hub registration
    session_init        { userId }
    room_state          { members: [{ userId, name }] }
    user_joined         { userId, name }
    user_left           { userId, name }
    user_reconnected    { userId, name }
    host_changed        { userId, name }
    sync_command        { action, position, isPlaying }  ← authoritative broadcast, all clients
    sync_state          { action, position, isPlaying }  ← late joiner only, on register
    error               { code, message }
```

---

## HTTP Layer

### Two Endpoints

```
POST /rooms          Generate code, write to Redis, return code
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
conn.SetReadLimit(MaxMessageSize)                              // 4KB max message size
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
sync_command             5 commands / client / second  ← enforced in handleSyncCommand
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
Room code        ^[A-Z]+-[A-Z]+-[0-9]+$  before any Redis call
Display name     strip HTML tags, trim whitespace, cap 32 Unicode chars
sync position    0 ≤ position < MaxPlaybackPositionSeconds (86400)
Message type     unknown types dropped silently
Message size     hard cap 4KB via SetReadLimit
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
   Redis: room:WOLF-BEAR-482134 { hostId: "pending", ... }
   Browser navigates to /room/WOLF-BEAR-482134

2. Host enters name, clicks Join
   WebSocket → wss://syncoplex.app/ws/WOLF-BEAR-482134
   Origin validated ← rejected if not frontend
   Room existence checked in Redis ← 404 if missing
   Member count checked via Hub ← 403 if full
   Sends: { type: "join", payload: { name: "Host" } }

   Server:
   Generates userId + sessionToken
   Token held in memory — NOT written to Redis
   conn.WriteMessage → { type: "session_token", ... }  ← before Hub registration
   hub.events <- RegisterEvent
   Hub: hostId set from "pending" to real userId
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
     → writeSessionOnDisconnect: session:{token} → Redis, 5 min TTL
     → delete alice from room (under h.mu.Lock)
     → delete playbackStates entry if room empties
     → close alice.send
     → resetRoomTTL
     → broadcastToRoom: user_left { userId }
     → no host migration (alice is not host)

   Alice reconnects automatically
   Sends: { type: "join", payload: { name: "Alice", sessionToken: "abc..." } }
   Token found in Redis → deleted, fresh token issued, isReconnect = true
   hub.events <- RegisterEvent
   Hub: cap check bypassed (isReconnect)
   Hub: client.send ← session_init, room_state
   Hub: if playbackState exists → client.send ← sync_state (computed position)
   Hub: broadcastToOthers → user_reconnected (NOT user_joined)

6. Host closes tab
   Hub: dropClient
     → writeSessionOnDisconnect
     → delete host from room
     → broadcastToRoom: user_left
     → host migration: next member → hostIds, Redis HSet, broadcastToRoom host_changed

7. Last person leaves
   Hub: dropClient → room empties
   Hub: delete h.rooms[roomCode] (under h.mu.Lock)
   Hub: delete h.hostIds[roomCode], h.playbackStates[roomCode] (after unlock)
   Redis: room TTL collapsed to 5 minutes
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

### Memory at 100 Concurrent Rooms

```
Go runtime baseline                     ~4MB
Hub rooms map (100 rooms, 4 users)      ~1MB
802 goroutines × 4KB stack              ~3.2MB
Send channel buffers                    ~5MB
Redis client                            ~2MB
────────────────────────────────────────────
Total                                   ~15MB
```

### Redis Call Frequency

```
Per join              2 calls  (room exists check, TTL reset)
Per leave             2 calls  (session write, TTL reset)
Per relay message     0 calls
Per sync_command      0 calls
Every 30 minutes      N calls  (N = active rooms, heartbeat)
```

---

## What The Server Deliberately Does Not Do

| Thing | Reason |
|---|---|
| Handle video or audio bytes | P2P WebRTC — server is never in the media path |
| Store user data | No database, no privacy surface |
| Authenticate users | Room code is the auth — friction is the enemy |
| Know what movie is playing | Completely irrelevant to the server |
| Track live membership in Redis | Hub is source of truth — Redis divergence eliminated |
| Reset TTL on relay messages | Thousands of unnecessary Redis round trips |
| Write to WebSocket directly from Hub | writePump handles that — Hub never blocks |
| Use a web framework | net/http stdlib is sufficient |
| Expose Redis to the network | localhost only, always |
| Write session token to Redis on connect | Only matters after disconnect — writing earlier wastes a call and starts the TTL clock at the wrong time |
| Use a channel per event type | One typed event channel is cleaner and prevents coupling between message flows |
| Use map[string]interface{} for sync payloads | Typed SyncCommandPayload struct — zero allocation, compile-time safe |
| Use int64 unix ms for RecordedAt | time.Time preserves the monotonic clock — NTP-immune elapsed calculation |

Each omission is a feature. Everything the server does not do is something that cannot go wrong.

---

## Build Order

```
1. config.go        Environment variables, constants (MaxRoomMembers, MaxPlaybackPositionSeconds, ...)
2. redis.go         Redis client singleton, connection with auth, pool sizing
3. middleware.go    Rate limiter, security headers, CORS, input validation
4. session.go       Token generation, Redis store/retrieve, reconnect identity
5. rooms.go         Code generation, POST /rooms, GET /rooms/:code
6. hub.go           Hub struct, event types, run loop, all handlers,
                    WebSocket handler, readPump, writePump
7. main.go          Wire all of the above, start server
```

Each file depends only on what came before it.