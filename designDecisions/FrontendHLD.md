# Syncoplex Frontend — High Level Design

---

## What This Frontend Is

A single HTML file, one CSS file, one concatenated JS file. No framework, no build pipeline, no runtime dependencies. The browser downloads three files and the app is fully operational. It communicates with the Go backend over a single persistent WebSocket connection and, once WebRTC is established, the server becomes irrelevant to the actual experience.

Every decision in this document flows from the same four principles that govern the backend:

- **Secure** — hostile inputs, bad actors, and flaky clients never affect other users
- **Fast** — page load is instant, interactions are immediate, the UI never waits unnecessarily
- **Smooth** — reconnects are seamless, membership state is always accurate, no ghost users
- **Light** — minimal DOM, minimal memory, no external requests at page load

---

## Stack Decision — Genuinely Vanilla, Modern Syntax

No React. No Vue. No Svelte. No bundler. No transpiler. No `node_modules`.

**JavaScript:** ES6 language features throughout — `const`, `let`, arrow functions, `async/await`, template literals, destructuring, spread. No `import/export`. Files share a global scope and are concatenated into one `app.js` in dependency order. The browser runs ES6 natively — no transpilation needed.

The two concerns are deliberately separated:
- **ES6 module syntax** (`import/export`) — requires a bundler, incompatible with `cat`. Not used.
- **ES6 language features** (`const`, arrows, `async/await`) — fully compatible with `cat`. Used everywhere.

Concatenation is a shell script, not a tool:

```bash
cat js/state.js js/ws.js js/player.js js/sync.js js/webrtc.js js/ui.js > public/app.js
```

No step that requires Node.js. No `package.json`. The Go binary serves `public/` as static files directly. Variables and functions declared in each file are available to all subsequent files in the concatenation — explicit shared global scope, honest and predictable.

**CSS:** One file, target under 150 lines. The aesthetic is achievable with less. Every line over 150 is a line that wasn't necessary.

**Fonts:** System font stack only. No Google Fonts request, no font loading delay, no layout shift:
```css
font-family: 'Courier New', Courier, monospace; /* headings, room codes */
font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; /* body */
```

**Icons:** Inline SVG or Unicode. ▶ ⏸ ⏹ 🔇 — already in every system font. No icon library, no sprite sheet, no HTTP request.

**Zero external requests at page load.** Not one. Every external request at load time is a DNS lookup, TCP handshake, and TLS handshake before a single byte arrives. TURN credential fetches are runtime fetches triggered by user action — a completely different category.

---

## HTTP Caching — Served From Go

The Go static file server sends correct headers. This costs nothing and makes returning users load from disk:

```
index.html      Cache-Control: no-cache
                Always fetched fresh — it's tiny and must never be stale

app.js          Cache-Control: max-age=31536000, immutable
style.css       Cache-Control: max-age=31536000, immutable
                Cached forever — bust by renaming on deploy: app.a3f9c2.js
```

On first load: three requests. On every subsequent load: one request (`index.html`), everything else served from disk.

---

## File Structure

```
public/
├── index.html          The only HTML file — the entire app
├── style.css           Under 150 lines
├── app.js              Concatenated at deploy time from js/* in order
└── js/
    ├── state.js        Single roomState object + event bus
    ├── ws.js           WebSocket client, reconnect logic, session tokens
    ├── player.js       <video> element, File API, blob URL
    ├── sync.js         Sync engine — apply/send play/pause/seek
    ├── webrtc.js       Peer connections, signaling, camera tiles
    ├── ui.js           DOM rendering, state → view, event handlers
    ├── worker.js       Web Worker for drift checker (cannot be concatenated —
    │                   Workers require a separate script URL)
    └── fingerprint.js  Web Worker for SHA-256 file hashing (same reason)
```

`worker.js` and `fingerprint.js` are the only files that cannot be part of the concatenated bundle — `new Worker(url)` requires a separate script URL. They are small, cached with immutable headers, and only instantiated when needed.

---

## Application States — Three Views, One URL

The entire app is one HTML page. Three `<section>` elements exist in the DOM at all times. Only one is visible. State transitions are a single attribute write:

