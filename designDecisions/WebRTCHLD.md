# Steps 6 & 7 — WebRTC Signaling Server and Camera Tiles — High Level Design

---

## What These Steps Are

**Step 6 — WebRTC Signaling Server:** One new Go file (`turn.go`) and additions to `hub.go` and `main.go`. Purely server-side. The server learns to route SDP and ICE messages between specific peers in the same room. No client code. Fully testable with `wscat` before a single line of `webrtc.js` is written.

**Step 7 — Camera Tiles:** One new JS file (`webrtc.js`, ~420 lines) and additions to `index.html`, `style.css`, and `ui.js`. Purely client-side. Peer connections are created, local camera and microphone streams are acquired, and tiles are rendered in a fixed strip above the movie. The server code from Step 6 is the relay — Step 7 is everything that uses it.

These two steps are documented together because they form one feature. A reader of the signaling protocol needs to understand what the client does with it, and a reader of `webrtc.js` needs to understand how the server routes its messages. The build sequence keeps them strictly separated — Step 6 is verified before Step 7 begins.

**Principles applied:**

- **Secure** — signaling messages are only routable to users in the same room. `targetUserId` is validated server-side before any bytes are forwarded. `senderUserId` is injected by the server — a client cannot impersonate another. TURN credentials are served from the backend — Metered credentials never appear in client source. WebRTC relay messages are rate-limited on the hub goroutine — a malicious client cannot flood a target's send buffer and trigger an innocent user's eviction.
- **Fast** — ICE trickling means the first candidate pair is tried immediately while gathering continues. `getUserMedia` and TURN credential fetch are parallelised on both the offer path (`onMemberJoined`) and the answer path (`onMessage('webrtc_offer')`) — latency is `max(getUserMedia_time, turn_fetch_time)` not their sum. TURN credentials are prefetched silently when the second member appears in room state. `getUserMedia` is deferred until signaling actually starts — the socially contextual moment. `iceCandidatePoolSize: 4` pre-gathers candidates before the offer is sent, reducing time-to-first-candidate on slow mobile networks.
- **Smooth** — the reconnect model is tiered. A brief drop (PC still `disconnected`) waits 2.5 seconds before sending an ICE restart offer — giving mobile connections a chance to self-recover before consuming TURN bandwidth. A longer drop (PC reached `failed`) closes the tile cleanly and performs a full re-offer on return. TURN credential cache is bounded by a client-side TTL. Video bitrate cap is re-applied on every `'connected'` transition so ICE restarts do not silently reset it.
- **Light** — the server adds one event type and one handler. No SDP parsing, no media inspection, no new persistent structures beyond a rate-limit counter on `Client`. The tile layout is pure CSS flexbox. `getUserMedia` is constrained to 320×180. Video encoder is capped at 150 Kbps — tiles are 120×68px, the browser's default 300–500 Kbps for this resolution is pure waste, and every byte relayed through TURN counts against the 20 GB free tier. `webrtc.js` is the sole owner of peer connections.

**Audio routing scope boundary:** `addTracksToConnection` in this step adds mic audio and camera video from `localStream` — both correct. `webrtc.js` structurally never holds a reference to the main `<video>` element, so movie audio cannot enter WebRTC by accident. Step 8 introduces a Web Audio mixer for per-user volume control and explicit track selection — it is not fixing a bug in Step 7, it is adding new capability on top of this foundation.

**TURN infrastructure:** This step uses Metered's managed TURN service (free tier — 20 GB/month). No infrastructure to provision, no coturn to configure. `turn.go` serves Metered's credentials from environment config. When the app outgrows Metered's free tier, the upgrade path is Oracle Always Free + self-hosted coturn: `turn.go` gains HMAC-SHA1 credential generation, the client changes nothing.

---

## Indian Network Reality

The userbase is primarily Indian. The global estimate of ~20% connections needing TURN does not apply here. **CGNAT is the primary reason.**

Jio, Airtel, and Vi mobile all place users behind Carrier-Grade NAT — users get a private `10.x.x.x` or `100.x.x.x` IPv4 address that is not routable, making direct IPv4 peer-to-peer impossible via STUN alone. India is predominantly mobile-first.

**However, Jio is one of the largest IPv6 deployers in the world.** A Jio mobile user gets:

```
IPv4: 10.x.x.x or 100.x.x.x  ← CGNAT, not routable
IPv6: 2405:xxxx:xxxx::x       ← real public address, fully routable
```

Two Jio users connecting to each other have a native IPv6 path — no CGNAT, no TURN needed. ICE discovers this automatically through `host` candidates. **No special code is needed for IPv6 — ICE handles both address families simultaneously.** What is needed is a STUN server with good Indian latency that supports IPv6, which is why Cloudflare STUN (Mumbai PoP) is included alongside Google STUN.

**Do not filter ICE candidates by address family.** Hard-filtering IPv4 candidates would break connections for home broadband users (BSNL, ACT, Hathway — IPv6 deployment is poor), corporate and college networks (IPv6 often blocked), and older Android devices. The gains for Jio-to-Jio connections are already captured by ICE naturally.

**Realistic TURN usage estimates:**

```
Both users on Jio mobile      → native IPv6 P2P → TURN rarely needed    (~30% of sessions)
Jio mobile → home broadband   → IPv4 STUN path, may need TURN           (~40% of sessions)
Jio mobile → corporate/campus → IPv6 often blocked, TURN likely          (~30% of sessions)

Blended TURN usage estimate: 35–50% of peer connections
```

At 35–50% TURN usage, 150 Kbps video cap, and 20 GB free tier:

```
150 Kbps per relayed stream × 7200s (2hr movie) = 135 MB per connection
4-user room × ~1.7 TURN connections avg = ~230 MB per room-session
20 GB ÷ 230 MB ≈ ~87 room-sessions/month at zero cost
~3 sessions/day before approaching the limit

Without the bitrate cap (~300 Kbps default):
20 GB ÷ ~460 MB ≈ ~43 room-sessions/month
The 150 Kbps cap roughly doubles the free-tier budget.
```

The upgrade trigger to Oracle Always Free + coturn comes earlier than the global estimate suggests. Plan for it once consistent daily usage begins.

---

## What Changes

