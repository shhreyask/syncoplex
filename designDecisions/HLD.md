# Syncoplex — High Level Design Summary

---

## What We've Built

A browser-based watch party website where a group of friends watch the same movie simultaneously from their own local copies, see each other's faces via WebRTC camera tiles, talk through microphones, and have playback perfectly synchronised across all clients — play, pause, and seek applied authoritatively from a single Go server.

No accounts. No uploads. No streaming. No native app. One URL, one room code, one shared experience.

---

## The Core Principles Driving Every Decision

**Everything lives in the browser.** No native app, no browser extension, no helper script. This is a website. The browser handles local file playback, webcam streams, peer-to-peer audio/video connections, and file fingerprinting — all via standard Web APIs.

**The file never leaves the user's machine.** Each person loads their own local copy of the movie. The website reads it using the browser's File API and plays it in a `<video>` element. Nothing is uploaded, streamed, or proxied. The server never sees a single byte of video.

**The server is dumb and cheap.** A single Go binary with two external dependencies. No database, no cache layer, no external process. All state is in-memory. It routes small JSON messages between browsers, holds room and session state in Go maps with TTL expiry, and idles at ~10MB of memory. The server is never in the media path.

---

## Room and Identity System

Modelled after Skribbl.io. No accounts, no passwords, no OAuth. The flow is:

- Host clicks "Create Room" → server generates a short room code like `WOLF-QUAIL-482134`
- Host shares the link: `syncoplex.app/room/WOLF-QUAIL-482134`
- Friends open the link, type a display name, and they're in

Two words from a curated list of 50 animals + 6 random digits = 2.25 billion possible codes. Brute force is computationally unreasonable. Combined with rate limiting, room enumeration is effectively impossible.

Room existence is tracked in an in-memory `RoomStore` with a 6-hour TTL. Live membership is tracked by the Hub goroutine in a plain Go map. Session tokens for reconnection are held in an in-memory `SessionStore` with a 5-minute TTL, written only on disconnect — the reconnect clock starts when it matters. There is no user database. Sessions are ephemeral and tied entirely to the room lifetime.

---

## Video Playback — Browser `<video>` Element with Local File

The single most important architectural decision. Each user selects their local copy via a file picker. The browser creates a blob URL and plays it in an HTML `<video>` element. Drag-and-drop is supported. Subtitle files (SRT and VTT) can be loaded independently per user.

This was chosen over VLC because VLC is a separate native application. Controlling it from a website requires a bridge script running locally on each user's machine — installation friction that kills adoption for a casual watch party.

**Format caveat:** MP4 with H.264 encoding is universally supported across browsers. MKV is not. For v1 this is documented as a known limitation.

---

## File Verification

Since everyone loads their own copy, there's a risk someone loads the wrong version or a differently encoded copy. A full hash of a 10GB file takes too long. Instead a deterministic partial fingerprint is computed from three strategic chunks:

```
fingerprint = SHA-256(
    fileSize (8 bytes LE)
  + 1 MB at byte offset 0           — container header + first keyframe
  + 1 MB at byte offset floor(size/2) — mid-file divergence catch
  + 1 MB at byte offset (size - 1MB)  — tail, catches truncation + muxed subs
)
```

~3 MB read, ~200ms on a mid-range device, runs entirely in a Web Worker. The hex string is sent to the server, which holds a canonical hash per room. First user in sets the canonical. Subsequent users are compared against it. Mismatch triggers a warning — the user can re-pick or proceed.

The server gates `sync_command` on file verification — a client who has not passed validation cannot affect room playback state regardless of what they send. This is independent of the client-side UI gate.

---

## The Sync Engine

This is the technical core of the product. The correct model is an **authoritative server with no local optimism**:

1. When a user presses play, the browser sends a *request* to the server. The video does not start locally.
2. The server receives it, computes the authoritative position using monotonic time arithmetic, and broadcasts to every client in the room including the sender.
3. Every client receives `{ action, position, isPlaying }` and executes it unconditionally. The `position` value is the ground truth.

This means there's a ~50–150ms delay between pressing play and the video responding — imperceptible. What you gain is that every client is always anchored to a canonical position. No client ever trusts another client.