```js
document.body.dataset.view = 'lobby' // 'landing' | 'lobby' | 'watch'
```

CSS handles visibility:
```css
section { display: none; }
body[data-view="landing"] #view-landing { display: flex; }
body[data-view="lobby"]   #view-lobby   { display: flex; }
body[data-view="watch"]   #view-watch   { display: block; }
```

No router. No history API for v1. The URL carries the room code on load — `window.location.pathname` is parsed once at startup. That is the full extent of routing.

```
State: landing
    User sees: Create Room button + Join with code input
    URL: syncoplex.app/

State: lobby
    User sees: Room code, name input, file picker, member list, waiting state
    URL: syncoplex.app/room/WOLF-BEAR-482134

State: watch
    User sees: <video> fullscreen, camera tiles, control bar, sidebar
    URL: syncoplex.app/room/WOLF-BEAR-482134  (unchanged)
```

---

## State Management — One Object, One Event

All application state lives in a single object. Nothing else:

```js
// state.js
const roomState = {
  // Identity
  myUserId:     null,
  myName:       null,
  sessionToken: null,   // stored in sessionStorage, loaded on init

  // Room
  roomCode:     null,
  members:      [],     // [{ userId, name, fileReady }]

  // Playback
  playback: {
    playing:     false,
    position:    0,
    serverTime:  null   // last known server timestamp for this state
  },

  // File
  file:          null,  // File object
  blobUrl:       null,
  fileReady:     false,
  fileHash:      null,
  fileState:     'waiting', // 'waiting' | 'hashing' | 'mismatch' | 'ready'

  // Connection
  wsStatus:      'disconnected'  // 'disconnected' | 'connecting' | 'connected'
}

const notifyUpdate = () => {
  document.dispatchEvent(new CustomEvent('room:updated'))
}
```

When a WebSocket message arrives and updates state, one thing happens: `notifyUpdate()`. The UI listens for `room:updated` and re-renders the affected components. The WebSocket layer and the UI layer never reference each other directly. They are decoupled through the DOM's own event system.

`sessionToken` is persisted in `sessionStorage` — survives tab blips and refreshes, cleared when the tab is intentionally closed. This maps exactly to the backend's session token semantics.

---

## WebSocket Client — Finite State Machine

`ws.js` owns the WebSocket connection exclusively. Nothing else in the app touches it.

### Connection States

```
DISCONNECTED → CONNECTING → CONNECTED → DISCONNECTED (loop)
```

### Reconnect Backoff

Exponential with jitter. Without jitter, everyone who drops simultaneously hammers the server at the same retry interval:

```js
// ws.js
const getBackoff = (attempt) => {
  const base = Math.min(500 * Math.pow(2, attempt), 5000)  // cap at 5s
  const jitter = Math.random() * 500
  return base + jitter
}
```

Attempts: ~500ms, ~1s, ~2s, ~4s, ~5s, ~5s... Resets to 0 on successful connect.

### Message Dispatch

Incoming messages are routed by type to registered handlers:

```js
// ws.js
const handlers = {}

const onMessage = (type, fn) => { handlers[type] = fn }

// Inside the WebSocket onmessage handler:
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (handlers[msg.type]) handlers[msg.type](msg.payload)
  // Unknown types are silently dropped — never processed, never cause errors
}
```

### Session Token Handling

The session token flow mirrors the backend exactly:

1. On `session_token` message (received before Hub registration): store in `roomState.sessionToken` and `sessionStorage`
2. On `session_init`: store `userId` in `roomState.myUserId`
3. On reconnect: read token from `sessionStorage`, include in `join` payload
4. On `user_reconnected` for own userId: update state without resetting peer connections

### The Join Message

```js
// ws.js
const joinRoom = (name, roomCode) => {
  const payload = { name }
  const token = sessionStorage.getItem('syncoplex_token')
  if (token) payload.sessionToken = token
  wsSend('join', payload)
}
```

One function. It either reconnects (token present) or joins fresh (no token). The server handles both cases identically from the client's perspective.

### Input Validation Before Send

Every outgoing message is validated client-side before sending. This catches bugs early and prevents user-caused errors from reaching the network (the server validates everything independently):

