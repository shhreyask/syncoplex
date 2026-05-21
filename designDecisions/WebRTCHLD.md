# Steps 6 & 7 — WebRTC Signaling Server and Camera Tiles — High Level Design

---

## What These Steps Are

**Step 6 — WebRTC Signaling Server:** One new Go file (`turn.go`) and additions to `hub.go` and `main.go`. Purely server-side. The server learns to route SDP and ICE messages between specific peers in the same room, and broadcast mic-state changes to the room. No client code. Fully testable with `wscat` before a single line of `webrtc.js` is written.

**Step 7 — Camera Tiles:** Two new JS files (`icons.js`, `webrtc.js`) and additions to `index.html`, `style.css`, and `ui.js`. Purely client-side. Peer connections are created, local camera and microphone streams are acquired, and tiles are rendered in a fixed strip above the movie. Media controls (mic, video, leave) are rendered as an overlay on the right edge of the watch view window. The server code from Step 6 is the relay — Step 7 is everything that uses it.

These two steps are documented together because they form one feature. A reader of the signaling protocol needs to understand what the client does with it, and a reader of `webrtc.js` needs to understand how the server routes its messages. The build sequence keeps them strictly separated — Step 6 is verified before Step 7 begins.

**Principles applied:**

- **Secure** — signaling messages are only routable to users in the same room. `targetUserId` is validated server-side before any bytes are forwarded. `senderUserId` is injected by the server — a client cannot impersonate another. TURN credentials are served from the backend — Metered credentials never appear in client source. WebRTC relay messages are rate-limited on the hub goroutine — a malicious client cannot flood a target's send buffer and trigger an innocent user's eviction.
- **Fast** — ICE trickling means the first candidate pair is tried immediately while gathering continues. `getUserMedia` and TURN credential fetch are parallelised on both the offer path (`_onMemberJoined`) and the answer path (`handleInboundOffer`) — latency is `max(getUserMedia_time, turn_fetch_time)` not their sum. TURN credentials are prefetched silently when the second member appears in room state. `getUserMedia` is deferred until the file verdict is valid — the socially contextual moment. `iceCandidatePoolSize: 4` pre-gathers candidates before the offer is sent, reducing time-to-first-candidate on slow mobile networks.
- **Smooth** — the reconnect model is tiered. A brief drop (PC still `disconnected`) waits 2.5 seconds before sending an ICE restart offer — giving mobile connections a chance to self-recover before consuming TURN bandwidth. A longer drop (PC reached `failed`) closes the tile cleanly and performs a full re-offer on return. TURN credential cache is bounded by a client-side TTL. Video bitrate cap is re-applied on every `'connected'` transition so ICE restarts do not silently reset it. Media controls fade in/out with the movie controls bar — never obstructing the view.
- **Light** — the server adds two event types (WebRTC relay + mic state broadcast) and two handlers. No SDP parsing, no media inspection, no new persistent structures beyond a rate-limit counter on `Client`. The tile layout is pure CSS flexbox. `getUserMedia` is constrained to 320×180. Video encoder is capped at 150 Kbps — tiles are 120×68px, the browser's default 300–500 Kbps for this resolution is pure waste, and every byte relayed through TURN counts against the 20 GB free tier. `webrtc.js` is the sole owner of peer connections. Icons are inline SVGs in a separate constants file — zero external loads.

**Permission timing:** `getUserMedia` is NOT called when signaling starts or when members join. It is called exactly once — after the file verdict is `valid`, before transitioning to the watch view. This ensures the browser's camera/mic permission dialog appears at the right moment: after the user has committed to watching (picked a valid file) but before they see the movie. A `webrtcReady` flag gates all outbound signaling and buffers inbound offers until permissions are settled. `connectToExistingMembers()` drains buffered offers and initiates connections after entering watch view.

**Tile appearance timing:** Remote tiles never appear when a user joins the lobby. They appear only when a WebRTC connection is established (`ontrack` fires) or when `connectToExistingMembers` processes buffered offers. This prevents showing phantom tiles for users who are still in the lobby picking a file.

**Audio routing scope boundary:** `addTracksToConnection` in this step adds mic audio and camera video from `localStream` — both correct. `webrtc.js` structurally never holds a reference to the main `<video>` element, so movie audio cannot enter WebRTC by accident. Step 8 introduces a Web Audio mixer for per-user volume control and explicit track selection — it is not fixing a bug in Step 7, it is adding new capability on top of this foundation.

**Mic mute signaling:** `track.enabled = false` on the local side does NOT trigger `onmute`/`onunmute` events on the remote side — those events only fire for network-level issues. Remote mic mute indicators are driven by a `mic_state` WebSocket message broadcast to the room. The server relays this with `senderUserId` injected, same security model as all other signaling.

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
│                       Add MicStateEvent{client, muted}
│                       Add handleMicState — broadcastToOthers with senderUserId
│                       Add mic_state case to readPump switch
└── turn.go             NEW — GET /api/turn-credentials handler
                        Calls Metered REST API server-side for ephemeral creds (4hr TTL)
                        Server-side cache (10 min) to avoid hammering Metered API
                        API key never leaves server — clients get only ephemeral creds
                        Base STUN servers (Google x2 + Cloudflare Mumbai)
                        Cache-Control: no-store header
                        Origin check (allows empty — ephemeral creds bound abuse)
                        Registered in main.go under existing rate limiter

Step 7 — Client only:

frontend/public/js/
├── icons.js            NEW — ICONS constant object containing inline SVG strings
│                       for mic on/off, video on/off, leave (phone down), and
│                       tile mic-off indicator. Google Meet style. Zero external loads.
├── webrtc.js           NEW — peer connection lifecycle, webrtcReady gate,
│                       pendingOffers buffer for inbound offers before ready,
│                       connectToExistingMembers drains buffer + sends offers,
│                       iceCandidatePoolSize: 4,
│                       multiple STUN servers (Google x2 + Cloudflare Mumbai),
│                       promise-cached getUserMedia constrained to 320×180,
│                       capVideoBitrate (150 Kbps) applied after both descriptions
│                       set and re-applied on every 'connected' transition,
│                       parallelised getUserMedia + TURN fetch on both offer and
│                       answer paths, TURN-only prefetch on second member
│                       appearance, TURN expiry-aware cache, 2.5s delay before
│                       ICE restart offer, ICE restart detection on answer path
│                       guarded against 'failed' state, ICE candidate buffering
│                       with 50-cap, backstop timer at 30s, tiered reconnect,
│                       media controls overlay (right window edge) with
│                       stopPropagation, mic state broadcast via WebSocket,
│                       tile mic-off indicator driven by mic_state messages
└── ui.js               Wire user_joined → webrtc.onMemberJoined
                        Wire user_reconnected → webrtc.onMemberReconnected
                        Wire user_left → webrtc.onMemberLeft
                        Call webrtc.onSecondMemberVisible() when members.length
                        reaches 2 (warms TURN cache only)
                        tryEnterWatch: await webrtc.requestPermissions() after
                        valid verdict, before showView('watch'), then call
                        webrtc.connectToExistingMembers(roomState.members)
                        resetHideTimer: toggle #webrtc-controls visibility
                        alongside #controls-bar