```
Step 6 — Server only:

server/
├── hub.go              Add webrtcSyncWindow, webrtcCount fields to Client struct
│                       Add WebRTCRelayEvent{client, targetUserId, data}
│                       Add handleWebRTCRelay — rate limit check, room validation,
│                       senderUserId injection, single targeted channel send
│                       Add webrtc_offer / webrtc_answer / ice_candidate cases
│                       to readPump switch, each sending WebRTCRelayEvent
│                       into h.events
└── turn.go             NEW — GET /api/turn-credentials handler
                        Serves Metered STUN + TURN from env config
                        All Metered transport variants (UDP, TCP, TLS/443)
                        Same-origin check, JSON response with expiresAt
                        Registered in main.go under existing rate limiter
                        Upgrade path to self-hosted coturn in comments

Step 7 — Client only:

frontend/public/js/
├── webrtc.js           NEW — peer connection lifecycle, iceCandidatePoolSize: 4,
│                       multiple STUN servers (Google x2 + Cloudflare Mumbai),
│                       promise-cached getUserMedia constrained to 320×180,
│                       capVideoBitrate (150 Kbps) applied after both descriptions
│                       set and re-applied on every 'connected' transition,
│                       parallelised getUserMedia + TURN fetch on both offer and
│                       answer paths, TURN-only prefetch on second member
│                       appearance, TURN expiry-aware cache, 2.5s delay before
│                       ICE restart offer, ICE restart detection on answer path
│                       guarded against 'failed' state, ICE candidate buffering
│                       with 50-cap, backstop timer at 30s, tiered reconnect
└── ui.js               Wire user_joined → webrtc.onMemberJoined
                        Wire user_reconnected → webrtc.onMemberReconnected
                        Wire user_left → webrtc.onMemberLeft
                        Call webrtc.onSecondMemberVisible() when members.length
                        reaches 2 (warms TURN cache only)

frontend/public/
├── index.html          Add #tiles strip and #movie-container structural divs
│                       inside #view-watch
│                       Add <script src="/js/webrtc.js"> after fileVerify.js
└── style.css           Add tile strip layout, #movie-container, .tile,
                        .tile-self, .tile-label, .tile-cam-off
```

No Redis schema changes. No new HTTP routes beyond `/api/turn-credentials`.

Script loading order in `index.html`:

```html
<!-- JS — order matters: state → ws → player → sync → fileVerify → webrtc → ui -->
<script src="/js/state.js"></script>
<script src="/js/ws.js"></script>
<script src="/js/player.js"></script>
<script src="/js/sync.js"></script>
<script src="/js/fileVerify.js"></script>
<script src="/js/webrtc.js"></script>
<script src="/js/ui.js"></script>
```

---

## Environment Config

```
METERED_TURN_HOST     yoursubdomain.metered.live
METERED_USERNAME      <from Metered dashboard>
METERED_CREDENTIAL    <from Metered dashboard>
```

**Upgrade path to self-hosted coturn:**
Replace `METERED_*` vars with:
```
TURN_URL        turn:turn.yourdomain.com:3478
TURN_SECRET     <shared secret for HMAC>
```
Update `turn.go` to generate HMAC-SHA1 credentials (documented in comments). Client code unchanged.

---

## Module Ownership

```
webrtc.js owns:
  - creating and closing RTCPeerConnection objects (one per remote peer)
  - iceCandidatePoolSize: 4 — pre-gather candidates before offer is sent
  - iceServers: Google STUN x2, Cloudflare STUN (Mumbai PoP, IPv6),
    Metered TURN with all transport variants (UDP/80, TCP/80, TLS/443)
  - fetching and caching TURN credentials with 1-hour client-side TTL
  - calling getUserMedia exactly once via promise-caching
  - constraining getUserMedia to 320×180, 24fps
  - deferring getUserMedia until signaling starts
  - parallelising getUserMedia and TURN fetch on both offer and answer paths
  - prefetching TURN credentials silently on second member appearance
  - adding mic audio and camera video tracks to each peer connection
  - capVideoBitrate — 150 Kbps ceiling applied after both SDP descriptions
    are set (not before); re-applied on every 'connected' transition so
    ICE restarts do not silently reset the cap
  - 2.5s grace before ICE restart offer — allows mobile blips to self-recover
  - ICE restart detection on answer path: reuse existing PC if alive
    (connectionState !== 'failed'), create fresh PC otherwise
  - ICE candidate buffering with 50-candidate cap per peer
  - backstop timer at 30s
  - tiered reconnect: ICE restart for brief drops, full re-offer for longer gaps
  - tile creation, update, and removal
  - muting the local tile (always — prevents feedback)
  - teardown on room leave or tab close

webrtc.js does NOT:
  - filter ICE candidates by address family — ICE handles IPv4 and IPv6
    simultaneously; filtering would break home broadband and campus users
  - call setParameters before both SDP descriptions are set — encoder is
    not initialised until negotiation completes

ui.js additions:
  - user_joined       → webrtc.onMemberJoined(member)
  - user_reconnected  → webrtc.onMemberReconnected(member)
  - user_left         → webrtc.onMemberLeft(userId)
  - members.length reaches 2 → webrtc.onSecondMemberVisible()

turn.go owns:
  - GET /api/turn-credentials
  - same-origin enforcement
  - Metered credentials from env config, all transport variants
  - nothing else
```

---

## Step 6 — WebRTC Signaling Server

### Why a Targeted Relay, Not the Existing Broadcast Relay

The existing `relay` message fans out to every member of the room except the sender. WebRTC signaling is strictly point-to-point — an SDP offer from Alice is addressed to Bob, not Carol or Dave. Using the broadcast relay would:

1. Force every client to filter by `targetUserId` in JS
2. Leak SDP negotiation state to uninvolved peers
3. Cause ICE candidates from Alice→Bob to trigger spurious `addIceCandidate` calls on Carol's connection

The correct model is a **targeted relay**: validate `targetUserId` server-side, look up that client's send channel on the hub goroutine, deliver to exactly one channel. One map lookup, one channel send.

The existing `relay` broadcast is untouched. `webrtc_offer`, `webrtc_answer`, and `ice_candidate` use the new `WebRTCRelayEvent` path exclusively.

### Rate Limiting on WebRTC Relay Messages

Two fields added to `Client`:

```go
type Client struct {
    // ... existing fields ...
    webrtcSyncWindow time.Time
    webrtcCount      int
}
```

Cap: **30 WebRTC relay messages per client per second.** Legitimate full-mesh negotiation for 6 users produces at most ~15 offers + ~15 answers + ~200 ICE candidates spread across several seconds. Both fields read and written only in `handleWebRTCRelay` on the hub goroutine. No mutex needed.

### New Event Type

```go
// hub.go
type WebRTCRelayEvent struct {
    client       *Client
    targetUserId string
    data         []byte
}

func (e *WebRTCRelayEvent) execute(h *Hub) {
    h.handleWebRTCRelay(e.client, e.targetUserId, e.data)
}
```

### `handleWebRTCRelay`

```go
func (h *Hub) handleWebRTCRelay(sender *Client, targetUserId string, raw []byte) {
    now := time.Now()
    if now.Sub(sender.webrtcSyncWindow) > time.Second {
        sender.webrtcSyncWindow = now
        sender.webrtcCount = 0
    }
    sender.webrtcCount++
    if sender.webrtcCount > 30 {
        return
    }

    room, ok := h.rooms[sender.roomCode]
    if !ok {
        return
    }
    target, ok := room[targetUserId]
    if !ok {
        return
    }
    if target == sender {
        return
    }

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
```

### `readPump` Cases

```go
case "webrtc_offer", "webrtc_answer", "ice_candidate":
    var p struct {
        TargetUserId string          `json:"targetUserId"`
        Payload      json.RawMessage `json:"payload"`
    }
    if err := json.Unmarshal(env.Payload, &p); err != nil {
        continue
    }
    if p.TargetUserId == "" {
        continue
    }
    c.hub.events <- &WebRTCRelayEvent{
        client:       c,
        targetUserId: p.TargetUserId,
        data:         rawMessage,
    }
```

### TURN Credentials — `turn.go`

All three transport variants are included in priority order: UDP (fastest), TCP (if UDP blocked by firewall), TLS over port 443 (corporate and campus networks that block everything except HTTPS — critical for the Indian userbase).

```go
// turn.go

// UPGRADE PATH — self-hosted coturn on Oracle Always Free:
// When outgrowing Metered free tier (~87 room-sessions/month at 150 Kbps cap),
// provision an Oracle Always Free VM (10 TB/month) and install coturn.
// Replace METERED_* env vars with TURN_URL + TURN_SECRET and implement
// HMAC-SHA1 credential generation:
//
//   expiry   := time.Now().Add(time.Hour).Unix()
//   username := fmt.Sprintf("%d:%s", expiry, userId)
//   mac      := hmac.New(sha1.New, []byte(cfg.TurnSecret))
//   mac.Write([]byte(username))
//   credential := base64.StdEncoding.EncodeToString(mac.Sum(nil))
//
// Endpoint shape, response format, and all client code unchanged on upgrade.

func handleTurnCredentials(w http.ResponseWriter, r *http.Request) {
    if r.Header.Get("Origin") != allowedOrigin {
        http.Error(w, "Forbidden", http.StatusForbidden)
        return
    }

    iceServers := []map[string]interface{}{
        // Google STUN — reliable globally, supports IPv6
        {"urls": "stun:stun.l.google.com:19302"},
        {"urls": "stun:stun1.l.google.com:19302"},
        // Cloudflare STUN — Mumbai PoP, low latency for Indian users, IPv6
        {"urls": "stun:stun.cloudflare.com:3478"},
        // Metered TURN — all transport variants in priority order
        {
            "urls": []string{
                "turn:" + cfg.MeteredTurnHost + ":80",
                "turn:" + cfg.MeteredTurnHost + ":80?transport=tcp",
                "turns:" + cfg.MeteredTurnHost + ":443?transport=tcp",
            },
            "username":   cfg.MeteredUsername,
            "credential": cfg.MeteredCredential,
        },
    }

    w.Header().Set("Content-Type", "application/json")
    json.NewEncoder(w).Encode(map[string]interface{}{
        "iceServers": iceServers,
        "expiresAt":  time.Now().Add(time.Hour).UnixMilli(),
        // expiresAt is a client-side cache hint — not a Metered credential expiry.
        // Metered credentials are long-lived. This triggers a refetch after 1 hour
        // as a hygiene measure for very long sessions.
    })
}
```

Registered in `main.go`:

```go
mux.Handle("/api/turn-credentials", rateLimiter(http.HandlerFunc(handleTurnCredentials)))
```

### New WebSocket Message Types

```
Client → Server:
    webrtc_offer      { targetUserId: "<uuid>", payload: { type: "offer",  sdp: "..." } }
    webrtc_answer     { targetUserId: "<uuid>", payload: { type: "answer", sdp: "..." } }
    ice_candidate     { targetUserId: "<uuid>", candidate: { ... } }

Server → Client (targeted):
    webrtc_offer      { senderUserId: "<uuid>", payload: { type: "offer",  sdp: "..." } }
    webrtc_answer     { senderUserId: "<uuid>", payload: { type: "answer", sdp: "..." } }
    ice_candidate     { senderUserId: "<uuid>", candidate: { ... } }
```

`senderUserId` is always server-injected. A client supplying its own is overwritten.

---

## Step 7 — Camera Tiles

### Layout — Tile Strip Above the Movie

```
┌──────────────────────────────────────────────────┐
│         ┌──────┐ ┌──────┐ ┌──────┐              │  ← #tiles strip, 84px tall
│         │ You  │ │Alice │ │ Bob  │              │     center-aligned
│         └──────┘ └──────┘ └──────┘              │
├──────────────────────────────────────────────────┤
│                   <video>                        │  ← #movie-container, flex: 1
│  ┌────────────────────────────────────────────┐  │
│  │ ▶  ━━━━━━━━━━━━  01:23:45 / 02:15:00      │  │  ← controls bar, position: absolute
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

```
2 users:              [ You  ] [Alice ]
4 users:     [ You  ] [Alice ] [ Bob  ] [Carol ]
6 users: [You] [Alice] [ Bob ] [Carol] [ Dan  ] [ Eve ]
```

Zero JavaScript for layout. No `layoutTiles()` function.

### HTML Structure

```html
<section id="view-watch">
  <div id="tiles">
    <!-- Tile <div> elements inserted and removed by webrtc.js -->
  </div>
  <div id="movie-container">
    <div id="file-picker-overlay"> ... </div>
    <video id="main-video" playsinline crossorigin="anonymous">
      <track id="subtitle-track" kind="subtitles" default />
    </video>
    <div id="controls-bar"> ... </div>
  </div>