```js
// ws.js
const validateName = (name) => {
  name = name.trim().replace(/<[^>]*>/g, '')  // strip HTML tags
  if (name.length === 0 || name.length > 32) return null
  return name
}
```

---

## Playback State Machine

The file loading and playback flow is explicit. One `setFileState` function drives what the user sees:

```
WAITING_FOR_FILE
    ↓ (user drops/selects file)
HASHING
    ↓ (Worker finishes)
HASH_MISMATCH_WARNING  ──→  READY (user confirms)
    ↓ (hash matches or user confirms)
READY
    ↓ (sync play command received)
PLAYING  ←→  PAUSED
```

```js
// state.js
const FILE_STATES = {
  WAITING:  'waiting',
  HASHING:  'hashing',
  MISMATCH: 'mismatch',
  READY:    'ready',
  PLAYING:  'playing',
  PAUSED:   'paused'
}

const setFileState = (state) => {
  roomState.fileState = state
  notifyUpdate()
}
```

The UI renders only what is relevant to the current state. In `WAITING`, controls are hidden. In `HASHING`, the file picker is disabled. In `MISMATCH`, a warning banner appears inline — not a modal — with a "Proceed anyway" option. Nothing blocks playback permanently.

---

## File Handling

### Drag-and-Drop Zone

The entire lobby panel is droppable. Users will drag files onto it without reading instructions:

```js
// player.js
panel.addEventListener('dragover', (e) => e.preventDefault())
panel.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (file) loadFile(file)
})
panel.addEventListener('click', () => fileInput.click())
```

No default `<input type="file">` styling. The zone is the input.

### Blob URL Lifecycle

```js
// player.js
const loadFile = (file) => {
  if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)  // clean up previous
  roomState.file = file
  roomState.blobUrl = URL.createObjectURL(file)
  video.src = roomState.blobUrl
  setFileState(FILE_STATES.HASHING)
  fingerprintWorker.postMessage({ file })
}
```

The blob URL is revoked when replaced or when the room is left. No memory leak from holding large file references.

### Fingerprint Worker

SHA-256 of first 10MB + last 10MB. Runs entirely in a Web Worker — the main thread is never blocked by hashing a multi-gigabyte file:

```js
// fingerprint.js (Worker)
self.onmessage = async ({ data: { file } }) => {
  const CHUNK = 10 * 1024 * 1024  // 10MB
  const start = file.slice(0, CHUNK)
  const end   = file.slice(Math.max(0, file.size - CHUNK))

  const [startBuf, endBuf] = await Promise.all([
    start.arrayBuffer(),
    end.arrayBuffer()
  ])

  const combined = new Uint8Array(startBuf.byteLength + endBuf.byteLength)
  combined.set(new Uint8Array(startBuf), 0)
  combined.set(new Uint8Array(endBuf), startBuf.byteLength)

  const hash = await crypto.subtle.digest('SHA-256', combined)
  const hex = Array.from(new Uint8Array(hash))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')

  self.postMessage({ hash })
}
```

No spinner shown during hashing — it resolves in under a second on any reasonable machine. The result appears silently: green checkmark on match, warning banner on mismatch. Visual noise for a fast operation is worse than no feedback.

---

## Sync Engine

### The Core Rule

**Never act locally first.** When the user presses pause, the UI sends the command to the server and waits. The round-trip on a good connection is under 100ms — imperceptible. What you gain is that every client is anchored to the same canonical position.

### Sending Commands

```js
// sync.js
const sendSync = (action) => {
  wsSend(action, { position: video.currentTime })
}

playBtn.addEventListener('click', () => sendSync('play'))
pauseBtn.addEventListener('click', () => sendSync('pause'))
seekBar.addEventListener('change', () => sendSync('seek'))
```

The user clicks play. The button does not toggle. The video does not start. The command goes to the server. The server echoes it back with a timestamp. Then the video starts.

### Receiving Commands — Timestamp Compensation