frontend/public/
├── index.html          Add #tiles strip and #movie-container structural divs
│                       inside #view-watch
│                       Add <script src="/js/icons.js"> before webrtc.js
│                       Add <script src="/js/webrtc.js"> after icons.js
└── style.css           Add tile strip layout, #movie-container, .tile,
                        .tile-self, .tile-label (z-index: 1), .tile-cam-off,
                        .tile-mic-off indicator, #webrtc-controls overlay,
                        .wc-btn, .wc-btn-off, .wc-btn-leave,
                        #webrtc-controls.hidden
```

No Redis schema changes. No new HTTP routes beyond `/api/turn-credentials`.

Script loading order in `index.html`:

```html
<!-- JS — order matters: state → ws → player → sync → fileVerify → icons → webrtc → ui -->
<script src="/js/state.js"></script>
<script src="/js/ws.js"></script>
<script src="/js/player.js"></script>
<script src="/js/sync.js"></script>
<script src="/js/fileVerify.js"></script>
<script src="/js/icons.js"></script>
<script src="/js/webrtc.js"></script>
<script src="/js/ui.js"></script>
```

---

## Environment Config

```
METERED_TURN_HOST     syncoplex.metered.live
METERED_API_KEY       <from Metered dashboard>
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
icons.js owns:
  - ICONS constant object with inline SVG strings
  - micOn, micOff, vidOn, vidOff, leave, tileMicOff
  - Google Meet style, all white fill except micOff/vidOff (#ea4335)
    and tileMicOff (white)
  - nothing else — no logic, no DOM, no state

webrtc.js owns:
  - webrtcReady flag — false until requestPermissions() resolves
  - pendingOffers buffer — inbound offers queued before webrtcReady
  - creating and closing RTCPeerConnection objects (one per remote peer)
  - iceCandidatePoolSize: 4 — pre-gather candidates before offer is sent
  - iceServers: Google STUN x2, Cloudflare STUN (Mumbai PoP, IPv6),
    Metered TURN with all transport variants (UDP/80, TCP/80, TLS/443)
  - fetching and caching TURN credentials with 1-hour client-side TTL
  - calling getUserMedia exactly once via promise-caching
  - constraining getUserMedia to 320×180, 24fps
  - deferring getUserMedia until file verdict is valid (requestPermissions)
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
  - tile creation, update, and removal — remote tiles appear only on ontrack
    or connectToExistingMembers, never on user_joined
  - muting the local tile video (always — prevents feedback)
  - media controls overlay — right edge of window, stopPropagation on all
    events so movie player never receives button clicks
  - mic mute indicator on tiles — local via button handler, remote via
    mic_state WebSocket message
  - broadcasting mic_state to server on local mute/unmute
  - teardown on room leave or tab close

webrtc.js does NOT:
  - filter ICE candidates by address family — ICE handles IPv4 and IPv6
    simultaneously; filtering would break home broadband and campus users
  - call setParameters before both SDP descriptions are set — encoder is
    not initialised until negotiation completes
  - show tiles for users still in the lobby — tiles appear only after
    WebRTC connection establishment
  - use track.onmute/onunmute for mic indicators — those events don't fire
    for intentional track.enabled changes on the remote side

ui.js additions:
  - user_joined       → webrtc.onMemberJoined(member)
  - user_reconnected  → webrtc.onMemberReconnected(member)
  - user_left         → webrtc.onMemberLeft(userId)
  - members.length reaches 2 → webrtc.onSecondMemberVisible()
  - tryEnterWatch:
      1. await webrtc.requestPermissions() — prompts camera/mic
      2. showView('watch')
      3. webrtc.connectToExistingMembers(roomState.members) — drains
         buffered offers, sends offers to existing room members
  - resetHideTimer: toggles #webrtc-controls.hidden alongside
    #controls-bar.hidden on mouse activity / 3s timeout

turn.go owns:
  - GET /api/turn-credentials
  - same-origin enforcement
  - Metered credentials from env config, all transport variants
  - nothing else

hub.go additions:
  - WebRTCRelayEvent — targeted peer-to-peer signaling relay
  - MicStateEvent — broadcast mic mute/unmute to room (excluding sender)
  - handleWebRTCRelay — rate limit, room validation, senderUserId injection
  - handleMicState — broadcastToOthers with senderUserId
  - readPump cases: webrtc_offer, webrtc_answer, ice_candidate, mic_state
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

`mic_state` uses `broadcastToOthers` — it is not targeted because all room members need to see the mute indicator, not just one peer.

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

### New Event Types

```go
// hub.go — WebRTC targeted relay
type WebRTCRelayEvent struct {
    client       *Client
    targetUserId string
    data         []byte
}

func (e *WebRTCRelayEvent) execute(h *Hub) {
    h.handleWebRTCRelay(e.client, e.targetUserId, e.data)
}

// hub.go — mic state broadcast
type MicStateEvent struct {
    client *Client
    muted  bool
}

func (e *MicStateEvent) execute(h *Hub) { h.handleMicState(e.client, e.muted) }
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

### `handleMicState`

```go
func (h *Hub) handleMicState(c *Client, muted bool) {
    h.broadcastToOthers(c.roomCode, c.userId, makeEnvelope("mic_state", map[string]interface{}{
        "senderUserId": c.userId,
        "muted":        muted,
    }))
}
```

### `readPump` Cases

```go
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
    mic_state         { muted: true|false }

Server → Client (targeted — WebRTC signaling):
    webrtc_offer      { senderUserId: "<uuid>", payload: { type: "offer",  sdp: "..." } }
    webrtc_answer     { senderUserId: "<uuid>", payload: { type: "answer", sdp: "..." } }
    ice_candidate     { senderUserId: "<uuid>", candidate: { ... } }

Server → Client (broadcast to room — mic state):
    mic_state         { senderUserId: "<uuid>", muted: true|false }
```

`senderUserId` is always server-injected. A client supplying its own is overwritten.

---

## Step 7 — Camera Tiles

### Permission Timing — After File Pick, Before Watch View

```
User picks file → hash computed → server verdict arrives → VALID
    ↓
webrtc.requestPermissions()
    → getLocalStream() → getUserMedia prompt
    → webrtcReady = true
    ↓
showView('watch')
    ↓
webrtc.connectToExistingMembers(roomState.members)
    → drains pendingOffers (inbound offers buffered while in lobby)
    → sends offers to all existing room members not yet connected
```

**Why not prompt earlier?** Prompting on room join or member arrival is premature — the user hasn't committed to watching yet. Prompting during file hashing creates a confusing dual-dialog. The right moment is after the file is verified but before the movie appears.

**Why a `webrtcReady` flag?** When user 1 is in watch view and user 2 joins the lobby, user 1 sends a `webrtc_offer` to user 2. Without gating, user 2's `onMessage('webrtc_offer')` handler calls `getLocalStream()` which triggers the camera permission prompt while the user is still in the lobby picking a file. The `webrtcReady` flag prevents this — inbound offers are buffered in `pendingOffers` and processed after permissions are settled.

### Tile Appearance Timing

Remote tiles do NOT appear when a user joins the room. They appear only when:

1. **`ontrack` fires** — the WebRTC connection is established and media is flowing. This is the `attachRemoteTile` path.
2. **`connectToExistingMembers` runs** — after entering watch view, `ensureRemoteTile` is called for each member being connected to.

This prevents showing a tile with a black video for a user who is still in the lobby choosing a file. From user 1's perspective, user 2's tile appears only when user 2 has actually entered watch view and the peer connection is active.

### Layout — Tile Strip Above the Movie

```
┌──────────────────────────────────────────────────┐
│         ┌──────┐ ┌──────┐ ┌──────┐              │  ← #tiles strip, 84px tall
│         │ You  │ │Alice │ │ Bob  │              │     center-aligned
│         └──────┘ └──────┘ └──────┘              │
├──────────────────────────────────────────────────┤
│                   <video>                     ┌─┐│
│  ┌────────────────────────────────────────────┤🎤││  ← #webrtc-controls overlay
│  │                                            ├─┤│    right edge of window
│  │                                            │📹││    vertically centered
│  │                                            ├─┤│    auto-hides with controls bar
│  │                                            │✕ ││
│  │                                            └─┘│
│  │                                                │
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
  <!-- #webrtc-controls div injected by webrtc.js at runtime -->
</section>
```

### CSS

```css
#view-watch {
    display: flex;
    flex-direction: column;
    height: 100vh;
    background: #000;
    overflow: hidden;
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
    border-radius: var(--radius);
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
    z-index: 1;  /* above .tile-cam-off::after */
}