**Democratic control** — everyone in the room can press play, pause, or seek. There's no host who owns the controls. Simultaneous conflicting commands are resolved by last-write-wins at the server — the Hub goroutine processes events sequentially, so the first one in wins and the second is silently dropped.

**Late joiner catchup** — when a client receives a valid file verification verdict and playback state exists, the server computes the current position (`lastRecordedPosition + elapsed since recording`) and sends a `sync_state` message. The client seeks to the correct position immediately.

**Drift correction** — browsers throttle `setInterval` in backgrounded tabs. A Web Worker ticks every 5 seconds, compares expected position against `video.currentTime`, and applies gentle correction: ±5% playback rate for 0.5–2s drift, hard seek for >2s drift. Uses `performance.now()` (monotonic) — immune to NTP clock adjustments.

---

## WebRTC — Face Cameras and Voice

The GMeet-style face cameras and microphone audio are handled entirely via WebRTC between browsers, peer-to-peer. The server never touches any camera or microphone data — it only acts as a signaling broker to set up the peer connections.

**Signaling:** SDP offers, answers, and ICE candidates are relayed through the WebSocket connection as targeted messages — routed to exactly one recipient in the same room, not broadcast. `senderUserId` is always server-injected so clients can't spoof identity.

**Full mesh topology** — each participant has a direct peer connection to every other participant. For N people there are N×(N-1)/2 connections. The hard cap is 6 members per room because beyond that, average home upload bandwidth and device CPU become real constraints.

**STUN and TURN** — WebRTC peer-to-peer fails when users are behind symmetric NAT. STUN servers (Google, Cloudflare) help peers discover their public address. TURN relays traffic when direct connection is impossible. Syncoplex uses Metered's managed TURN service, with credentials fetched lazily from `/api/turn-credentials` only when a peer connection is actually created.

**Permission timing:** `getUserMedia` is NOT called on room join. It is called exactly once — after the file verdict is `valid`, before transitioning to the watch view. No permission prompt when sitting alone in a room.

**Video bitrate cap:** 150 Kbps per stream — roughly doubles the TURN free-tier budget compared to the default ~300 Kbps. Applied after SDP negotiation completes and re-applied on every ICE restart.

**Reconnect model:** tiered. A brief connection drop (PC still `disconnected`) waits 2.5 seconds before sending an ICE restart offer — giving mobile connections a chance to self-recover. A longer drop triggers a full re-offer with fresh SDP.

---

## Audio Architecture

Three separate paths, no mixing:

- **Movie audio → your speakers.** Normal `<video>` playback. Nothing special.
- **Your microphone → outgoing WebRTC audio track → remote users hear your voice.**
- **Remote user's microphone → incoming WebRTC audio track → your speakers.**

**What must never happen:** the movie audio must never enter the outgoing WebRTC track. If it did, the remote user would hear the movie twice. WebRTC's `getUserMedia` captures the mic only — the `<video>` element's audio output is structurally never added to any peer connection.

**Mic mute signaling:** `track.enabled = false` on the local side does NOT trigger `onmute`/`onunmute` events on the remote side. Mic mute state is broadcast explicitly via a `mic_state` WebSocket message. Tile indicators are driven by these messages.

---

## Layout

The `<video>` element fills the full browser viewport. Layered on top with CSS `position: absolute`:

- **Camera tiles** in a strip above the movie — dynamically arranged grid based on participant count
- **A control bar** at the bottom — play/pause, seek bar, time display, volume, mute, CC, fullscreen
- **Media controls** on the right edge — mic toggle, camera toggle, leave button
- **A collapsible sidebar** for the room code and member list

Controls auto-hide after 3 seconds of mouse inactivity using `opacity` only — no layout shift. Controls never hide while paused.

---

## What the Server Does (and Doesn't Do)

**Does:**
- Manage room codes in an in-memory store with TTL expiry
- Track live membership and host in Hub maps (hub goroutine only)
- Manage session tokens for seamless reconnection (in-memory store, 5-minute TTL)
- Relay WebRTC signaling messages (SDP offers, ICE candidates) between specific peers
- Receive sync commands, compute authoritative positions, and broadcast to the room
- Hold per-room file verification canonical hashes and gate sync on validation
- Hold per-room playback state so late joiners can catch up