```js
// sync.js
const applySync = ({ action, position, serverTime }) => {
  const latency = (Date.now() - serverTime) / 1000  // convert to seconds

  if (action === 'play') {
    video.currentTime = position + latency
    video.play()
  } else if (action === 'pause') {
    video.currentTime = position
    video.pause()
  } else if (action === 'seek') {
    video.currentTime = position
  }

  roomState.playback = { playing: action === 'play', position, serverTime }
  notifyUpdate()
}
```

`latency` is the transit time of the message. For play commands, `currentTime` is nudged forward so all clients start from the same real-world moment even though the message arrived at slightly different times for each.

### Late Join — Catching Up

When `room_state` arrives with a `playback` field, apply it immediately:

```js
// sync.js
const applyInitialPlayback = (playback) => {
  if (!playback) return
  const elapsed = playback.playing ? (Date.now() - playback.serverTime) / 1000 : 0
  video.currentTime = playback.position + elapsed
  if (playback.playing) video.play()
  else video.pause()
}
```

A user who joins mid-movie is immediately at the correct position with no manual intervention.

### Drift Checker — Web Worker

Browsers throttle `setInterval` in backgrounded tabs to once per second or worse. The drift checker must run in a Web Worker:

```js
// worker.js
setInterval(() => self.postMessage({ type: 'tick' }), 2000)
```

```js
// sync.js
const driftWorker = new Worker('worker.js')

driftWorker.onmessage = () => {
  if (!roomState.playback.playing) return

  const expected = roomState.playback.position +
    (Date.now() - roomState.playback.serverTime) / 1000
  const drift = Math.abs(expected - video.currentTime)

  if (drift > 2) {
    video.currentTime = expected        // hard seek for large drift
  } else if (drift > 0.5) {
    video.playbackRate = expected > video.currentTime ? 1.05 : 0.95
  } else {
    video.playbackRate = 1.0            // back to normal
  }
}
```

For drift under 500ms: nothing visible. 500ms–2s: playback rate nudged 5% until back in sync. Over 2s: hard seek. The user never sees any of this.

---

## WebRTC Module

This is the most complex module — 300–400 lines is accurate and expected. The complexity is irreducible. The discipline is keeping all of it inside `webrtc.js`. ICE logic, SDP negotiation, and peer connection state never leak into other modules.

### Internal Structure (comment-delimited sections)

```js
// webrtc.js

// === CONFIGURATION ===
// === PEER CONNECTION MANAGEMENT ===
// === SIGNALING (SDP + ICE) ===
// === MEDIA TRACKS ===
// === TILE LIFECYCLE ===
// === PUBLIC API ===
```

### TURN Credential Fetching — Lazy and Cached

```js
// webrtc.js
let turnCredentials = null

const getTurnCredentials = async () => {
  if (turnCredentials) return turnCredentials
  const res = await fetch('/api/turn-credentials')
  turnCredentials = await res.json()
  return turnCredentials
}
```

Fetched only when a peer connection is actually being created. Reused for the entire session. A user who never needs TURN never makes this request.

### Camera Request — Deferred Until Needed

`getUserMedia` is not called on room join. It is called when the second member joins:

```js
// webrtc.js
const onMemberJoined = (member) => {
  addMember(member)
  if (roomState.members.length >= 2 && !roomState.localStream) {
    requestCamera()
  }
}
```

No permission prompt when sitting alone in a room. The camera request is triggered by a social moment — someone else arriving.

### Full Mesh — Offer/Answer Per Pair

When a new user joins, existing users each create a peer connection and send an SDP offer. The new user answers each one. Signaling goes through the WebSocket relay:

```
Client → Server: { type: "webrtc_offer",  payload: { targetUserId, sdp } }
Client → Server: { type: "webrtc_answer", payload: { targetUserId, sdp } }
Client → Server: { type: "ice_candidate", payload: { targetUserId, candidate } }
```

The server relays these to `targetUserId` without inspecting them.

### Audio Track Isolation

Only the microphone track is added to each peer connection. The `<video>` element's audio output is never touched:

```js
// webrtc.js
const addTracksToConnection = (pc, stream) => {
  stream.getAudioTracks().forEach(track => pc.addTrack(track, stream))  // mic only
  stream.getVideoTracks().forEach(track => pc.addTrack(track, stream))  // camera only
  // video element audio is never added — remote users never hear the movie echo
}
```