.tile-cam-off video { display: none; }

.tile-cam-off::after {
    content: '';
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #111;
}

.tile-mic-off {
    position: absolute;
    bottom: 3px;
    right: 5px;
    line-height: 0;
    z-index: 1;
    pointer-events: none;
}
```

### Media Controls Overlay — `#webrtc-controls`

A vertical strip pinned to the right edge of `#view-watch` via `position: absolute`. Contains three buttons: mic toggle, video toggle, leave. Uses inline SVG icons from `ICONS` constant (loaded from `icons.js`).

**Key design decisions:**

- **Right edge of window, not inside tiles.** Controls affect the local user's global state (mic, camera, leave) — they belong at the window level, not per-tile.
- **Overlay over the movie.** The panel sits at `z-index: 30`, above both the controls bar (`z-index: 5`) and the file picker overlay (`z-index: 10`).
- **`stopPropagation` on all events.** `click`, `mousedown`, and `pointerdown` are all stopped. The movie player never receives button clicks — no accidental pause/play.
- **Auto-hide with JS timer.** Visibility is toggled by the same `resetHideTimer` function that manages the controls bar. Both appear on mouse movement, both fade after 3 seconds of inactivity. No CSS-only hover approach — it was unreliable due to conflicting selectors.

```css
#webrtc-controls {
    position: absolute;
    top: 50%;
    right: 0;
    transform: translateY(-50%);
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 8px 6px;
    background: rgba(0, 0, 0, 0.7);
    border-radius: var(--radius) 0 0 var(--radius);
    opacity: 1;
    pointer-events: auto;
    transition: opacity 0.3s;
    z-index: 30;
}

#webrtc-controls.hidden {
    opacity: 0;
    pointer-events: none;
}

.wc-btn {
    width: 32px;
    height: 32px;
    border: none;
    border-radius: var(--radius);
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
    font-size: 1rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0;
    transition: background 0.15s;
}

.wc-btn:hover { background: rgba(255, 255, 255, 0.25); }
.wc-btn-off   { background: rgba(255, 77, 77, 0.4); }
.wc-btn-off:hover { background: rgba(255, 77, 77, 0.6); }
.wc-btn-leave { background: rgba(255, 77, 77, 0.5); margin-top: 4px; }
.wc-btn-leave:hover { background: rgba(255, 77, 77, 0.8); }
```

### Icons — `icons.js`

Inline SVG strings stored in a global `ICONS` constant. Google Meet style. Loaded before `webrtc.js`. Zero external HTTP requests.

```js
const ICONS = {
    micOn:      '<svg viewBox="0 0 24 24" width="18" height="18" fill="white">...</svg>',
    micOff:     '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335">...</svg>',
    vidOn:      '<svg viewBox="0 0 24 24" width="18" height="18" fill="white">...</svg>',
    vidOff:     '<svg viewBox="0 0 24 24" width="18" height="18" fill="#ea4335">...</svg>',
    leave:      '<svg viewBox="0 0 24 24" width="18" height="18" fill="white">...</svg>',
    tileMicOff: '<svg viewBox="0 0 24 24" width="12" height="12" fill="white">...</svg>',
}
```

