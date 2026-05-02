# Watch Party App — High Level Design Summary

---

## What We're Building

A browser-based watch party website where a group of friends can watch the same movie simultaneously from their own local copies, see each other's faces in real-time like a GMeet call, and have playback fully synced — so pressing pause, seeking, or playing affects everyone's video at the same time. No accounts, no uploads, no app installs. You open a browser, share a link, and watch together.

---

## The Core Principles Driving Every Decision

**Everything lives in the browser.** No native app, no browser extension, no helper script. This is a website. The browser is capable enough to handle local file playback, webcam streams, peer-to-peer video, and WebSocket communication natively. Any time we could avoid leaving the browser we did.

**The file never leaves the user's machine.** Each person loads their own local copy of the movie. The website reads it using the browser's File API and plays it in a `<video>` element. Nothing is uploaded to a server. This sidesteps hosting costs, copyright issues, and bandwidth entirely.

**The server is dumb and cheap.** The sync server doesn't handle any media — no video bytes, no audio, nothing heavy. It only passes small JSON messages between clients telling them what playback state to be in. This means it can run on the cheapest possible infrastructure.

---

## Room and Identity System

Modelled after Skribbl.io. No accounts, no passwords, no OAuth. The flow is:

- Host clicks "Create Room" → server generates a short room code like `WOLF-QUAIL-4821`
- Host shares the link: `syncoplex.app/room/WOLF-QUAIL-4821`
- Friends open the link, type a display name, and they're in

Room state lives in Redis with a TTL so it automatically cleans up after the session ends. There is no user database. Sessions are ephemeral and tied entirely to the room lifetime. This was chosen because the friction of account creation is completely at odds with the casual, social nature of a watch party. You want the barrier to joining to be as close to zero as possible.

---

## Video Playback — Browser `<video>` Element with Local File

The single most important architectural decision. We dropped VLC entirely.

Each user is shown a file picker when they join a room. They select their local copy of the movie. The browser creates a local blob URL pointing to that file and sets it as the source of an HTML `<video>` element. The file is read off disk directly by the browser — no upload, no streaming server, no size limit that matters in practice.

This was chosen over VLC because VLC is a separate native application. Controlling it from a website requires a bridge script running locally on each user's machine, which means users have to install something, run a terminal command, and keep a background process alive. That kills the "just open a link" promise. The browser `<video>` element gives you programmatic control — pause, seek, play, currentTime — all in the same JavaScript context as everything else. The architecture collapses from a 3-layer system into a single layer.

**Format caveat:** MP4 with H.264 encoding is universally supported across browsers. MKV is not. For v1 this is documented as a known limitation. ffmpeg.wasm (a WebAssembly build of ffmpeg that runs in-browser) is the v2 solution for remuxing MKVs without a server.

---

## File Verification

Since everyone loads their own copy, there's a risk someone loads the wrong version or a differently encoded copy. A full hash of a 10GB file takes too long. Instead a partial fingerprint is computed — SHA-256 of the first and last 10MB of the file. This fingerprint is sent to the server when the file is loaded. If fingerprints don't match across users in the room, the user gets a warning before playback starts. It's not a hard block — just a signal that something might be off.

---

## The Sync Engine

This is the technical core of the product. The naive approach — "when I press pause, tell the other person to pause" — fails because of network latency. A message sent at `T` arrives at `T + 80ms` to `T + 300ms` and by then the videos are already out of sync.

The correct model is an **authoritative server with timestamp compensation**:

1. No client ever acts on a playback command locally and directly. When you press pause, your browser sends a *request* to the server.
2. The server receives it, attaches a server-side timestamp, and broadcasts an authoritative command to every client in the room including the sender.
3. Every client receives `{ action, position, serverTime }` and executes it. The `position` value is the ground truth. Clients calculate the latency offset `(now - serverTime)` and nudge `currentTime` forward by that amount so everyone starts from the same real-world moment despite the message arriving at slightly different times.

This means there's a ~50–150ms delay between pressing pause and VLC pausing, which is imperceptible. What you gain is that every client is always anchored to a canonical position.

**Democratic control** — everyone in the room can press play, pause, or seek. There's no host who owns the controls. Simultaneous conflicting commands are resolved by last-write-wins at the server — whichever message the server receives first becomes the truth, rebroadcast to everyone.

**Internet drop handling** — since every sync message carries the position embedded in it, a delayed delivery is completely safe. A client that went offline for 5 seconds receives `{ pause, position: 4521.3s }`, seeks to that exact position, and pauses. The timestamp carries the truth forward through time regardless of when the message arrives.

**Background tab problem** — browsers throttle `setTimeout` and `setInterval` in backgrounded tabs. The sync heartbeat (a periodic drift-check that catches slow clock divergence) must run inside a Web Worker, which is not throttled, to stay accurate.

---

## WebRTC — Face Cameras