**Does not:**
- Handle any video bytes — P2P WebRTC, server is never in the media path
- Handle any audio — same
- Store user data — no database, no privacy surface
- Know what movie is playing — completely irrelevant to the server
- Use any external database, cache, or persistence layer — all state is in-memory Go maps
- Authenticate users — room code is the auth, friction is the enemy

This means the server runs on the cheapest tier of any VPS. It handles only small JSON messages and needs no special hardware. 1000 concurrent rooms with 4 users each fits in ~97MB of RAM.

---

## Full Data Flow Diagram

```
Each User's Browser
┌─────────────────────────────────────────────┐
│                                             │
│  <video> element  ←── Local file (File API) │
│       ↑                                     │
│  Sync events from server                    │
│  (pause/play/seek with position+isPlaying)  │
│                                             │
│  Camera <video> tiles                       │
│  ← MediaStream from WebRTC peer connections │
│                                             │
│  Outgoing WebRTC tracks:                    │
│    - Camera video (320×180, 150 Kbps cap)   │
│    - Microphone audio (only)                │
│                                             │
│  File fingerprint (SHA-256 partial)         │
│  → hex string to server for validation      │
│                                             │
└────────────┬──────────────────┬─────────────┘
             │ WebSocket        │ WebRTC (P2P)
             ↓                  ↓
      Sync Server          Other users' browsers
      (Go, in-memory)     directly
      - Room store
      - Session store
      - Sync broadcast
      - Signaling relay
      - File verification
```

---

## The Server Stack

```
Language        Go (latest stable)
WebSocket       github.com/gorilla/websocket
Env loading     github.com/joho/godotenv
TLS             Caddy (reverse proxy, auto Let's Encrypt)
```

Two dependencies. No database. No external cache. No Redis.

```
server/
├── main.go           Starts the server, wires routes, creates stores
├── config.go         Environment variables, constants
├── store.go          RoomStore and SessionStore — in-memory maps with TTL
├── rooms.go          Code generation, room creation, HTTP handlers
├── hub.go            Hub struct, event loop, all handlers, WebSocket, read/write pumps
├── session.go        Token generation, reconnect identity
├── turn.go           TURN credential fetching and caching
└── middleware.go     Rate limiting, security headers, CORS, input validation
```

---

## The Frontend Stack

```
HTML            One file — the entire app
CSS             One file — under 250 lines
JavaScript      Concatenated from 9 source files, no bundler
Workers         2 separate files (drift checker, file fingerprint)
Fonts           System font stack — zero external requests
Icons           Inline SVG — zero external requests
```

```
frontend/public/
├── index.html
├── style.css
└── js/
    ├── state.js            Single roomState object + event bus
    ├── ws.js               WebSocket client, reconnect logic, session tokens
    ├── player.js           <video> element, File API, blob URL, subtitles
    ├── sync.js             Sync engine — apply/send play/pause/seek, drift guard
    ├── fileVerify.js       File fingerprint coordinator, verdict state
    ├── icons.js            Inline SVG constants for media controls
    ├── webrtc.js           Peer connections, signaling, camera tiles, media controls
    ├── ui.js               DOM rendering, state → view, event handlers
    ├── worker.js           Web Worker — drift checker (5s tick)
    └── workerFileVerify.js Web Worker — SHA-256 partial file hash
```

---

## Hub Architecture — The Event Loop

The Hub is a single goroutine that owns all live state. One inbox (`h.events`), sequential dispatch. Seven event types:

| Event | Source | Purpose |
|---|---|---|
| `RegisterEvent` | HTTP goroutine | Client joins room |
| `UnregisterEvent` | readPump goroutine | Client disconnects |
| `RelayEvent` | readPump goroutine | Broadcast to room (sender excluded) |
| `SyncEvent` | readPump goroutine | Play/pause/seek command |
| `FileVerifyEvent` | readPump goroutine | File fingerprint validation |
| `WebRTCRelayEvent` | readPump goroutine | Targeted peer-to-peer signaling |
| `MicStateEvent` | readPump goroutine | Mic mute/unmute broadcast |