`tileMicOff` uses white fill (not red) — the tile is small, red would be visually aggressive.

### Mic Mute Indicators on Tiles

`track.enabled = false` on the sender does NOT trigger `onmute`/`onunmute` on the remote receiver. Those events fire only for network-level issues (packet loss, bandwidth adaptation), not intentional application-level muting.

**Solution: `mic_state` WebSocket message.**

Local mute flow:
```
User clicks mic button
    → track.enabled = false
    → btnMic.innerHTML = ICONS.micOff
    → updateTileMicIndicator(selfTile, true) — adds .tile-mic-off span
    → wsSend('mic_state', { muted: true })
```

Server relay:
```
readPump parses mic_state → MicStateEvent → handleMicState
    → broadcastToOthers(roomCode, userId, { senderUserId, muted })
```

Remote indicator:
```
onMessage('mic_state', { senderUserId, muted })
    → find tile by data-user-id
    → updateTileMicIndicator(tile, muted)
    → if muted: append .tile-mic-off span with ICONS.tileMicOff
    → if unmuted: remove .tile-mic-off span
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
- **Answerer:** in `handleInboundOffer`, after `setLocalDescription(answer)` — both descriptions now set
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
// === STATE ===                       ← webrtcReady flag
// === TURN CREDENTIALS (1-hour client-side cache) ===
// === LOCAL STREAM (promise-cached, constrained to 320×180@24fps) ===
// === BITRATE CAP ===
// === PEER CONNECTION MANAGEMENT ===
// === SIGNALING — OFFER / ANSWER ===  ← pendingOffers buffer, handleInboundOffer
// === ICE CANDIDATES (buffered, capped at 50) ===
// === RECONNECT — TIERED LOGIC WITH 2.5s GRACE ===
// === TILE LIFECYCLE ===
// === TILE MIC INDICATOR ===          ← updateTileMicIndicator, onMessage('mic_state')
// === MEDIA CONTROLS OVERLAY ===      ← #webrtc-controls, IIFE, stopPropagation
// === PUBLIC API ===                  ← requestPermissions, connectToExistingMembers
```

### TURN Credentials

```js
let turnCredentials          = null
let turnCredentialsExpiresAt = 0

const getTurnCredentials = async () => {
    if (turnCredentials && Date.now() < turnCredentialsExpiresAt - 60_000) {
        return turnCredentials
    }
    const res = await fetch('/api/turn-credentials')
    if (!res.ok) throw new Error('turn-credentials fetch failed')
    const data               = await res.json()
    turnCredentials          = data.iceServers
    turnCredentialsExpiresAt = data.expiresAt
    return turnCredentials
}
```

### `getUserMedia` — Promise-Cached, Constrained, Deferred

```js
let localStream        = null
let localStreamPromise = null
let permissionDenied   = false

const getLocalStream = async () => {
    if (localStream) return localStream
    if (permissionDenied) return null

    if (!localStreamPromise) {
        localStreamPromise = navigator.mediaDevices.getUserMedia({
            video: {
                width:     { max: 320 },
                height:    { max: 180 },
                frameRate: { max: 24  }
            },
            audio: true
        })
        .then(stream => {
            localStream = stream
            permissionDenied = false
            return stream
        })
        .catch(() => {
            localStreamPromise = null
            permissionDenied = true
            return null
        })
    }

    return localStreamPromise
}
```

`getUserMedia` fires only when `requestPermissions()` is called — after the file verdict is valid, before entering watch view. Not on member join, not on `onSecondMemberVisible`.

### Peer Connection Management

```js
const peerConnections   = {}
const reconnectTimers   = {}
const pendingCandidates = {}

const createPeerConnection = async (remoteUserId, iceServers) => {
    const pc = new RTCPeerConnection({
        iceServers,
        iceCandidatePoolSize: 4
    })
    peerConnections[remoteUserId] = pc

    pc.onicecandidate = ({ candidate }) => {
        if (!candidate) return
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
    delete peerConnections[userId]
    delete pendingCandidates[userId]
    removeTile(userId)
}

const addTracksToConnection = (pc) => {
    if (!localStream) return
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
}
```

### Offer / Answer — With webrtcReady Gate and Inbound Offer Buffering

Both paths call `Promise.all([getLocalStream(), getTurnCredentials()])` before touching any peer connection. Without `getLocalStream()` on the answer path, `addTracksToConnection` runs while `localStream` is null — the new joiner answers with zero tracks and is invisible to the room.

`capVideoBitrate` is called after both descriptions are set on each path.

**The `webrtcReady` gate:**

- `_onMemberJoined` — early returns if `!webrtcReady`. Users who join the room while we're still in the lobby are ignored. We connect to them via `connectToExistingMembers` when we enter watch view.
- `onMessage('webrtc_offer')` — if `!webrtcReady`, the offer is buffered in `pendingOffers[senderUserId]` (latest offer wins). When `connectToExistingMembers` runs, it drains these buffered offers first, then sends fresh offers to anyone not yet connected.
- `_onMemberReconnected` — early returns if `!webrtcReady`.

```js
const pendingOffers = {}

const _onMemberJoined = async (member) => {
    if (member.userId === roomState.myUserId) return
    if (!webrtcReady) return

    const [stream, iceServers] = await Promise.all([
        getLocalStream(),
        getTurnCredentials()
    ])

    if (!tilesContainer.querySelector('.tile-self')) {
        createLocalTile(stream)
    }

    // No ensureRemoteTile here — tile appears only when the remote
    // user enters watch view, answers our offer, and ontrack fires.
    await createOffer(member.userId, iceServers)
}

const createOffer = async (remoteUserId, iceServers) => {
    const pc = await createPeerConnection(remoteUserId, iceServers)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    wsSend('webrtc_offer', { targetUserId: remoteUserId, payload: pc.localDescription })
}

const handleInboundOffer = async (senderUserId, offer) => {
    const [stream, iceServers] = await Promise.all([
        getLocalStream(),
        getTurnCredentials()
    ])

    if (!tilesContainer.querySelector('.tile-self')) {
        createLocalTile(stream)
    }

    const existingPc = peerConnections[senderUserId]

    if (existingPc && existingPc.connectionState !== 'failed') {
        // ICE restart — reuse existing PC.
        await existingPc.setRemoteDescription(new RTCSessionDescription(offer))
        drainPendingCandidates(senderUserId, existingPc)
        const answer = await existingPc.createAnswer()
        await existingPc.setLocalDescription(answer)
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
        await capVideoBitrate(pc)
        wsSend('webrtc_answer', { targetUserId: senderUserId, payload: pc.localDescription })
    }
}

onMessage('webrtc_offer', async ({ senderUserId, payload: offer }) => {
    if (!webrtcReady) {
        // Buffer — will be processed in connectToExistingMembers
        pendingOffers[senderUserId] = offer
        return
    }
    await handleInboundOffer(senderUserId, offer)
})

onMessage('webrtc_answer', async ({ senderUserId, payload: answer }) => {
    const pc = peerConnections[senderUserId]
    if (!pc) return
    await pc.setRemoteDescription(new RTCSessionDescription(answer))
    drainPendingCandidates(senderUserId, pc)
    await capVideoBitrate(pc)
})
```