The GMeet-style face cameras are handled entirely via WebRTC between browsers, peer-to-peer. Your server never touches any camera or microphone data — it only acts as a signaling broker to set up the connection.

**How signaling works:** To establish a WebRTC connection, peers need to exchange SDP offers and ICE candidates — essentially negotiating capabilities and finding each other's network addresses. Your WebSocket server routes these small messages between users in the same room. Once the connection is established, all video and audio flows directly between browsers and the server is out of the loop.

**Full mesh topology** — each participant has a direct peer connection to every other participant. For N people there are N×(N-1)/2 connections. This is fine for 2–6 people, which is the realistic watch party use case.

**STUN and TURN** — WebRTC peer-to-peer fails when users are behind symmetric NAT (certain ISPs and office networks). STUN servers help peers discover their public IP and port, enabling direct connections in most cases. TURN servers are relay fallbacks — when direct connection is impossible, both peers connect outbound to a TURN server which forwards traffic between them. STUN is free (Google runs public servers). TURN has a bandwidth cost but is only used as a fallback. Twilio's Network Traversal Service provides free TURN credentials for low usage.

---

## Audio Architecture

With the movie playing in the browser's `<video>` element and microphone audio also in the browser, explicit routing is needed.

**Three separate paths:**
- Movie audio → your speakers. This is just normal `<video>` playback. Nothing special.
- Your microphone → outgoing WebRTC audio track → remote users hear your voice.
- Remote user's microphone → incoming WebRTC audio track → your speakers. This is their voice.

**What must never happen:** the movie audio must never enter your outgoing WebRTC track. If it did, the remote user would hear the movie twice — their own local copy plus an echo through your mic. When adding tracks to the WebRTC peer connection, only the microphone audio track and camera video track are added. The `<video>` element's audio track is never touched.

**Echo:** if a user is on speakers, their mic picks up movie audio and sends it to the other person. `echoCancellation: true` on getUserMedia helps but isn't perfect for movie audio. Headphones solve it completely. For a watch party, most users will be wearing headphones anyway. This is documented, not engineered around, for v1.

---

## Layout

The `<video>` element fills the full browser viewport — it is the main stage. Layered on top of it with CSS `position: absolute`:

- Camera tiles in the corner — small `<video>` elements, one per participant, dynamically arranged
- A control bar at the bottom — play/pause, seek bar, current time, volume
- A collapsible sidebar for chat and the room code

Camera tile count drives a grid layout calculated at runtime. 1–2 people is side by side. 3–4 is a 2×2. Beyond that it scales using square root math. Any tile can be clicked to spotlight that participant.

Each tile is a `<video>` element whose `srcObject` is set to the MediaStream coming from that peer's WebRTC connection. Your own tile uses your local camera stream and is always muted to prevent feedback.

---

## What the Server Does (and Doesn't Do)

**Does:**
- Manage room codes and host ownership in Redis with TTL
- Manage membership in-memory
- Relay WebRTC signaling messages (SDP offers, ICE candidates) between peers
- Receive sync commands, attach server timestamps, and broadcast them to the room
- Store the current authoritative playback state so a user who joins late can catch up

**Does not:**
- Handle any video bytes
- Handle any audio
- Store user data
- Know anything about what movie is playing

This means the server is stateless enough to run on the cheapest tier of Railway or Fly.io. It handles only text messages and needs no special media processing hardware.

---

## Full Data Flow Diagram

```
Each User's Browser
┌─────────────────────────────────────────────┐
│                                             │
│  <video> element  ←── Local file (File API) │
│       ↑                                     │
│  Sync events from server                    │
│  (pause/play/seek with position+timestamp)  │
│                                             │
│  Camera <video> tiles                       │
│  ← MediaStream from WebRTC peer connections │
│                                             │
│  Outgoing WebRTC tracks:                    │
│    - Camera video                           │
│    - Microphone audio (only)                │
│                                             │
└────────────┬──────────────────┬─────────────┘
             │ WebSocket        │ WebRTC (P2P)
             ↓                  ↓
      Sync Server          Other users' browsers
      (Go + Redis)         directly
      - Room state
      - Signaling relay
      - Sync broadcast
```

---

## Build Order for v1

1. Room creation, join flow, room codes — WebSocket server and Redis
2. Frontend Creation using vanillaJS
3. File picker, `<video>` element, local playback
4. Sync engine — play/pause/seek events through the server, timestamp compensation
5. File fingerprinting — warn if files don't match
6. WebRTC signaling server — route SDP and ICE messages
7. Camera tiles — getUserMedia, peer connections, tile layout
8. Audio routing — confirm mic-only goes over WebRTC, never movie audio
9. Layout polish — overlay controls, dynamic tile grid, collapsible sidebar
10. TURN server setup — Twilio credentials or self-hosted coturn

Steps 1–5 can be built and tested alone before any WebRTC work begins. Steps 6–8 are independent of sync and can be developed in parallel. Step 9 and 10 are polish and infrastructure, done last.