Three mutexes in the entire server:

| Mutex | Protects | Why |
|---|---|---|
| `h.mu` (RWMutex) | `h.rooms` writes ↔ `roomMemberCount` reads | HTTP goroutines read member count |
| `RoomStore.mu` (RWMutex) | Room existence map | HTTP goroutines create/check rooms |
| `SessionStore.mu` (Mutex) | Session token map | Hub writes on disconnect, HTTP reads on reconnect |

Everything else — `h.hostIds`, `h.playbackStates`, `h.fileVerifyStates`, client rate-limit fields — lives on the hub goroutine only and needs no synchronisation.

Per connected user: 2 goroutines (readPump + writePump). The Hub never writes to a WebSocket directly — it puts messages into each client's buffered `send` channel and moves on immediately. A slow or dead client never stalls the Hub.

---

## Security — Both Sides

**Server:**
- TLS everywhere via Caddy reverse proxy
- WebSocket origin validation — only `syncoplex.app`
- 16KB message size limit (`SetReadLimit`)
- Rate limiting: 20 room creates/min, 10 room lookups/min, 5 sync commands/sec, 30 WebRTC relays/sec, 3 file verifies/sec
- Security headers: CSP, X-Frame-Options DENY, nosniff, strict Referrer-Policy
- Room code validated against `^[A-Z]+-[A-Z]+-[0-9]+$` before any store access
- Display names: HTML tags stripped, whitespace trimmed, 32 Unicode char cap
- Unknown message types dropped silently
- `senderUserId` always server-injected on WebRTC relay — clients cannot spoof identity
- `sync_command` gated on file verification — unvalidated clients silently dropped
- Stale client guard prevents old readPump from evicting a reconnected client

**Client:**
- All inputs validated client-side before sending (bugs caught early, server validates independently)
- No user input ever reaches the DOM as raw HTML — `textContent` only, never `innerHTML`
- TURN credentials fetched from same-origin only — API key never leaves the server
- Blob URLs revoked on file replacement or room leave — no memory leaks
- Session token in `sessionStorage` (survives refresh, cleared on tab close — correct semantics)

---

## What Was Deliberately Not Built

| Thing | Reason |
|---|---|
| User accounts / OAuth | Friction is the enemy — room code is the auth |
| File upload / streaming | File never leaves the user's machine |
| External database / Redis | In-memory stores are sufficient for ephemeral sessions |
| Web framework (Gin, Echo) | `net/http` stdlib is sufficient |
| Frontend framework (React, Vue) | No virtual DOM, no hydration, no bundle — 3 files, instant load |
| ES6 `import/export` | Would require a bundler — `cat` is sufficient |
| External fonts / icon libraries | Every external request at load time costs a full round trip |
| localStorage for session tokens | Persists forever — wrong semantics for ephemeral sessions |
| Local optimistic playback | Correctness requires going through the server |
| SFU / media server | Full mesh P2P is sufficient for ≤6 users |
| Chat | Not in v1 scope |
| Persistent playback history | Not in v1 scope |

Each omission is a feature. Everything the server does not do is something that cannot go wrong.

---

## Build Order for v1

```
 1. Room creation, join flow, room codes — Go server + in-memory stores      ✓
 2. Frontend — vanilla JS, three views, WebSocket, member list               ✓
 3. File picker, <video> element, local playback, subtitles                  ✓
 4. Sync engine — play/pause/seek through server, drift correction           ✓
 5. File verification — partial fingerprint, canonical hash, server gate     ✓
 6. WebRTC signaling server — targeted relay, rate limiting, TURN            ✓
 7. Camera tiles — getUserMedia, peer connections, tile layout               ✓
 8. Audio routing — mic-only over WebRTC, mic mute indicators                ✓
 9. Layout polish — control bar auto-hide, keyboard shortcuts, sidebar       ✓
10. TURN server setup — Metered credentials, lazy fetch, client-side cache   ✓
```

Steps 1–5 were built and tested before any WebRTC code was written. Steps 6–8 are independent of sync. Step 9 and 10 are polish and infrastructure, done last.