### ICE Candidate Buffering — Capped at 50

```js
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
const _onMemberReconnected = async (member) => {
    if (!webrtcReady) return

    const existing = peerConnections[member.userId]

    if (existing && existing.connectionState === 'disconnected') {
        await new Promise(resolve => setTimeout(resolve, 2500))

        if (peerConnections[member.userId] !== existing) return

        if (existing.connectionState === 'connected') return
        if (existing.connectionState !== 'disconnected') return

        clearTimeout(reconnectTimers[member.userId])
        delete reconnectTimers[member.userId]
        delete pendingCandidates[member.userId]

        const offer = await existing.createOffer({ iceRestart: true })
        await existing.setLocalDescription(offer)
        wsSend('webrtc_offer', {
            targetUserId: member.userId,
            payload: existing.localDescription
        })

    } else {
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
const tilesContainer = document.getElementById('tiles')

const createLocalTile = (stream) => {
    const tile          = document.createElement('div')
    tile.className      = 'tile tile-self'
    tile.dataset.userId = roomState.myUserId

    const video         = document.createElement('video')
    video.autoplay      = true
    video.muted         = true     // always — prevents feedback
    video.playsInline   = true

    if (stream) {
        video.srcObject = stream
    } else {
        tile.classList.add('tile-cam-off')
    }

    const label         = document.createElement('span')
    label.className     = 'tile-label'
    label.textContent   = (roomState.myName || 'You') + ' (you)'

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
        video.playsInline   = true

        const label         = document.createElement('span')
        label.className     = 'tile-label'
        const member        = roomState.members.find(m => m.userId === userId)
        label.textContent   = member ? member.name : userId

        tile.append(video, label)
        tilesContainer.append(tile)
    }

    const videoEl = tile.querySelector('video')
    videoEl.srcObject = stream

    const hasVideo = stream && stream.getVideoTracks().length > 0 &&
                     stream.getVideoTracks().some(t => t.enabled)
    tile.classList.toggle('tile-cam-off', !hasVideo)

    if (stream) {
        stream.getVideoTracks().forEach(track => {
            track.onmute   = () => tile.classList.add('tile-cam-off')
            track.onunmute = () => tile.classList.remove('tile-cam-off')
        })
        // Audio mute indicator is handled via 'mic_state' WebSocket
        // messages, not track events (track.enabled changes don't
        // fire onmute on the remote side).
    }
}

const ensureRemoteTile = (userId, name) => {
    if (tilesContainer.querySelector(`[data-user-id="${userId}"]`)) return
    const tile          = document.createElement('div')
    tile.className      = 'tile tile-cam-off'
    tile.dataset.userId = userId

    const video         = document.createElement('video')
    video.autoplay      = true
    video.playsInline   = true

    const label         = document.createElement('span')
    label.className     = 'tile-label'
    label.textContent   = name || userId

    tile.append(video, label)
    tilesContainer.append(tile)
}

const removeTile = (userId) => {
    const tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
    if (tile) tile.remove()
}
```

### Tile Mic Indicator

```js
const updateTileMicIndicator = (tile, muted) => {
    let mic = tile.querySelector('.tile-mic-off')
    if (muted) {
        if (!mic) {
            mic = document.createElement('span')
            mic.className = 'tile-mic-off'
            mic.innerHTML = ICONS.tileMicOff
            tile.appendChild(mic)
        }
    } else if (mic) {
        mic.remove()
    }
}

// Remote mic state — broadcast by the muting user, relayed by server
onMessage('mic_state', ({ senderUserId, muted }) => {
    const tile = tilesContainer.querySelector(`[data-user-id="${senderUserId}"]`)
    if (tile) updateTileMicIndicator(tile, muted)
})
```

### Media Controls Overlay

```js
const controlsOverlay = (() => {
    const panel = document.createElement('div')
    panel.id = 'webrtc-controls'
    panel.addEventListener('click',       (e) => e.stopPropagation())
    panel.addEventListener('mousedown',   (e) => e.stopPropagation())
    panel.addEventListener('pointerdown', (e) => e.stopPropagation())

    // Mic toggle — updates local tile indicator + broadcasts to room
    const btnMic = document.createElement('button')
    btnMic.className = 'wc-btn'
    btnMic.innerHTML = ICONS.micOn
    btnMic.title = 'Toggle microphone'
    btnMic.addEventListener('click', (e) => {
        e.stopPropagation()
        if (!localStream) return
        const track = localStream.getAudioTracks()[0]
        if (!track) return
        track.enabled = !track.enabled
        btnMic.innerHTML = track.enabled ? ICONS.micOn : ICONS.micOff
        btnMic.classList.toggle('wc-btn-off', !track.enabled)
        const selfTile = tilesContainer.querySelector('.tile-self')
        if (selfTile) updateTileMicIndicator(selfTile, !track.enabled)
        wsSend('mic_state', { muted: !track.enabled })
    })

    // Video toggle
    const btnVid = document.createElement('button')
    btnVid.className = 'wc-btn'
    btnVid.innerHTML = ICONS.vidOn
    btnVid.title = 'Toggle camera'
    btnVid.addEventListener('click', (e) => {
        e.stopPropagation()
        if (!localStream) return
        const track = localStream.getVideoTracks()[0]
        if (!track) return
        track.enabled = !track.enabled
        btnVid.innerHTML = track.enabled ? ICONS.vidOn : ICONS.vidOff
        btnVid.classList.toggle('wc-btn-off', !track.enabled)
        const selfTile = tilesContainer.querySelector('.tile-self')
        if (selfTile) selfTile.classList.toggle('tile-cam-off', !track.enabled)
    })

    // Leave
    const btnLeave = document.createElement('button')
    btnLeave.className = 'wc-btn wc-btn-leave'
    btnLeave.innerHTML = ICONS.leave
    btnLeave.title = 'Leave room'
    btnLeave.addEventListener('click', (e) => {
        e.stopPropagation()
        webrtc.teardownAll()
        disconnect()
        resetRoomState()
        history.pushState({}, '', '/')
        showView('landing')
    })

    panel.append(btnMic, btnVid, btnLeave)
    document.getElementById('view-watch').appendChild(panel)
    return panel
})()
```