This is the audio architecture from the HLD in code form. A deliberate omission, not an oversight.

---

## Camera Tile Layout

Tiles are `<video>` elements inside `<div id="tiles">` positioned over the main `<video>`. Layout recalculates on every membership change:

```js
// webrtc.js
const layoutTiles = (count) => {
  const cols = count <= 2 ? count : Math.ceil(Math.sqrt(count))
  tilesContainer.style.gridTemplateColumns = `repeat(${cols}, 160px)`
}
```

```
1 user   → no tiles (watching alone, camera not requested)
2 users  → 1 remote tile
3–4      → 2×2 grid
5–6      → 2×3 grid
```

Your own tile always uses the local `getUserMedia` stream and is always `muted` to prevent feedback. No FLIP animation on reflow. Tiles snap into position — correct for the aesthetic.

---

## Control Bar

A `<div>` fixed to the bottom of the watch view. Auto-hides after 3 seconds of mouse inactivity using `opacity` only — no `display: none`, no layout shift:

```css
#controls {
  opacity: 1;
  transition: opacity 0.3s;
}
#controls.hidden {
  opacity: 0;
  pointer-events: none;
}
```

```js
// ui.js
let hideTimer
document.addEventListener('mousemove', () => {
  controls.classList.remove('hidden')
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => controls.classList.add('hidden'), 3000)
})
```

### Elements

- Play/pause: displays current state, not the action — shows ▶ when paused, ⏸ when playing
- Seek bar: `<input type="range">` — styled with vendor-prefixed pseudoelements (~25 CSS lines budgeted)
- Time display: `currentTime / duration` in `HH:MM:SS`
- Volume slider: `<input type="range">`
- Mute button: 🔇 / 🔊

Browser native `<video>` controls are removed (`controls` attribute absent). All keyboard shortcuts intercepted manually:

```js
// ui.js
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return  // don't intercept while typing
  if (e.code === 'Space')      { e.preventDefault(); sendSync(video.paused ? 'play' : 'pause') }
  if (e.code === 'ArrowRight') { e.preventDefault(); video.currentTime += 5; sendSync('seek') }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); video.currentTime -= 5; sendSync('seek') }
  if (e.code === 'KeyM')       { video.muted = !video.muted }
})
```

---

## Layout — Watch View

```
┌─────────────────────────────────────────────────────┐
│                                                     │
│                                                     │
│                  <video> element                    │ ← 100vw × 100vh
│              object-fit: contain                    │   black background
│              background: #000                       │
│                                                     │
│                                        ┌──────────┐ │
│                                        │ Cam tiles│ │ ← position: absolute
│                                        │          │ │   top-right corner
│                                        └──────────┘ │
│                                                     │
│  ┌──────────────────────────────────────────────┐   │
│  │ ▶  ━━━━━━━━━━━━━━━━━━━  01:23:45 / 02:15:00 │   │ ← position: absolute
│  └──────────────────────────────────────────────┘   │   bottom: 0
│                                                     │
└─────────────────────────────────────────────────────┘
                                     ┌────────────────┐
                                     │  Room sidebar  │ ← slides in from right
                                     │  WOLF-BEAR-482 │   transform: translateX
                                     │  Members       │
                                     └────────────────┘
```

The sidebar uses a tab handle sticking out from the right edge. `transform: translateX(100%)` when hidden, `translateX(0)` when open. The room code is always visible inside with a one-click copy button.

---

## Security — Client Side

The server validates everything. The client validates too — not for security but to catch errors early:

| Input | Client validation |
|---|---|
| Display name | Strip HTML tags, trim whitespace, reject empty, cap at 32 chars |
| Room code | Uppercase, match `[A-Z]+-[A-Z]+-[0-9]+` before any request |
| File type | Warn if not `.mp4` — not a hard block, just a signal |
| WebSocket messages received | Check `type` is a string, `payload` is an object — malformed messages dropped |
| TURN credentials | Only fetched from same-origin `/api/turn-credentials` — never direct to Twilio |