</section>
```

### CSS

```css
#view-watch {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #000;
}

#tiles {
    width: 100%;
    height: 84px;
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 8px;
    background: #0a0a0a;
    flex-shrink: 0;
}

#movie-container {
    flex: 1;
    position: relative;
    background: #000;
    overflow: hidden;
}

#main-video {
    width: 100%;
    height: 100%;
    object-fit: contain;
}

.tile {
    width: 120px;
    height: 68px;
    background: #111;
    border-radius: 4px;
    overflow: hidden;
    flex-shrink: 0;
    position: relative;
}

.tile video {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.tile-self {
    border: 1px solid var(--accent);
}

.tile-label {
    position: absolute;
    bottom: 4px;
    left: 6px;
    font-size: 0.65rem;
    color: #fff;
    text-shadow: 0 1px 2px rgba(0,0,0,0.8);
    pointer-events: none;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 108px;
}

.tile-cam-off video { display: none; }

.tile-cam-off::after {
    content: '🚫';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.2rem;
}
```

### The Reconnect Model

```
Session token (5 min TTL) — preserves userId, name, host role
RTCPeerConnection — lives until ICE declares 'failed' (~10–30s after drop)

Network drops
    ▼ ~5s   → 'disconnected'   tile visible, frozen
    ▼ ~30s  → 'failed'         tile removed, full re-offer on return

Thresholds:
  0 – ~30s    'disconnected'   2.5s grace, then ICE restart if still down
  ~30s+       'failed'         Full re-offer — tile removed, reappears
  5 min+      Token expired    user_joined, new userId
```

### Video Bitrate Cap — `capVideoBitrate`

The browser's encoder defaults to 300–500 Kbps for 320×180 video. Tiles are 120×68px — 150 Kbps is indistinguishable in quality at that size and halves TURN relay cost.

**Timing is critical.** `setParameters` must only be called after both local and remote SDP descriptions are set — the encoder pipeline is not initialised until negotiation completes. Calling it before `setLocalDescription` or before `setRemoteDescription` is unreliable across browsers.

Correct call sites:
- **Offerer:** in `onMessage('webrtc_answer')`, after `setRemoteDescription` — both descriptions now set
- **Answerer:** in `onMessage('webrtc_offer')`, after `setLocalDescription(answer)` — both descriptions now set
- **ICE restart recovery:** in `onconnectionstatechange` when state becomes `'connected'` — re-applies the cap after every successful connection or ICE restart, since renegotiation can reset encoding parameters

```js
const capVideoBitrate = async (pc) => {
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 150_000  // 150 Kbps
        await sender.setParameters(params).catch(() => {})
        // Defensive catch — setParameters can reject on older browsers if
        // called during renegotiation. Failure is non-fatal; encoder falls
        // back to its own bitrate selection rather than breaking the connection.
    }
}
```

### ICE Restart Detection — Answer Path

If Alice has an existing PC for Bob that is **not `'failed'`**, the incoming offer is an ICE restart — reuse the existing PC. If the PC does not exist or is `'failed'`, it is a fresh offer — create a new PC.

The `'failed'` guard prevents a false positive: Bob's PC fails at ~12s and he sends a fresh full re-offer, but Alice's PC for Bob is still `'disconnected'`. Without the guard, Alice calls `setRemoteDescription` on an unrecoverable connection.

`'closed'` never appears in the map — `closePeerConnection` deletes the entry immediately after `pc.close()`.

### `webrtc.js` — Internal Structure

```js
// === CONFIGURATION ===
// === TURN CREDENTIALS (1-hour client-side cache) ===
// === LOCAL STREAM (promise-cached, constrained to 320×180@24fps) ===
// === BITRATE CAP ===
// === PEER CONNECTION MANAGEMENT ===
// === SIGNALING — OFFER / ANSWER ===
// === ICE CANDIDATES (buffered, capped at 50) ===
// === RECONNECT — TIERED LOGIC WITH 2.5s GRACE ===
// === TILE LIFECYCLE ===
// === PUBLIC API ===
```

### TURN Credentials

```js
// === TURN CREDENTIALS ===
let turnCredentials          = null
let turnCredentialsExpiresAt = 0

const getTurnCredentials = async () => {
    if (turnCredentials && Date.now() < turnCredentialsExpiresAt - 60_000) {
        return turnCredentials
    }
    const res = await fetch(
        `/api/turn-credentials?userId=${encodeURIComponent(roomState.myUserId)}`
    )
    if (!res.ok) throw new Error('turn-credentials fetch failed')
    const data               = await res.json()
    turnCredentials          = data.iceServers
    turnCredentialsExpiresAt = data.expiresAt
    return turnCredentials
}
```

### `getUserMedia` — Promise-Cached, Constrained, Deferred

```js
// === LOCAL STREAM ===
let localStream        = null
let localStreamPromise = null

const getLocalStream = async () => {
    if (localStream) return localStream

    if (!localStreamPromise) {
        localStreamPromise = navigator.mediaDevices.getUserMedia({
            video: {
                width:     { max: 320 },
                height:    { max: 180 },
                frameRate: { max: 24  }
                // Tiles are 120×68px. Higher resolution wastes CPU, battery,
                // and mobile data. max constraints — browser falls back
                // gracefully if device cannot meet them.
            },
            audio: true
            // Mic audio correct here. webrtc.js never touches <video#main-video>
            // so movie audio cannot enter WebRTC. Step 8 adds Web Audio mixer
            // for per-user volume — new capability, not a fix.
        })
        .then(stream => {
            localStream = stream
            return stream
        })
        .catch(() => {
            localStreamPromise = null  // allow retry on next join
            roomState.camPermissionDenied = true
            notifyUpdate()
            return null
        })
    }

    return localStreamPromise
}
```

`getUserMedia` fires only when signaling begins — `onMemberJoined` or `onMessage('webrtc_offer')`. Not on `onSecondMemberVisible`.

### Bitrate Cap

```js
// === BITRATE CAP ===
const capVideoBitrate = async (pc) => {
    for (const sender of pc.getSenders()) {
        if (sender.track?.kind !== 'video') continue
        const params = sender.getParameters()
        if (!params.encodings || params.encodings.length === 0) {
            params.encodings = [{}]
        }
        params.encodings[0].maxBitrate = 150_000  // 150 Kbps
        await sender.setParameters(params).catch(() => {})
    }
}
// Called only after both SDP descriptions are set — never before.
// Re-applied on every 'connected' transition to survive ICE restarts.
```

### Peer Connection Management

```js
// === PEER CONNECTION MANAGEMENT ===
const peerConnections = {}
const reconnectTimers = {}