### Public API

```js
const webrtc = {

    // Called after file verdict is valid, before entering watch view.
    // Prompts for camera/mic. Sets webrtcReady so signaling can begin.
    requestPermissions: async () => {
        try {
            await getLocalStream()
        } catch {
            permissionDenied = true
        }
        webrtcReady = true
    },

    // Called by ui.js after entering watch view.
    // Drains buffered inbound offers, then sends offers to everyone
    // already in the room that we haven't connected to yet.
    connectToExistingMembers: async (members) => {
        if (!webrtcReady) return

        const [stream, iceServers] = await Promise.all([
            getLocalStream(),
            getTurnCredentials()
        ])

        if (!tilesContainer.querySelector('.tile-self')) {
            createLocalTile(stream)
        }

        // First, answer any offers that arrived while we were in the lobby
        for (const [senderUserId, offer] of Object.entries(pendingOffers)) {
            const member = roomState.members.find(m => m.userId === senderUserId)
            ensureRemoteTile(senderUserId, member ? member.name : senderUserId)
            await handleInboundOffer(senderUserId, offer)
        }
        for (const key of Object.keys(pendingOffers)) delete pendingOffers[key]

        // Then send offers to anyone we haven't connected to yet
        for (const member of members) {
            if (member.userId === roomState.myUserId) continue
            if (peerConnections[member.userId]) continue
            ensureRemoteTile(member.userId, member.name)
            await createOffer(member.userId, iceServers)
        }
    },

    // Called by ui.js when members.length reaches 2.
    // Warms TURN cache only. getUserMedia not called here.
    onSecondMemberVisible: () => {
        getTurnCredentials().catch(() => {})
    },

    onMemberJoined: async (member) => {
        if (member.userId === roomState.myUserId) return
        await _onMemberJoined(member)
    },

    onMemberReconnected: async (member) => {
        if (member.userId === roomState.myUserId) return
        await _onMemberReconnected(member)
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
        permissionDenied = false
        webrtcReady      = false
        tilesContainer.innerHTML = ''
        turnCredentials          = null
        turnCredentialsExpiresAt = 0
        for (const key of Object.keys(pendingOffers)) delete pendingOffers[key]
    },
}

window.addEventListener('beforeunload', () => webrtc.teardownAll())
```

---

## `ui.js` Additions — Watch Transition and Auto-Hide

### `tryEnterWatch` — Permission → Watch → Connect

```js
let pendingWatchTransition = false

const tryEnterWatch = async () => {
    const ready = roomState.fileState !== FILE_STATES.WAITING &&
                  roomState.fileState !== FILE_STATES.HASHING
    if (roomState.fileVerdict === FILE_VERDICTS.VALID && ready) {
        // Prompt for camera/mic — after file is verified, before watch view.
        await webrtc.requestPermissions()
        showView('watch')
        render()
        pendingWatchTransition = false
        // Now that we're in watch view with permissions settled,
        // connect to everyone already in the room.
        webrtc.connectToExistingMembers(roomState.members)
    } else {
        pendingWatchTransition = true
    }
}

document.addEventListener('fileVerify:verdict', (e) => {
    if (e.detail.verdict === FILE_VERDICTS.VALID) {
        tryEnterWatch()
    }
})
```

### `resetHideTimer` — Controls Bar + WebRTC Controls

```js
const resetHideTimer = () => {
    if (document.body.dataset.view !== 'watch') return
    const webrtcControls = document.getElementById('webrtc-controls')
    if (!controlsVisible) {
        controlsBar.classList.remove('hidden')
        if (webrtcControls) webrtcControls.classList.remove('hidden')
        controlsVisible = true
    }
    clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
        if (!video.paused) {
            controlsBar.classList.add('hidden')
            if (webrtcControls) webrtcControls.classList.add('hidden')
            controlsVisible = false
        }
    }, 3000)
}
```

### WebRTC Event Wiring

```js
let secondMemberNotified = false

onMessage('user_joined', (payload) => {
    webrtc.onMemberJoined({ userId: payload.userId, name: payload.name })
    if (!secondMemberNotified && roomState.members.length >= 1) {
        secondMemberNotified = true
        webrtc.onSecondMemberVisible()
    }
})

onMessage('user_reconnected', (payload) => {
    webrtc.onMemberReconnected({ userId: payload.userId, name: payload.name })
})

onMessage('user_left', (payload) => {
    webrtc.onMemberLeft(payload.userId)
})

onMessage('room_state', () => {
    if (!secondMemberNotified && roomState.members.length >= 1) {
        secondMemberNotified = true
        webrtc.onSecondMemberVisible()
    }
})
```

---

## Signaling Flow Diagram

### New Member Joining — With webrtcReady Gate

```
Alice (in watch view)           SERVER (hub goroutine)           Bob (in lobby)
─────────────────────           ──────────────────────           ──────────────

Bob connects to WS
Bob enters lobby
                                                                 picks file →
                                                                 hash computed →
                                                                 file_fileVerify sent

                                fileVerify_verdict: valid ──────► verdict arrives
                                                                 webrtc.requestPermissions()
                                                                   getUserMedia prompt
                                                                   webrtcReady = true
                                                                 showView('watch')
                                                                 connectToExistingMembers()

Alice may have already sent webrtc_offer while Bob was in lobby:
    Alice sends webrtc_offer ──► relay to Bob ──────────────────► !webrtcReady → buffer
                                                                  pendingOffers[Alice] = offer

connectToExistingMembers runs:
    drain pendingOffers:
        ensureRemoteTile(Alice)
        handleInboundOffer(Alice, buffered offer)
            Promise.all([getLocalStream(), getTurnCredentials()])
            createPeerConnection(Alice)
              addTracksToConnection ← localStream live ✓
            setRemoteDescription(offer)
            createAnswer → setLocalDescription(answer)
            capVideoBitrate ← both SDP set ✓
                                                                 wsSend('webrtc_answer')

    ◄── webrtc_answer { senderUserId: Bob } ────────────────────
    setRemoteDescription(answer)
    drainPendingCandidates
    capVideoBitrate ← both SDP set ✓

    ─ ─ ─ ICE trickling — IPv4 and IPv6 candidates both sent ─ ─ ─

    'connected' fires on both sides
    capVideoBitrate called again ← ensures cap survives ICE restart later

    ontrack → attachRemoteTile(Bob)                              ontrack → attachRemoteTile(Alice)
```