No user input ever reaches the DOM as raw HTML. Display names are set via `textContent`, never `innerHTML`. This eliminates XSS from user-controlled content regardless of what the server echoes back.

---

## Error and Status Display — Minimal Interruption

| Event | Treatment |
|---|---|
| WebSocket reconnecting | Small pill at top: "Reconnecting..." — auto-dismisses on reconnect |
| File hash mismatch | Yellow inline banner: "File may not match. Proceed anyway?" |
| Room full | Shown on lobby before WebSocket attempt — clear message, link to create own room |
| WebRTC peer failure | That peer's tile goes dark with name still showing. Others continue. |
| Server error | `error` message type: dismissible inline banner — never a modal |

No toast notifications for routine events. "Alice joined" updates the member list silently. Notifications are reserved for things the user needs to act on.

---

## What the Frontend Deliberately Does Not Do

| Thing | Reason |
|---|---|
| Use a framework | No hydration overhead, no virtual DOM, no framework bootstrap |
| Use ES6 `import/export` | Would require a bundler — `cat` is sufficient |
| Load external fonts | Every external request at load time costs a full round trip |
| Use `localStorage` for session tokens | Survives tab close — wrong semantics for an ephemeral session |
| Act on playback commands locally | Correctness requires going through the server |
| Request camera on room join | Defer until socially contextual — second member arrives |
| Show spinners for fast operations | File hashing is fast — a spinner that immediately disappears is noise |
| Use modals for recoverable states | Inline banners, never modal dialogs for anything non-destructive |
| Animate tile reflow | Tiles snap — consistent with the aesthetic and simpler |

---

## Build Order Within Step 2

Working and testable at every checkpoint:

```
1. index.html skeleton + style.css
   Three views, CSS state machine, colour palette, typography
   Static — no JS at all
   Goal: aesthetic is locked in before any logic is written

2. state.js + ws.js + ui.js wired to landing and lobby views
   WebSocket connects, join message sent, session token stored
   Member list renders from room_state and user_joined/user_left events
   Goal: two browser tabs can see each other join and leave in real time

3. player.js — file picker and local playback
   Drag-and-drop zone, blob URL, <video> element playing locally
   No sync yet — just local playback working correctly
   Goal: pick a file and watch it in the browser

4. sync.js — control bar wired through server
   play/pause/seek sends to server, applies on receive with timestamp compensation
   Late join catchup from room_state playback field
   Goal: two tabs stay in sync when one presses play

5. fingerprint.js Worker
   Hash computed in Worker, result sent to server, mismatch warning displayed
   Goal: hash mismatch banner appears correctly

6. worker.js — drift checker
   Web Worker ticking every 2s, drift detection and gentle rate correction
   Goal: backgrounded tab silently catches up on return

7. webrtc.js — peer connections and camera tiles
   Signaling through WebSocket relay, getUserMedia deferred, tile layout
   Goal: two browser windows can see each other's cameras

8. Polish
   Control bar auto-hide, keyboard shortcuts, sidebar toggle, mobile layout check
   Goal: feels complete
```

Steps 1–4 are fully testable before a single WebRTC line is written. Steps 5–6 are independent of WebRTC. Step 7 comes last.

---

## Memory and Performance Profile

```
DOM nodes at steady state (4 users)
  3 <section> views (2 hidden)      ≈  3 nodes
  1 main <video>                    =  1 node
  4 camera <video> tiles            =  4 nodes
  control bar + sidebar             ≈ 18 nodes
  ─────────────────────────────────────────────
  Total                             ≈ 26 nodes

JavaScript memory
  roomState object                  = negligible
  4 RTCPeerConnection objects       ≈ 2MB  (browser managed)
  1 MediaStream (local camera)      ≈ 1MB  (browser managed)
  app.js parsed and JIT-compiled    ≈ 500KB
  ─────────────────────────────────────────────
  Total JS heap                     ≈ 4MB

Network after initial load
  WebSocket messages                < 1KB each
  TURN credential fetch             one request, ≈ 200B response, only if needed
  All media                         P2P — server never in the media path
```

This is a frontend that the cheapest phone from 2019 can run without strain.