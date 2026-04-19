## Go Backend — Complete Revised Design Document

---

## What This Server Is

A single Go binary. No framework. No runtime. Two external dependencies. It starts in milliseconds, idles at ~12MB of memory, and its entire job is routing small JSON messages between browsers as fast as possible. It never touches video, audio, or any media bytes. The moment WebRTC peer connections are established between users, the server steps aside and becomes irrelevant to the actual watch party experience.

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
TLS             Caddy (reverse proxy, auto Let's Encrypt)
Redis           Local instance, localhost only
```

Two dependencies. That is the entire external surface area of this server.

---

## Architecture — Three Layers

```
��──────────────────────────────────────────────────────────┐
│                      HTTP Layer                          │
│         POST /rooms          GET /rooms/:code            │
│         Security middleware stack on every request       │
└───────────────────────────┬──────────────────────────────┘
                            │
┌───────────────────────────▼──────────────────────────────┐
│                   WebSocket Layer                        │
│       One persistent connection per user per session     │
│       Single message envelope for all event types        │
│       Hub goroutine owns all broadcast logic             │
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
├── config.go         Environment variables, constants, room cap
├── redis.go          go-redis singleton, connection config
├── rooms.go          Code generation, Redis read/write, room validation
├── hub.go            In-memory connection map, broadcast logic, host migration
├── session.go        Session token issuance, reconnect identity claims
└── middleware.go     Rate limiting, security headers, CORS, input validation
```

Every file has one clear owner. None of them know about the internals of the others.

---

## Source of Truth — Strict Separation

This is the most important architectural decision in the document:

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

The Hub is the sole source of truth for live membership. Redis never tracks who is connected. This eliminates the restart divergence problem entirely — the Hub starts empty on restart, users reconnect through the normal join flow, and the Hub repopulates itself naturally. Redis room metadata survives the restart correctly because it's the right thing to persist.

---

## Redis Schema

```
room:{code}     Hash    { hostId, createdAt, status }
session:{token} String  { userId, name, roomCode }    TTL: 30 seconds
```

The `room:{code}:members` Set from the original design is **removed entirely.** Redis does not track live membership.

### Redis Configuration

```
bind 127.0.0.1          ← Never exposed to the internet
requirepass {strong}    ← Password protected even on localhost
maxmemory-policy allkeys-lru
```

### TTL Strategy

```
room:{code}        6 hour TTL
                   Reset ONLY on: user join, user leave, 30-minute heartbeat
                   Never reset on relay messages — those are high frequency

session:{token}    30 second TTL
                   Short window for reconnection claim
                   Expires automatically, no cleanup needed
```

Resetting TTL on every relay message at 30 messages/second/connection would mean thousands of unnecessary Redis round trips per minute. TTL is a lifecycle signal, not an activity ping.

### The Heartbeat

```go
// One goroutine, runs for the lifetime of the server
func (h *Hub) ttlHeartbeat(rdb *redis.Client) {
    ticker := time.NewTicker(30 * time.Minute)
    for range ticker.C {
        for roomCode, room := range h.rooms {
            if len(room) > 0 {
                rdb.Expire(ctx, "room:"+roomCode, 6*time.Hour)
            }
        }
    }
}
```

At 100 active rooms this is 100 Redis calls every 30 minutes. Effectively zero load.

---

## Room Codes

```
WOLF-BEAR-4821
```

Two words from a curated list of 50 common animals + 6 random digits:

```
50 × 50 × 900,000 = 2.25 billion possible codes
```

Brute force is computationally unreasonable. Combined with rate limiting on the validation endpoint, room enumeration attacks are effectively impossible.

**Why not UUIDs?** UUIDs are for machines. Room codes are typed and shared verbally between friends. They need to be human-readable and memorable.

---

## Room Member Cap

**Hard cap: 6 members per room.**

This is not a server constraint — the Go server is completely indifferent to room size. The cap exists because of the WebRTC full mesh topology used in Step 5:

```
N people → N×(N-1)/2 peer connections

2 people  →  1 connection
4 people  →  6 connections
6 people  →  15 connections
10 people →  45 connections
```

In a full mesh every participant uploads directly to every other participant. At 6 people each user is uploading 5 simultaneous video+audio streams. Beyond 6, average home upload bandwidth and device CPU become real constraints for typical users.

### Two Layers of Enforcement

**Layer 1 — GET /rooms/:code response:**
```json
{ "exists": true, "memberCount": 4, "full": false }
```
The frontend shows "Room is full" before attempting a WebSocket connection.

**Layer 2 — WebSocket upgrade handler:**
```go
// Check BEFORE upgrading — reject at HTTP level
if currentCount >= 6 {
    http.Error(w, "Room is full", http.StatusForbidden)
    return  // connection never established
}
```

A 403 at HTTP level is cheaper than establishing and immediately closing a WebSocket. The client gets a clear signal it can handle gracefully.

---

## Session Tokens and Reconnection Identity

### The Problem
Without session tokens, every WebSocket connect generates a fresh userId. A tab blip means Alice gets a new userId. The room briefly shows two Alices. In Step 5, WebRTC peer connections are keyed to userId — a reconnect breaks every peer connection.

### The Solution — Session Tokens

**First Connect:**
```
Client connects with no token
    │
    ▼
Server generates:
    userId        = UUID v4  (stable identity for this session)
    sessionToken  = crypto/rand 32 bytes, hex encoded  (proves identity on reconnect)

Server stores in Redis:
    session:{token} → { userId, name, roomCode }   TTL: 30 seconds

Server sends to client immediately:
    { type: "session_init", payload: { userId, sessionToken } }

Client stores sessionToken in sessionStorage
```

**Reconnect (within 30 seconds):**
```
Client reconnects, sends token in first message:
    { type: "join", payload: { name: "Alice", sessionToken: "abc123..." } }
    │
    ▼
Server checks Redis: session:{token} exists?
    │
    ├── YES → restore userId, name, roomCode
    │         user rejoins as same identity
    │         broadcast { type: "user_reconnected" } — not user_joined
    │         peer connections in Step 5 survive intact
    │
    └── NO  → token expired or invalid
              treat as fresh join, issue new userId and token
```

**Why sessionStorage and not localStorage:**
```
sessionStorage  →  survives tab blip, network drop, browser refresh
                →  cleared when tab is intentionally closed
localStorage    →  persists forever, wrong behaviour for a session
```

This is exactly the scoping you want. A genuine reconnect is seamless. A deliberate new session starts fresh.

---

## Host Role and Host Departure

### Definition
Host in v1 is not a permission gate — everyone in the room can control playback. Host is simply the room creator, stored in Redis for reference.

### Why Define This Now
Step 3 adds sync commands. "Who controls playback" needs a clear answer before that code is written.

### Decision: Democratic Control, Automatic Migration

- Everyone can play/pause/seek — no host-only restrictions
- When the host disconnects, host role migrates automatically to the next connected member
- When the room empties, nothing is deleted — TTL handles cleanup

```go
func (h *Hub) handleUnregister(client *Client) {
    room := h.rooms[client.roomCode]
    delete(room, client.userId)

    if client.userId == h.getRoomHost(client.roomCode) {
        if len(room) > 0 {
            // Migrate to first remaining member
            for _, next := range room {
                rdb.HSet(ctx, "room:"+client.roomCode, "hostId", next.userId)
                h.broadcastToRoom(client.roomCode, HostChangedMessage(next.userId))
                break
            }
        }
        // If room is empty — do nothing, let TTL expire it
    }

    h.broadcastToRoom(client.roomCode, UserLeftMessage(client))
}
```

---

## The Hub — Concurrency Model

The Hub is the central nervous system of the server. It is the only thing that ever reads or writes the live connection map.

### Why a Single Goroutine Instead of Locks

Shared mutable state protected by mutexes is a source of subtle production bugs — deadlocks, missed unlocks, lock contention under load. A single goroutine owning the map means only one thing ever touches it. Correctness by construction, not by careful locking.

### Data Structures

```go
type Client struct {
    userId       string
    name         string
    roomCode     string
    conn         *websocket.Conn
    send         chan []byte      // buffered — Hub never blocks on this client
    hub          *Hub
}

type Message struct {
    roomCode     string
    senderUserId string
    data         []byte
}

type Hub struct {
    rooms        map[string]map[string]*Client   // roomCode → userId → *Client
    hostIds      map[string]string               // roomCode → userId (current host)
    register     chan *Client
    unregister   chan *Client
    broadcast    chan *Message
}
```

### Goroutine Topology

```
┌─────────────────────────────────────────────┐
│  Hub Goroutine  (1, runs for server lifetime)│
│  Owns rooms map and hostIds map             │
│  Processes register/unregister/broadcast    │
└─────────────────────────────────────────────┘

Per connected user (2 goroutines each):

┌──────────────┐      ┌──────────────┐
│  Read Loop   │      │  Write Loop  │
│              │      │              │
│  Blocks on   │      │  Blocks on   │
│  WebSocket   │      │  send chan   │
│  read        │      │              │
│  Puts msgs   │      │  Writes to   │
│  on Hub      │      │  WebSocket   │
│  channel     │      │  conn        │
└──────────────┘      └──────────────┘
```

### The Critical Broadcast Pattern

The Hub **never writes to a WebSocket directly.** It only puts messages into each client's buffered send channel and moves on immediately:

```go
case msg := <-h.broadcast:
    if room, ok := h.rooms[msg.roomCode]; ok {
        for _, client := range room {
            select {
            case client.send <- msg.data:
                // Delivered to buffer — Hub moves on immediately
            default:
                // Buffer full — client is too slow or dead
                // Drop the client, never stall the Hub
                close(client.send)
                delete(room, client.userId)
            }
        }
    }
```

The `select` with `default` is the most important detail in the entire codebase. A slow or dead client never stalls the Hub. The Hub never waits on any individual connection. Every other room and every other user is completely unaffected by one bad connection.

The per-client write loop drains the send channel at its own pace, independently:

```go
func (c *Client) writePump() {
    for msg := range c.send {
        c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
        c.conn.WriteMessage(websocket.TextMessage, msg)
    }
}
```

If the write deadline is exceeded the connection is dropped. The Hub already moved on.

### Goroutine and Memory Count at Scale

```
100 rooms × 4 users average × 2 goroutines = 800 goroutines
800 goroutines × ~4KB stack each           = ~3.2MB

Hub goroutine                               = 1 goroutine
TTL heartbeat goroutine                     = 1 goroutine

Total goroutines at 100 rooms              = 802
Total goroutine memory                     = ~3.2MB
```

This is negligible. The model scales to thousands of rooms on the cheapest available VPS.

---

## Message Envelope

Every WebSocket message in both directions follows this exact shape for the lifetime of the project:

```json
{
    "type": "user_joined",
    "payload": {}
}
```

`type` routes the message. `payload` carries the data. Unknown types are dropped silently — never processed, never forwarded. This envelope is the contract between client and server across all future steps.

### Step 1 Message Types

```
Client → Server:
    join                { name, sessionToken? }

Server → Client:
    session_init        { userId, sessionToken }
    room_state          { members: [{ userId, name }] }   ← sent immediately on join
    user_joined         { userId, name }
    user_left           { userId, name }
    user_reconnected    { userId, name }
    host_changed        { userId, name }
    error               { code, message }
```

`room_state` is sent to the joining user immediately after registration. Without it, Alice joins and has no idea Bob is already there until Bob does something. This is the detail most implementations miss.

---

## HTTP Layer

### Two Endpoints Only

```
POST /rooms          Generate code, write to Redis, return code
GET  /rooms/:code    Validate room exists, return member count and full status
```

Room creation is a one-shot request/response — HTTP is exactly the right protocol. WebSocket is for persistent sessions. Opening a WebSocket just to create a room would be wasteful by design.

### Middleware Stack — Every Request

```
Incoming Request
        │
        ▼
Rate Limiter              IP-based token bucket
        │
        ▼
Security Headers          CSP, X-Frame-Options, nosniff, Referrer-Policy
        │
        ▼
CORS Validation           Only https://watchparty.app — never wildcard
        │
        ▼
Input Validation          Room codes regex-checked, names sanitized
        │
        ▼
Handler                   Business logic
```

Security is not bolted on after — it is the first thing every request passes through.

---

## Security

### Transport

```
All traffic        →  TLS (HTTPS + WSS)
Caddy Caddyfile    →  watchparty.app { reverse_proxy localhost:8080 }
                      That one line provisions and auto-renews Let's Encrypt
Go server          →  Speaks plain HTTP internally, never exposed directly
```

### WebSocket Origin Validation

```go
var upgrader = websocket.Upgrader{
    CheckOrigin: func(r *http.Request) bool {
        return r.Header.Get("Origin") == "https://watchparty.app"
    },
}
```

Any connection not originating from your frontend is rejected at the upgrade handshake before any application code runs.

### Per-Connection Constraints

Applied immediately on every WebSocket connection:

```go
conn.SetReadLimit(4096)                                    // 4KB max message size
conn.SetReadDeadline(time.Now().Add(60 * time.Second))    // drop silent connections
conn.SetPongHandler(func(string) error {                   // reset deadline on heartbeat
    conn.SetReadDeadline(time.Now().Add(60 * time.Second))
    return nil
})
```

A client sending a 1GB message is dropped before a single byte is processed. A client that goes silent is cleaned up automatically.

### Rate Limits

```
POST /rooms                  20 requests / IP / minute
GET  /rooms/:code            10 requests / IP / minute    ← brute force protection
WebSocket messages           30 messages / connection / second
```

Message rate limiting per connection prevents a single bad client from flooding a room. Excess messages are silently dropped.

### HTTP Security Headers

```
Content-Security-Policy      default-src 'self';
                             connect-src 'self' wss://watchparty.app;
                             media-src blob:;
                             script-src 'self';
                             style-src 'self'
X-Frame-Options              DENY
X-Content-Type-Options       nosniff
Referrer-Policy              strict-origin-when-cross-origin
Permissions-Policy           camera=*, microphone=*
```

CSP blocks XSS attacks even if an injection point is found — the browser refuses to execute anything not from `'self'`.

### Input Validation

```
Room code        Must match ^[A-Z]+-[A-Z]+-[0-9]+$  before any Redis call
Display name     Strip all HTML, cap at 32 characters
Message type     Validated against known type allowlist — unknown types dropped
Message size     Hard capped at 4KB by SetReadLimit
```

Room code validation before any Redis call prevents injection-style attacks using crafted key strings.

### CORS

```
Access-Control-Allow-Origin   https://watchparty.app    ← never wildcard
Access-Control-Allow-Methods  GET, POST
Access-Control-Allow-Headers  Content-Type
```

### Dependency Auditing

```bash
govulncheck ./...    ← run before every deploy
```

With two dependencies the attack surface is minimal. govulncheck scans both against the Go vulnerability database.

---

## The Join Flow — End to End

```
1. Host opens app
   POST /rooms
   ← { code: "WOLF-BEAR-4821" }
   Browser navigates to /room/WOLF-BEAR-4821

2. Host enters name, clicks Join
   WebSocket opens → wss://watchparty.app/ws/WOLF-BEAR-4821
   Origin header validated ← rejected here if not your frontend
   Member count checked    ← 403 if room full (never happens for host)
   Sends: { type: "join", payload: { name: "Host" } }

   Server:
   Generates userId + sessionToken
   Stores session:{token} in Redis (30s TTL)
   Registers with Hub
   Sends: { type: "session_init", payload: { userId, sessionToken } }
   Sends: { type: "room_state", payload: { members: [] } }   ← empty, host is first

3. Friend receives room code, opens app
   GET /rooms/WOLF-BEAR-4821
   ← { exists: true, memberCount: 1, full: false }
   Friend sees name entry form

4. Friend enters name, clicks Join
   Member count checked ← 403 if full
   WebSocket opens, origin validated
   Sends: { type: "join", payload: { name: "Alice" } }

   Server:
   Generates userId + sessionToken
   Registers Alice with Hub
   Sends Alice: { type: "session_init", ... }
   Sends Alice: { type: "room_state", payload: { members: [{ host }] } }
   Broadcasts to host: { type: "user_joined", payload: { userId, name: "Alice" } }

5. Alice's network blips — tab briefly disconnects
   Hub unregisters Alice
   Broadcasts: { type: "user_left", payload: { userId: alice-uuid } }
   Redis: session:{token} set with 30s TTL during disconnect

   Alice's browser reconnects automatically (client-side retry)
   Sends: { type: "join", payload: { name: "Alice", sessionToken: "abc..." } }

   Server finds session in Redis — token valid:
   Restores alice-uuid as userId
   Re-registers with Hub under same userId
   Broadcasts: { type: "user_reconnected", payload: { userId: alice-uuid } }
   ← NOT user_joined — clients know not to reset peer state

6. Host closes tab
   Hub unregisters host
   Host migration: next member becomes host
   Redis: hostId updated
   Broadcasts: { type: "host_changed", payload: { userId: alice-uuid } }
   Broadcasts: { type: "user_left", payload: { userId: host-uuid } }

7. Last person leaves
   Hub: room entry deleted from in-memory map
   Redis: room:{code} key left to expire naturally via TTL
```

---

## Performance Profile

### Message Latency

```
WebSocket message received
    → readPump goroutine receives bytes         ~microseconds
    → puts Message on Hub broadcast channel     ~microseconds
    → Hub goroutine picks up, iterates room     ~microseconds
    → drops into each client's send channel     ~microseconds
    → writePump goroutine writes to WebSocket   ~microseconds
    ─────────────────────────────────────────────────────────
    Total server processing                     < 1ms

Network latency between users dominates entirely.
The server is never the bottleneck.
```

### Memory at 100 Concurrent Rooms

```
Go runtime baseline                     ~4MB
Hub rooms map (100 rooms, 4 users)      ~1MB
802 goroutines × 4KB                    ~3.2MB
Send channel buffers (typical)          ~5MB
Redis client                            ~2MB
─────────────────────────────────────────────
Total                                   ~15MB
```

A $5/mo VPS with 512MB RAM could run thousands of concurrent rooms.

### Redis Call Frequency

```
Per join/leave event    3 Redis calls    (room exists check, session write, TTL reset)
Per relay message       0 Redis calls    ← server never touches Redis for relay
Every 30 minutes        N Redis calls    (N = number of active rooms, heartbeat only)
```

The server is almost entirely in-memory during active sessions. Redis is consulted at the edges — join, leave, reconnect — never in the hot path.

---

## What The Server Deliberately Does Not Do

| Thing | Reason |
|---|---|
| Handle video or audio bytes | P2P WebRTC — server is never in the media path |
| Store user data | No database, no privacy surface |
| Authenticate users | Room code is the auth — friction is the enemy |
| Know what movie is playing | Completely irrelevant to the server |
| Manage playback logic | Clients do that — server relays with timestamps in Step 3 |
| Track live membership in Redis | Hub is source of truth — Redis divergence eliminated |
| Reset TTL on relay messages | Would create thousands of unnecessary Redis round trips |
| Write to WebSocket connections directly from Hub | Write loops handle that — Hub never blocks |
| Use a web framework | net/http stdlib is sufficient — no framework overhead |
| Expose Redis to the network | localhost only, always |

Each omission is a feature. Everything the server does not do is something that cannot go wrong, cannot cost money, and cannot slow the user down.

---

## Build Order Within Step 1

```
1. config.go        Environment variables, constants, room cap definition
2. redis.go         Redis client singleton, connection with auth
3. middleware.go    Rate limiter, security headers, CORS, input validation
4. session.go       Token generation, Redis store/retrieve, reconnect identity
5. rooms.go         Code generation, POST /rooms, GET /rooms/:code
6. hub.go           Hub struct, Run loop, register/unregister/broadcast, host migration
7. main.go          Wire all of the above, start server
```

This order matters — each file depends only on what came before it.

---

Ready to write the code file by file in this exact order?