const createPeerConnection = async (remoteUserId, iceServers) => {
    const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4
        // Pre-gather up to 4 candidates before offer is sent.
        // Reduces time-to-first-candidate on slow mobile networks.
        // Increases chance of finding direct IPv6 path (Jio-to-Jio)
        // before browser falls back to TURN relay candidates.
    })
    peerConnections[remoteUserId] = pc

    pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return
        // All candidates sent — IPv4 and IPv6 both.
        // Do NOT filter by address family.
        wsSend('ice_candidate', { targetUserId: remoteUserId, candidate })
    }

    pc.ontrack = ({ streams }) => {
        attachRemoteTile(remoteUserId, streams[0])
    }

    pc.onconnectionstatechange = async () => {
        const state = pc.connectionState

        if (state === 'connected') {
            clearTimeout(reconnectTimers[remoteUserId])
            delete reconnectTimers[remoteUserId]
            // Re-apply bitrate cap on every successful connection or ICE restart.
            // Renegotiation can reset encoding parameters — this ensures the cap
            // is always in effect regardless of how the connection was established.
            await capVideoBitrate(pc)
        }

        if (state === 'disconnected') {
            reconnectTimers[remoteUserId] = setTimeout(() => {
                const current = peerConnections[remoteUserId]
                if (current === pc &&
                   (pc.connectionState === 'disconnected' ||
                    pc.connectionState === 'failed')) {
                    closePeerConnection(remoteUserId)
                }
            }, 30000)
        }

        if (state === 'failed') {
            clearTimeout(reconnectTimers[remoteUserId])
            delete reconnectTimers[remoteUserId]
            closePeerConnection(remoteUserId)
        }
    }

    addTracksToConnection(pc)
    return pc
}

const closePeerConnection = (userId) => {
    const pc = peerConnections[userId]
    if (!pc) return
    pc.close()
    delete peerConnections[userId]  // deleted immediately — 'closed' never in map
    delete pendingCandidates[userId]
    removeTile(userId)
}

const addTracksToConnection = (pc) => {
    if (!localStream) return
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
}
```

### Offer / Answer — Symmetric, With Bitrate Cap and ICE Restart Detection

Both paths call `Promise.all([getLocalStream(), getTurnCredentials()])` before touching any peer connection. Without `getLocalStream()` on the answer path, `addTracksToConnection` runs while `localStream` is null — the new joiner answers with zero tracks and is invisible to the room.

`capVideoBitrate` is called after both descriptions are set on each path.

```js
// === SIGNALING — OFFER / ANSWER ===

const onMemberJoined = async (member) => {
    if (member.userId === roomState.myUserId) return

    const [stream, iceServers] = await Promise.all([
        getLocalStream(),
        getTurnCredentials()
    ])

    if (stream && !tilesContainer.querySelector('.tile-self')) {
        createLocalTile(stream)
    }

    await createOffer(member.userId, iceServers)
}

const createOffer = async (remoteUserId, iceServers) => {
    const pc = await createPeerConnection(remoteUserId, iceServers)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend('webrtc_offer', { targetUserId: remoteUserId, payload: pc.localDescription })
    // capVideoBitrate NOT called here — remote description not set yet.
    // It will be called in onMessage('webrtc_answer') and again on 'connected'.
}

onMessage('webrtc_offer', async ({ senderUserId, payload: offer }) => {
    const [stream, iceServers] = await Promise.all([
        getLocalStream(),
        getTurnCredentials()
    ])

    if (stream && !tilesContainer.querySelector('.tile-self')) {
        createLocalTile(stream)
    }

    const existingPc = peerConnections[senderUserId]

    if (existingPc && existingPc.connectionState !== 'failed') {
        // ICE restart — reuse existing PC.
        // 'failed' guard: Bob's PC failed at ~12s, sends fresh re-offer,
        // Alice's PC still 'disconnected'. Without guard: setRemoteDescription
        // on unrecoverable connection.
        await existingPc.setRemoteDescription(new RTCSessionDescription(offer))
        drainPendingCandidates(senderUserId, existingPc)
        const answer = await existingPc.createAnswer()
        await existingPc.setLocalDescription(answer)
        // Both descriptions now set — safe to cap bitrate.
        await capVideoBitrate(existingPc)
        wsSend('webrtc_answer', {
            targetUserId: senderUserId,
            payload: existingPc.localDescription
        })

    } else {
        // Fresh offer — new PC.
        if (existingPc) closePeerConnection(senderUserId)
        const pc = await createPeerConnection(senderUserId, iceServers)
        await pc.setRemoteDescription(new RTCSessionDescription(offer))
        drainPendingCandidates(senderUserId, pc)
        const answer = await pc.createAnswer()
        await pc.setLocalDescription(answer)
        // Both descriptions now set — safe to cap bitrate.
        await capVideoBitrate(pc)
        wsSend('webrtc_answer', { targetUserId: senderUserId, payload: pc.localDescription })
    }
})

onMessage('webrtc_answer', async ({ senderUserId, payload: answer }) => {
    const pc = peerConnections[senderUserId]
    if (!pc) return
    await pc.setRemoteDescription(new RTCSessionDescription(answer))
    drainPendingCandidates(senderUserId, pc)
    // Both descriptions now set — safe to cap bitrate.
    await capVideoBitrate(pc)
})
```

### ICE Candidate Buffering — Capped at 50

```js
// === ICE CANDIDATES ===
const pendingCandidates      = {}
const MAX_PENDING_CANDIDATES = 50