### Brief Drop — 2.5s Grace Then ICE Restart

```
Alice drops (tower switch, lift, brief signal loss)
  ▼ ~5s  → 'disconnected' on Bob's PC for Alice
  → backstop started (30s), tile stays visible frozen

Alice reconnects within session token TTL
  → server sends user_reconnected { Alice }

Bob: onMemberReconnected(Alice)
  → webrtcReady check ✓
  → connectionState === 'disconnected' ✓
  → wait 2.5s

  → if 'connected': return, zero TURN consumed ✓
  → if not 'disconnected': 'failed' handler took over ✓
  → if still 'disconnected': send ICE restart offer

  → clearTimeout(backstop)
  → createOffer({ iceRestart: true }) → wsSend

Alice: onMessage('webrtc_offer')
  → webrtcReady ✓ (was in watch view before drop)
  → handleInboundOffer
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

Bob: _onMemberReconnected(Alice)
  → webrtcReady ✓
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
| User 1 in watch, user 2 in lobby | User 1's offer buffered in `pendingOffers` on user 2. Drained after user 2 enters watch. No premature tile on user 1. |
| User 2 picks wrong file | Verdict `mismatch`, `webrtcReady` stays false, no offers sent, no tiles appear |
| Camera permission denied | `permissionDenied = true`, `getLocalStream()` returns null, local tile shows cam-off, `webrtcReady` still set to true, remote tiles work |
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
| Mic muted locally | `track.enabled = false`, tile indicator added, `mic_state` broadcast to room |
| Remote mic mute indicator | Driven by `mic_state` WebSocket message, not `track.onmute` events |
| Controls overlay clicked | `stopPropagation` on click/mousedown/pointerdown — movie player unaffected |
| Controls auto-hide | JS timer shared with controls bar — both fade after 3s, both show on mouse move |
| Tile label hidden by cam-off overlay | `.tile-label { z-index: 1 }` — above `.tile-cam-off::after` |
| No camera/mic device (NotFoundError) | `requestPermissions` catches all errors, sets `permissionDenied = true`, `webrtcReady` still true, user enters with black tile |

---

## What These Steps Do Not Do

| Thing | Deferred to |
|---|---|
| Web Audio mixer, per-user volume | Step 8 |
| Screen sharing | v2 |
| Video mute broadcast to room | v2 (currently only local cam-off + track events for network drops) |
| Spotlight / fullscreen a tile | Step 9 |
| Chat | Step 9 |
| Self-hosted coturn | When Metered free tier outgrown |

---

## Build Sequence

### Step 6 — Server (verify before any client code)

1. Sign up for Metered. Copy `METERED_TURN_HOST`, `METERED_USERNAME`, `METERED_CREDENTIAL` into env config.
2. Add `webrtcSyncWindow time.Time` and `webrtcCount int` to `Client` struct.
3. Add `WebRTCRelayEvent` and `execute()`.
4. Implement `handleWebRTCRelay` — rate limit, room validation, self-send guard, `senderUserId` injection, targeted send.
5. Add `webrtc_offer`, `webrtc_answer`, `ice_candidate` to `readPump`.
6. Add `MicStateEvent` and `execute()`.
7. Implement `handleMicState` — `broadcastToOthers` with `senderUserId`.
8. Add `mic_state` to `readPump`.
9. Create `turn.go` — same-origin check, Google STUN x2, Cloudflare STUN, Metered TURN three variants, `expiresAt` hint, coturn upgrade path in comments.
10. Register `GET /api/turn-credentials` under existing rate limiter.

### Step 7 — Client (after Step 6 verified)

11. Add `#tiles` and `#movie-container` to `index.html`. Add `<script src="/js/icons.js">` and `<script src="/js/webrtc.js">`.
12. Create `icons.js` — `ICONS` constant with all inline SVGs.
13. Add all CSS — tiles, cam-off, tile-label z-index, tile-mic-off, #webrtc-controls, .wc-btn variants. Verify layout with placeholder divs before writing JS.
14. Implement `webrtc.js` in section order:
    - `webrtcReady` flag, defaults `false`
    - `getTurnCredentials` — 10-minute cache (matches server cache TTL), 60s buffer
    - `getLocalStream` — promise-cached, 320×180@24fps, `permissionDenied` flag, reset on failure
    - `capVideoBitrate` — 150 Kbps, `.catch(() => {})`, called only after both SDP set
    - `addTracksToConnection`
    - `createPeerConnection` — `iceCandidatePoolSize: 4`, all candidates forwarded (no filtering), `'connected'` calls `capVideoBitrate`, backstop 30s, `'failed'` immediate close
    - `closePeerConnection` — map entry deleted immediately
    - `pendingOffers` buffer
    - `_onMemberJoined` — `webrtcReady` gate, `Promise.all`, `tile-self` guard, `createOffer`, NO `ensureRemoteTile`
    - `createOffer` — note: `capVideoBitrate` NOT called here, remote SDP not set yet
    - `handleInboundOffer` — `Promise.all`, `tile-self` guard, ICE restart detection with `'failed'` guard, `capVideoBitrate` after `setLocalDescription(answer)` on both branches
    - `onMessage('webrtc_offer')` — `webrtcReady` gate, buffer if not ready, else `handleInboundOffer`
    - `onMessage('webrtc_answer')` — `setRemoteDescription`, `drainPendingCandidates`, `capVideoBitrate`
    - `onMessage('ice_candidate')` — 50-cap buffer
    - `drainPendingCandidates`
    - `_onMemberReconnected` — `webrtcReady` gate, 2.5s grace, self-recovery check, ICE restart or full re-offer
    - `createLocalTile`, `attachRemoteTile` (video track listeners only), `ensureRemoteTile`, `removeTile`
    - `updateTileMicIndicator`, `onMessage('mic_state')`
    - Media controls overlay IIFE — `ICONS.*`, `stopPropagation`, mic broadcast
    - Public API: `requestPermissions`, `connectToExistingMembers`, `onSecondMemberVisible`, `onMemberJoined`, `onMemberReconnected`, `onMemberLeft`, `teardownAll`
    - `beforeunload` handler