onMessage('ice_candidate', async ({ senderUserId, candidate }) => {
    const pc = peerConnections[senderUserId]
    if (!pc || !pc.remoteDescription) {
        if (!pendingCandidates[senderUserId]) pendingCandidates[senderUserId] = []
        if (pendingCandidates[senderUserId].length >= MAX_PENDING_CANDIDATES) return
        pendingCandidates[senderUserId].push(candidate)
        return
    }
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
})

const drainPendingCandidates = async (userId, pc) => {
    const queued = pendingCandidates[userId] || []
    delete pendingCandidates[userId]
    for (const candidate of queued) {
        await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
    }
}
```

### Reconnect — Tiered Logic With 2.5s Grace

```js
// === RECONNECT — TIERED LOGIC WITH 2.5s GRACE ===

const onMemberReconnected = async (member) => {
    const existing = peerConnections[member.userId]

    if (existing && existing.connectionState === 'disconnected') {
        // Grace period — wait 2.5s before sending ICE restart offer.
        // Tower switches, lifts, and brief signal drops on Indian mobile networks
        // are common. A self-recovering connection costs zero TURN bandwidth.
        // A premature ICE restart that goes to relay costs real bytes against
        // the 20 GB free tier. 2.5s is imperceptible in a movie watch session.
        await new Promise(resolve => setTimeout(resolve, 2500))

        if (existing.connectionState === 'connected') {
            return  // self-recovered — no ICE restart, no TURN consumed
        }
        if (existing.connectionState !== 'disconnected') {
            return  // moved to 'failed' during wait — 'failed' handler took over
        }

        clearTimeout(reconnectTimers[member.userId])
        delete reconnectTimers[member.userId]
        delete pendingCandidates[member.userId]

        const offer = await existing.createOffer({ iceRestart: true })
        await existing.setLocalDescription(offer)
        wsSend('webrtc_offer', {
            targetUserId: member.userId,
            payload: existing.localDescription
        })
        // capVideoBitrate will be called again on 'connected' via
        // onconnectionstatechange — no need to call it here.

    } else {
        // PC gone — full re-offer.
        if (existing) closePeerConnection(member.userId)

        const [, iceServers] = await Promise.all([
            getLocalStream(),
            getTurnCredentials()
        ])
        await createOffer(member.userId, iceServers)
    }
}
```

### Tile Lifecycle

```js
// === TILE LIFECYCLE ===
const tilesContainer = document.getElementById('tiles')

const createLocalTile = (stream) => {
    const tile          = document.createElement('div')
    tile.className      = 'tile tile-self'
    tile.dataset.userId = roomState.myUserId

    const video         = document.createElement('video')
    video.srcObject     = stream
    video.autoplay      = true
    video.muted         = true
    video.playsinline   = true

    const label         = document.createElement('span')
    label.className     = 'tile-label'
    label.textContent   = roomState.myName + ' (you)'

    tile.append(video, label)
    tilesContainer.append(tile)
}

const attachRemoteTile = (userId, stream) => {
    let tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
    if (!tile) {
        tile                = document.createElement('div')
        tile.className      = 'tile'
        tile.dataset.userId = userId

        const video         = document.createElement('video')
        video.autoplay      = true
        video.playsinline   = true

        const label         = document.createElement('span')
        label.className     = 'tile-label'
        const member        = roomState.members.find(m => m.userId === userId)
        label.textContent   = member ? member.name : userId

        tile.append(video, label)
        tilesContainer.append(tile)
    }
    tile.querySelector('video').srcObject = stream
}

const removeTile = (userId) => {
    const tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
    if (tile) tile.remove()
}
```

### Public API

```js
// === PUBLIC API ===
const webrtc = {

    // Called by ui.js when members.length reaches 2.
    // Warms TURN cache only. getUserMedia not called here.
    onSecondMemberVisible: () => {
        getTurnCredentials().catch(() => {})
    },

    onMemberJoined: async (member) => {
        if (member.userId === roomState.myUserId) return
        await onMemberJoined(member)
    },

    onMemberReconnected: async (member) => {
        if (member.userId === roomState.myUserId) return
        await onMemberReconnected(member)
    },

    onMemberLeft: (userId) => {
        clearTimeout(reconnectTimers[userId])
        delete reconnectTimers[userId]
        closePeerConnection(userId)
    },

    teardownAll: () => {
        Object.keys(reconnectTimers).forEach(uid => clearTimeout(reconnectTimers[uid]))
        Object.keys(peerConnections).forEach(uid => closePeerConnection(uid))
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop())
            localStream        = null
            localStreamPromise = null
        }
        tilesContainer.innerHTML = ''
        turnCredentials          = null
        turnCredentialsExpiresAt = 0
    },
}

window.addEventListener('beforeunload', () => webrtc.teardownAll())
```

---

## Signaling Flow Diagram

### New Member Joining

```
Alice (existing)                SERVER (hub goroutine)           Bob (new joiner)
────────────────                ──────────────────────           ────────────────
members.length → 2
onSecondMemberVisible()
  getTurnCredentials() ← TURN cache warmed silently
  getUserMedia NOT called here

user_joined { Bob }
Promise.all([getLocalStream(), getTurnCredentials()])
  getUserMedia fires ← socially contextual ✓
  TURN hits cache ✓
if stream && no .tile-self → createLocalTile(stream)
createPeerConnection(Bob, iceServers)
  iceCandidatePoolSize: 4 ← pre-gathers immediately
  addTracksToConnection ← localStream live ✓
createOffer → setLocalDescription
  │
  wsSend('webrtc_offer') ─────────────────────────────►  rate limit ok
  │                                                       inject senderUserId
  │
  │                                                       onMessage('webrtc_offer')
  │                                                       Promise.all([getLocalStream(),
  │                                                                    getTurnCredentials()])
  │                                                       existingPc[Alice] → null → fresh
  │                                                       createPeerConnection(Alice)
  │                                                         iceCandidatePoolSize: 4 ✓
  │                                                         addTracksToConnection ✓
  │                                                       setRemoteDescription(offer)
  │                                                       drainPendingCandidates
  │                                                       createAnswer
  │                                                       setLocalDescription(answer)
  │                                                       capVideoBitrate ← both SDP set ✓
  │
  │◄── webrtc_answer { senderUserId: Bob } ────────────  wsSend('webrtc_answer')
  setRemoteDescription(answer)
  drainPendingCandidates
  capVideoBitrate ← both SDP set ✓

  ─ ─ ─ ICE trickling — IPv4 and IPv6 candidates both sent ─ ─ ─
  ─ ─ ─ If both on Jio: IPv6 host candidate wins, zero TURN ─ ─ ─

  'connected' fires on both sides
  capVideoBitrate called again ← ensures cap survives ICE restart later

  ontrack → attachRemoteTile(Bob)                         ontrack → attachRemoteTile(Alice)
```

### Brief Drop — 2.5s Grace Then ICE Restart

```
Alice drops (tower switch, lift, brief signal loss)
  ▼ ~5s  → 'disconnected' on Bob's PC for Alice
  → backstop started (30s), tile stays visible frozen

Alice reconnects within session token TTL
  → server sends user_reconnected { Alice }

Bob: onMemberReconnected(Alice)
  → connectionState === 'disconnected' ✓
  → wait 2.5s

  → if 'connected': return, zero TURN consumed ✓
  → if not 'disconnected': 'failed' handler took over ✓
  → if still 'disconnected': send ICE restart offer

  → clearTimeout(backstop)
  → createOffer({ iceRestart: true }) → wsSend

Alice: onMessage('webrtc_offer')
  → existingPc[Bob] → null → fresh path
  → createPeerConnection(Bob), addTracksToConnection
  → setRemoteDescription, createAnswer, setLocalDescription
  → capVideoBitrate ← both SDP set ✓
  → wsSend('webrtc_answer')

  'connected' fires on both sides → capVideoBitrate re-applied ✓

Bob: existing PC reused, tile never disappeared ✓
Alice: fresh PC, Bob's tile appears on answer ✓
```

### Long Drop — Full Re-offer

```
Alice drops (3–4 min)
  ▼ ~30s → 'failed' → closePeerConnection → tile removed

Alice reconnects within 5 min session token TTL
  → user_reconnected { Alice }

Bob: onMemberReconnected(Alice)
  → no existing PC → full re-offer
  → createOffer → negotiation → capVideoBitrate at each step
  → Alice's tile reappears

member list uninterrupted, host role intact
```

---

## TURN Reduction Measures — Summary

| Measure | How It Reduces TURN | Cost |
|---|---|---|
| Google STUN x2 | More srflx candidates — more direct path attempts | Zero |
| Cloudflare STUN (Mumbai PoP, IPv6) | Low latency STUN for Indian users, finds Jio IPv6 paths | Zero |
| `iceCandidatePoolSize: 4` | Faster gathering — direct path found before relay fallback | Zero |
| All Metered transport variants | Fewer failed TURN attempts wasting bandwidth on retries | Zero |
| 2.5s grace before ICE restart | Mobile blips self-recover without consuming relay bandwidth | Zero |
| No candidate filtering | ICE naturally prefers direct IPv6 (Jio-to-Jio) over relay | Zero |
| 150 Kbps video cap | Halves relay bandwidth per stream vs browser default | Zero |

Realistic floor for Indian userbase: ~35% of connections needing TURN even with all measures applied. The bitrate cap directly doubles the free-tier room-session budget.

---

## Infrastructure — TURN

**Current: Metered managed TURN (free tier)**
- 20 GB relay bandwidth/month free
- ~87 room-sessions/month at 150 Kbps cap and 35–50% TURN usage
- ~3 sessions/day before approaching the limit
- Setup: sign up, copy four env vars, done

**Upgrade path: Oracle Always Free + coturn**
- 10 TB outbound/month free — covers ~32,000 room-sessions/month
- Setup time: 3–6 hours (VM, firewall rules — UDP 3478, TCP 3478, UDP 49152–65535, TLS cert)
- Code change: `turn.go` uncomments HMAC block, env vars swap
- Client code: unchanged

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Both users on Jio mobile | Native IPv6 P2P — ICE finds IPv6 host candidate, zero TURN |
| Jio → home broadband (no IPv6) | IPv4 STUN path, TURN if symmetric NAT |
| Corporate/campus network | TLS/443 TURN variant ensures connectivity through strict firewalls |
| `capVideoBitrate` called before both SDP set | Never happens — call sites are after `setRemoteDescription` on answer, after `setLocalDescription` on offer answer, and on `'connected'` |
| ICE restart resets bitrate params | `capVideoBitrate` called on every `'connected'` — cap always restored |
| `setParameters` rejects (older browser) | `.catch(() => {})` — non-fatal, encoder uses its own selection |
| Multiple users join simultaneously | Promise-cache: one `getUserMedia`, one dialog, one local tile |
| New joiner invisible to room | `getLocalStream()` on answer path — `addTracksToConnection` always has live stream |
| ICE restart offer — PC alive | `existingPc.connectionState !== 'failed'` → reuse PC |
| ICE restart false positive — PC `'failed'` | Guard catches → fresh PC path |
| Mobile blip self-recovers in 2.5s | No ICE restart sent, zero TURN bandwidth |
| Mobile blip still down after 2.5s | ICE restart proceeds |
| ICE candidate before remote description | Buffered, capped at 50 |
| Malicious relay flood | Rate limit 30/s, dropped silently, target never evicted |
| Metered 20 GB exhausted | TURN connections fail, direct paths still work. Upgrade signal. |
| Session > 1 hour | Cache TTL triggers TURN refetch, Metered credentials still valid |
| Camera denied | `localStreamPromise` reset, remote tiles work, retry on next join |

---

## What These Steps Do Not Do

| Thing | Deferred to |
|---|---|
| Web Audio mixer, per-user volume | Step 8 |
| Screen sharing | v2 |
| Mute / unmute remote tracks | v2 |
| Spotlight / fullscreen a tile | Step 9 |
| Chat | Step 9 |
| Self-hosted coturn | When Metered free tier outgrown |

---

## Build Sequence

### Step 6 — Server (verify before any client code)

1. Sign up for Metered. Copy METERED_TURN_HOST`, `METERED_USERNAME`, `METERED_CREDENTIAL` into env config.
2. Add `webrtcSyncWindow time.Time` and `webrtcCount int` to `Client` struct.
3. Add `WebRTCRelayEvent` and `execute()`.
4. Implement `handleWebRTCRelay` — rate limit, room validation, self-send guard, `senderUserId` injection, targeted send.
5. Add `webrtc_offer`, `webrtc_answer`, `ice_candidate` to `readPump`.
6. Create `turn.go` — same-origin check, Google STUN x2, Cloudflare STUN, Metered TURN three variants, `expiresAt` hint, coturn upgrade path in comments.
7. Register `GET /api/turn-credentials` under existing rate limiter.