15. Wire `ui.js`:
    - `tryEnterWatch`: `await requestPermissions()` → `showView('watch')` → `connectToExistingMembers()`
    - `resetHideTimer`: toggle `#webrtc-controls.hidden` alongside `#controls-bar.hidden`
    - `user_joined` → `webrtc.onMemberJoined`
    - `user_reconnected` → `webrtc.onMemberReconnected`
    - `user_left` → `webrtc.onMemberLeft`
    - `room_state` / `user_joined` → `webrtc.onSecondMemberVisible` when members ≥ 1

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
8. **Mic state broadcast:** A sends `mic_state { muted: true }`. B receives `mic_state { senderUserId: A, muted: true }`. A does not.
9. **Mic state isolation:** A in room 1 sends `mic_state`. C in room 2 does not receive.
10. **TURN endpoint — valid:** Google STUN x2, Cloudflare STUN, Metered TURN with three URL variants, `expiresAt` ~1 hour from now.
11. **TURN endpoint — wrong origin:** Returns 403.

### Step 7 — Client (browser)

12. **Layout baseline:** Strip at top, movie fills remaining height, controls at bottom. Controls overlay on right edge. No JS errors.
13. **Solo — no camera prompt:** One tab alone. No `getUserMedia`. No dialog.
14. **TURN prefetch only:** Second tab joins lobby. `/api/turn-credentials` requested. No camera dialog yet.
15. **No camera prompt in lobby:** Second user in lobby, first user in watch view sends offer. Second user does NOT get camera prompt. Offer buffered.
16. **Camera prompt after file pick:** Second user picks valid file → verdict valid → camera dialog appears → enters watch view.
17. **Buffered offer drained:** After entering watch view, `connectToExistingMembers` processes the buffered offer. Both users see each other's tiles.
18. **No premature tiles:** While user 2 is in lobby, user 1 does NOT see user 2's tile. Tile appears only after WebRTC connection establishes.
19. **`getUserMedia` constraint:** Video track ≤ 320×180, framerate ≤ 24.
20. **Two tabs:** One dialog per tab. One local tile. 120×68px centered. Accent border. `video.muted === true`.
21. **Concurrent join:** Three tabs simultaneously. One dialog and one local tile per tab.
22. **New joiner visible:** A and B in room, C joins and picks file. A and B see C. C sees A and B. All six streams flowing.
23. **Bitrate cap applied:** In `chrome://webrtc-internals`, confirm outbound video bitrate does not exceed 150 Kbps once connection is established.
24. **Bitrate cap timing:** Confirm `setParameters` is not called before both SDP descriptions are set. Check for any `InvalidStateError` in console — there should be none.
25. **Bitrate cap survives ICE restart:** After a brief drop and ICE restart, confirm outbound bitrate cap is still ≤ 150 Kbps in `chrome://webrtc-internals`. Confirm `capVideoBitrate` was called on `'connected'` transition.
26. **`iceCandidatePoolSize` effect:** In `chrome://webrtc-internals`, confirm candidates present before offer exchange completes.
27. **No IPv4 filtering:** Both IPv4 and IPv6 candidates in `chrome://webrtc-internals`. None suppressed.
28. **P2P confirmed:** No large payloads on WebSocket. P2P connection type in `chrome://webrtc-internals`.
29. **Three and six users:** Tiles centered, grow outward. Strip stays 84px.
30. **Member leaves:** Tile removed. Re-center CSS only.
31. **ICE candidate cap:** 60 before offer. 50 buffered. Connection establishes.
32. **Camera denied:** Cam-off tile. `webrtcReady` still true. Remote tabs unaffected. Tile label visible (z-index: 1).
33. **Tile label visible on cam-off:** With camera denied, name label is readable on the black tile. `.tile-label` z-index: 1 above `.tile-cam-off::after`.
34. **Controls overlay — no movie interaction:** Click mic/video/leave buttons. Movie does not pause, seek, or react in any way.
35. **Controls overlay — auto-hide:** Move mouse → both controls bar and WebRTC controls appear. Stop moving → both fade after 3s.
36. **Controls overlay — icons:** Mic shows Google Meet-style mic SVG. Toggle shows red slashed mic. Video same pattern. Leave shows phone-down icon.
37. **Mic mute — local indicator:** Mute mic → small white muted-mic icon appears in bottom-right of own tile.
38. **Mic mute — remote indicator:** User A mutes mic → User B sees muted-mic icon on A's tile. User A unmutes → icon disappears on B's screen.
39. **Mic mute — WebSocket path:** Confirm `mic_state` message sent on mute. Confirm remote receives `mic_state` with `senderUserId`. Confirm indicator updates without track event.
40. **2.5s grace — self-recovery:** Brief drop recovers within 2.5s. No ICE restart offer sent. Tile stays visible, unfreezes.
41. **2.5s grace — still disconnected:** Drop does not recover in 2.5s. ICE restart offer sent after grace elapses.
42. **ICE restart false positive:** Bob's PC `'failed'`, Alice's still `'disconnected'`. Bob sends fresh re-offer. Alice detects `'failed'` → fresh path. No `setRemoteDescription` on dead PC.
43. **Backstop at 30s:** Suppress `'failed'`. PC closed at 30s. Not before.
44. **Long drop:** Offline ~35s+. `'failed'`, tile removed. Reconnect. Tile reappears.
45. **Token expiry:** Drop > 5 min. `user_joined`. Full re-offer.
46. **Cache TTL:** Set `turnCredentialsExpiresAt` to past. Next connection refetches.
47. **Teardown:** Tab close. All tracks stopped. Tile removed promptly. `webrtcReady` reset to false. `pendingOffers` cleared.
48. **Audio baseline (Step 8 prerequisite):** Document whether movie audio echoes through WebRTC. Baseline for Step 8.