### Step 7 — Client (after Step 6 verified)

8. Add `#tiles` and `#movie-container` to `index.html`. Add `<script src="/js/webrtc.js">`.
9. Add all CSS. Verify layout with placeholder divs before writing JS.
10. Implement `webrtc.js` in section order:
    - `getTurnCredentials` — 1-hour cache, 60s buffer
    - `getLocalStream` — promise-cached, 320×180@24fps, reset on failure
    - `capVideoBitrate` — 150 Kbps, `.catch(() => {})`, called only after both SDP set
    - `addTracksToConnection`
    - `createPeerConnection` — `iceCandidatePoolSize: 4`, all candidates forwarded (no filtering), `'connected'` calls `capVideoBitrate`, backstop 30s, `'failed'` immediate close
    - `closePeerConnection` — map entry deleted immediately
    - `onMemberJoined` — `Promise.all`, `tile-self` guard, `createOffer`
    - `createOffer` — note: `capVideoBitrate` NOT called here, remote SDP not set yet
    - `onMessage('webrtc_offer')` — `Promise.all`, `tile-self` guard, ICE restart detection with `'failed'` guard, `capVideoBitrate` after `setLocalDescription(answer)` on both branches
    - `onMessage('webrtc_answer')` — `setRemoteDescription`, `drainPendingCandidates`, `capVideoBitrate`
    - `onMessage('ice_candidate')` — 50-cap buffer
    - `drainPendingCandidates`
    - `onMemberReconnected` — 2.5s grace, self-recovery check, ICE restart or full re-offer
    - `createLocalTile`, `attachRemoteTile`, `removeTile`
    - Public API + `beforeunload`
11. Wire `ui.js`.

---

## Test Sequence

### Step 6 — Server (wscat)

1. **Targeted delivery:** A and B same room. `webrtc_offer` targeting B. B receives with `senderUserId` = A. A does not.
2. **Cross-room isolation:** A targets C in different room. Nobody receives it.
3. **Self-send:** A targets own userId. No delivery. No crash.
4. **Missing target:** No delivery. No crash.
5. **All three types:** Repeat test 1 for `webrtc_answer` and `ice_candidate`.
6. **Rate limit:** 35 in 1s. First 30 delivered. 31–35 dropped. Neither evicted.
7. **Rate limit reset:** 30, wait 1s, 30 more. All 60 delivered.
8. **TURN endpoint — valid:** Google STUN x2, Cloudflare STUN, Metered TURN with three URL variants, `expiresAt` ~1 hour from now.
9. **TURN endpoint — wrong origin:** Returns 403.

### Step 7 — Client (browser)

10. **Layout baseline:** Strip at top, movie fills remaining height, controls at bottom. No JS errors.
11. **Solo — no camera prompt:** One tab alone. No `getUserMedia`. No dialog.
12. **TURN prefetch only:** Second tab joins. `/api/turn-credentials` requested. No camera dialog yet.
13. **Camera prompt on signaling:** Dialog appears only when `onMemberJoined` or `onMessage('webrtc_offer')` runs.
14. **`getUserMedia` constraint:** Video track ≤ 320×180, framerate ≤ 24.
15. **Two tabs:** One dialog per tab. One local tile. 120×68px centered. Accent border. `video.muted === true`.
16. **Concurrent join:** Three tabs simultaneously. One dialog and one local tile per tab.
17. **New joiner visible:** A and B in room, C joins. A and B see C. C sees A and B. All six streams flowing.
18. **Bitrate cap applied:** In `chrome://webrtc-internals`, confirm outbound video bitrate does not exceed 150 Kbps once connection is established.
19. **Bitrate cap timing:** Confirm `setParameters` is not called before both SDP descriptions are set. Check for any `InvalidStateError` in console — there should be none.
20. **Bitrate cap survives ICE restart:** After a brief drop and ICE restart, confirm outbound bitrate cap is still ≤ 150 Kbps in `chrome://webrtc-internals`. Confirm `capVideoBitrate` was called on `'connected'` transition.
21. **`iceCandidatePoolSize` effect:** In `chrome://webrtc-internals`, confirm candidates present before offer exchange completes.
22. **No IPv4 filtering:** Both IPv4 and IPv6 candidates in `chrome://webrtc-internals`. None suppressed.
23. **P2P confirmed:** No large payloads on WebSocket. P2P connection type in `chrome://webrtc-internals`.
24. **Three and six users:** Tiles centered, grow outward. Strip stays 84px.
25. **Member leaves:** Tile removed. Re-center CSS only.
26. **ICE candidate cap:** 60 before offer. 50 buffered. Connection establishes.
27. **Camera denied:** Cam-off tile. Remote tabs unaffected. Retry on next join.
28. **2.5s grace — self-recovery:** Brief drop recovers within 2.5s. No ICE restart offer sent. Tile stays visible, unfreezes.
29. **2.5s grace — still disconnected:** Drop does not recover in 2.5s. ICE restart offer sent after grace elapses.
30. **ICE restart false positive:** Bob's PC `'failed'`, Alice's still `'disconnected'`. Bob sends fresh re-offer. Alice detects `'failed'` → fresh path. No `setRemoteDescription` on dead PC.
31. **Backstop at 30s:** Suppress `'failed'`. PC closed at 30s. Not before.
32. **Long drop:** Offline ~35s+. `'failed'`, tile removed. Reconnect. Tile reappears.
33. **Token expiry:** Drop > 5 min. `user_joined`. Full re-offer.
34. **Cache TTL:** Set `turnCredentialsExpiresAt` to past. Next connection refetches.
35. **Teardown:** Tab close. All tracks stopped. Tile removed promptly.
36. **Audio baseline (Step 8 prerequisite):** Document whether movie audio echoes through WebRTC. Baseline for Step 8.