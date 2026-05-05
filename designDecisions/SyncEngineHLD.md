# Step 4 — Sync Engine — High Level Design

## What This Step Is

`sync.js` — one new file, ~120 lines. It plugs into the existing architecture with minimal surface changes: one line in `player.js`, two handlers added to `ws.js`, and new message routing in `hub.go`'s `readPump`. No new dependencies, no build step changes.

The sync engine receives authoritative playback commands from the server, applies latency compensation using a one-time clock sync, updates `roomState.playback`, and lets `player.js` drive the video. It runs a Web Worker heartbeat to catch drift in backgrounded tabs.

**Principles applied:**
- **Fast** — no queues, no async chains. Single `localApplyTime` shadow state. `sync.js` listens to existing `player:action` events.
- **Secure** — server is sole authority. Clients never trust each other. All playback state flows server → all clients.
- **Light** — ~120 lines, no new dependencies, no build step changes.
- **Smooth** — latency compensation where it helps, gentle drift correction, seamless reconnect.

---

## What Changes

```
frontend/public/js/
├── state.js        Add clockOffset to roomState (default 0); include in resetRoomState()
├── ws.js           Add clock_sync send in session_init handler; add clock_sync response handler
├── player.js       One change: seekBar 'change' → 'pointerup' for dispatchPlayerAction
├── sync.js         NEW — listens to player:action, applies server commands, drift guard
├── worker.js       NEW — drift checker (separate file; cannot be concatenated)
└── ui.js           No changes — renders from roomState.playback
```

**Go server:** add `sync_command` handler in `readPump`'s switch — validate, stamp, update room state, call `broadcastToRoom` directly (includes sender). Add `sync_state` send on join if room has playback state. Add `clock_sync` handler. No changes to `handleBroadcast`. No new routes. No Redis schema changes.

---

## Local Optimism — Explicit Position

`player.js` acts on playback immediately when the user clicks play/pause:

```js
// player.js (existing, unchanged)
btnPlayPause.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(...)             // acts locally first
    dispatchPlayerAction('play', video.currentTime)
  } else {
    video.pause()                       // acts locally first
    dispatchPlayerAction('pause', video.currentTime)
  }
})
```

This is **intentional local optimism for the initiating user only.** The flow:

1. User clicks play → video starts locally, `player:action` fires.
2. `sync.js` intercepts, sends `sync_command` to server.
3. Server echoes authoritative broadcast back to all clients including sender.
4. `applySync` fires on the initiating client and calls `player.play(target)` with the latency-compensated position.

**Effect for the initiating user:** for `play`, the video has been running for ~100ms, then `applySync` seeks it forward by the latency offset (~50–150ms). This is a small, mostly invisible correction and is the correct authoritative position. For `pause`, `player.pause(target)` seeks to the same position already set — benign no-op. This is v1 behaviour. A future step could suppress local action until the echo arrives; not done here.

---

## Clock Sync — Once, After Join

**Critical ordering:** `hub.go` requires `join` as the first client message. `clock_sync` is sent from the `session_init` handler, which fires after the server has processed `join` and responded. Never sent on `ws.onopen`.

```js
// ws.js — inside the session_init handler
onMessage('session_init', (payload) => {
  if (payload.userId) roomState.myUserId = payload.userId
  wsSend('clock_sync', { clientTime: Date.now() })
  // no notifyUpdate here — room_state arrives immediately after
})
```

**Server → Client response:**
```json
{
  "type": "clock_sync",
  "payload": { "clientTime": 1746392847213, "serverTime": 1746392847231 }
}
```

**Client computes:**
```js
// ws.js — clock_sync response handler
onMessage('clock_sync', (payload) => {
  const roundTrip = Date.now() - payload.clientTime
  const latency = roundTrip / 2
  roomState.clockOffset = payload.serverTime - (payload.clientTime + latency)
})
```

**`localApplyTime` reset:** The `clock_sync` response is the last event before sync commands start flowing on every connect and reconnect. `sync.js` registers its own `clock_sync` listener to reset `localApplyTime`:

```js
// sync.js — init
onMessage('clock_sync', () => {
  localApplyTime = 0
})
```

This avoids coupling into `ws.js` internals. Because `handlers` is a plain object keyed by type, registering two handlers for the same type would silently overwrite. `clock_sync` is therefore split: `ws.js` computes and stores `clockOffset`; `sync.js` resets `localApplyTime`. These are registered on different module init — load order must place `ws.js` before `sync.js` in the HTML so the `ws.js` handler runs first. Document this in the script tag order.

No re-sync after initial handshake. Browser clock drift over 4 hours is < 100ms, negligible vs. network jitter (20–200ms).

**Assumption:** `latency = roundTrip / 2` assumes symmetric paths. Asymmetric routes (mobile/satellite) may bias offset by ~50ms. Documented; not engineered around for v1.

---

## Message Protocol

All messages use the existing `{ type, payload }` envelope from Step 1.

### Client → Server

```js
wsSend('sync_command', { action: 'pause', position: 4521.3 })
wsSend('sync_command', { action: 'play',  position: 4521.3 })
wsSend('sync_command', { action: 'seek',  position: 8043.7 })
```

`action` and `position` live inside `payload`. The Go server unmarshals `env.Payload` to read them.

### Server → All Clients (Authoritative Broadcast)

```json
{
  "type": "sync_command",
  "payload": {
    "action": "pause",
    "position": 4521.3,
    "serverTime": 1746392847213,
    "isPlaying": false
  }
}
```

`serverTime` is `time.Now().UnixMilli()` at processing time. `isPlaying` is explicit so clients need no inference. The sender receives their own broadcast and acts on it identically to all other clients.

**Go routing:** `sync_command` is handled inline in `readPump`'s switch and dispatched via `broadcastToRoom` (includes sender). `handleBroadcast` / the `broadcast` channel are untouched — that path is for `relay` messages which correctly exclude the sender.

### Server → Late Joiner

```json
{
  "type": "sync_state",
  "payload": {
    "action": "seek",
    "position": 4589.1,
    "serverTime": 1746392847213,
    "isPlaying": true
  }
}
```

If `isPlaying` is true, server computes `position = storedPosition + (now - recordedAt) / 1000` before sending. Client processes through standard `applySync()` — no special-casing.

---

## Server-Side Processing

### `readPump` routing

```go
// hub.go — readPump switch (add alongside existing 'relay' case)
switch env.Type {
case "relay":
    c.hub.broadcast <- &Message{
        roomCode:     c.roomCode,
        senderUserId: c.userId,
        data:         raw,
    }
case "clock_sync":
    var p struct {
        ClientTime int64 `json:"clientTime"`
    }
    if err := json.Unmarshal(env.Payload, &p); err != nil { continue }
    c.conn.WriteMessage(websocket.TextMessage, makeEnvelope("clock_sync", map[string]interface{}{
        "clientTime": p.ClientTime,
        "serverTime": time.Now().UnixMilli(),
    }))
case "sync_command":
    c.hub.handleSyncCommand(c, env.Payload)
default:
    // unknown — drop silently
}
```

`handleSyncCommand` is called directly on the Hub from `readPump` — it does **not** go through the `broadcast` channel, because that channel's consumer (`handleBroadcast`) excludes the sender. Direct call to `broadcastToRoom` is the only way to guarantee the sender receives their own echo.

### `handleSyncCommand`

```go
func (h *Hub) handleSyncCommand(c *Client, raw json.RawMessage) {
    var p struct {
        Action   string  `json:"action"`
        Position float64 `json:"position"`
    }
    if err := json.Unmarshal(raw, &p); err != nil { return }

    // Validate
    validActions := map[string]bool{"play": true, "pause": true, "seek": true}
    if !validActions[p.Action] || p.Position < 0 || p.Position >= 86400 { return }

    // Rate limit — max 5 sync commands/second per client
    // Client struct carries: lastSyncWindow int64, syncCount int
    now := time.Now().UnixMilli()
    if now-c.lastSyncWindow > 1000 {
        c.lastSyncWindow = now
        c.syncCount = 0
    }
    c.syncCount++
    if c.syncCount > 5 { return }

    serverTime := now
    isPlaying := p.Action == "play" || (p.Action == "seek" && h.getRoomIsPlaying(c.roomCode))
    if p.Action == "pause" { isPlaying = false }

    // Update room playback state
    h.setRoomPlayback(c.roomCode, RoomPlaybackState{
        Action:     p.Action,
        Position:   p.Position,
        RecordedAt: serverTime,
        IsPlaying:  isPlaying,
    })

    // Broadcast to all clients including sender
    h.broadcastToRoom(c.roomCode, makeEnvelope("sync_command", map[string]interface{}{
        "action":     p.Action,
        "position":   p.Position,
        "serverTime": serverTime,
        "isPlaying":  isPlaying,
    }))
}
```

Rate limit fields (`lastSyncWindow int64`, `syncCount int`) are added to the `Client` struct. They are read and written only in `readPump` — which runs in the client's own goroutine — so no mutex is needed for them.

### Room State Struct

```go
type RoomPlaybackState struct {
    Action     string  // "play" | "pause" | "seek"
    Position   float64 // seconds
    RecordedAt int64   // unix ms — used for late-join elapsed calculation
    IsPlaying  bool    // true after play, false after pause, preserved on seek
}
```

One struct per room, stored in a `map[string]RoomPlaybackState` on the Hub. `RecordedAt` serves both as the broadcast timestamp and the base for late-join position calculation — no separate `ServerTime` field needed.

### Concurrency note

The Hub is a single goroutine. `handleSyncCommand` is called from `readPump`, which runs in the client's goroutine — this means it runs concurrently with the Hub goroutine. `setRoomPlayback`, `getRoomIsPlaying`, and `broadcastToRoom` must acquire `h.mu` as a write lock when touching the playback state map. The existing `sync.RWMutex` on Hub is already used for `roomMemberCount`; extend its scope to cover playback state reads and writes.

---

## Client-Side Execution

### sync.js — init

```js
// sync.js

let localApplyTime = 0

// Reset baseline on every connect/reconnect (clock_sync fires after session_init on each connect)
onMessage('clock_sync', () => {
  localApplyTime = 0
})

// Intercept player actions and route through server — no local optimism in the sync path
document.addEventListener('player:action', (e) => {
  const { action, position } = e.detail
  wsSend('sync_command', { action, position })
})

// Apply authoritative commands from server (including sender's own echo)
onMessage('sync_command', (payload) => applySync(payload))
onMessage('sync_state',   (payload) => applySync(payload))
```

`sync.js` does not wire the control bar. It intercepts `player:action` events that `player.js` already dispatches. `player.nudge()` (arrow key shortcuts) dispatches `player:action` — arrow key nudges sync to all clients automatically.

### player.js — one change

Replace the `change` listener on `seekBar` with `pointerup`:

```js
// player.js — replace lines 173-175
// Before:
seekBar.addEventListener('change', () => {
  dispatchPlayerAction('seek', video.currentTime)
})

// After:
seekBar.addEventListener('pointerup', () => {
  dispatchPlayerAction('seek', video.currentTime)
})
```

`pointerup` fires exactly once on pointer release, cross-browser, with no ambiguity. `change` on range inputs fires inconsistently during drag on iOS Safari. The `input` listener (local seek feedback) is unchanged.

**Known gap:** if a user tabs to the seekbar and uses keyboard arrow keys, the slider moves and local seek fires (`input`), but `pointerup` does not fire — no sync command is sent. This is distinct from the arrow key shortcuts (`ArrowLeft`/`ArrowRight` on the document) which do sync via `player.nudge()` → `player:action`. Documented limitation for v1.

### Compensation Logic

| Action | Compensation | Reason |
|---|---|---|
| `play` | `position + latencyOffset` | Video was stopped; jump forward to where it should be now |
| `pause` | `position` verbatim | Shared constant — identical for everyone is optimal |
| `seek` + `isPlaying: true` | `position + latencyOffset` | Video kept running during transit |
| `seek` + `isPlaying: false` | `position` verbatim | Video was stopped; position is already accurate |

For `pause`: adding individual latency offsets per client would introduce divergence proportional to each client's server distance. Compensation for pause is counterproductive.

### applySync — Synchronous

```js
function applySync(msg) {
  const latencyOffset = (Date.now() + roomState.clockOffset - msg.serverTime) / 1000

  let target = msg.position
  if (msg.action !== 'pause' && !(msg.action === 'seek' && !msg.isPlaying)) {
    target += latencyOffset
  }

  target = Math.min(target, video.duration || Infinity)
  // Note: video.duration may be NaN before metadata loads; NaN || Infinity = Infinity — correct.

  roomState.playback = {
    playing:    msg.isPlaying,
    position:   target,
    serverTime: msg.serverTime,
  }

  if (msg.action === 'play') {
    player.play(target)
  } else if (msg.action === 'pause') {
    player.pause(target)
  } else if (msg.action === 'seek') {
    player.seekTo(target)
    msg.isPlaying ? player.play(target) : player.pause(target)
  }

  localApplyTime = Date.now()
  notifyUpdate()
}
```

`localApplyTime` records when the client actually applied the command. `roomState.playback.position` is already latency-compensated; computing elapsed from `serverTime` would double-count the initial latency offset. `localApplyTime` anchors elapsed time correctly.

---

## Drift Guard — Web Worker

### worker.js

```js
// worker.js — separate file, cannot be concatenated with sync.js
self.setInterval(() => self.postMessage({ type: 'tick' }), 5000)
self.addEventListener('message', (e) => {
  if (e.data.type === 'check') self.postMessage({ type: 'tick' })
})
```

### sync.js — drift guard

```js
// Use absolute path — relative paths resolve against the page URL, not the script location.
// On /room/WOLF-BEAR-482134, 'worker.js' would request /room/worker.js — 404.
const driftWorker = new Worker('/js/worker.js')

driftWorker.onerror = () => {
  // Restart worker on crash — drift correction degrades gracefully without it
  driftWorker = new Worker('/js/worker.js')
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    driftWorker.postMessage({ type: 'check' })
  }
})

driftWorker.onmessage = () => {
  if (localApplyTime === 0) return  // no baseline yet — skip until first applySync
  if (video.paused) return          // rebuffering or genuinely paused — skip

  const elapsed  = (Date.now() - localApplyTime) / 1000
  const expected = roomState.playback.position + elapsed
  const drift    = Math.abs(expected - video.currentTime)

  if (drift > 2) {
    video.playbackRate = 1.0    // reset rate before hard seek
    player.seekTo(expected)
  } else if (drift > 0.5) {
    video.playbackRate = expected > video.currentTime ? 1.05 : 0.95
  } else {
    video.playbackRate = 1.0
  }
}
```

**`localApplyTime === 0` guard:** without this, on reconnect `elapsed ≈ 1.7 billion seconds`, `expected` overflows, and the hard-seek path clamps to `video.duration` — landing the user at the end of the video. This guard is load-bearing. `video.paused` alone does not save you here if the video is playing at the time of reconnect.

**`video.playbackRate = 1.0` before hard seek:** if a previous tick set rate to 1.05 and drift then grows past 2s, the hard seek fires but rate stays at 1.05 indefinitely — the next tick would need drift to fall in the 0.5–2s band to reset it, which after a hard seek it usually won't. Reset rate explicitly before seeking.

**Why `video.paused` not `roomState.playback.playing`:** during seek rebuffer, the video element reports `paused = true` while `roomState.playback.playing` may still be `true`. Using `video.paused` prevents spurious drift correction against a buffering video.

---

## Conflict Resolution

Two users press play within milliseconds. The Hub goroutine processes `sync_command` messages sequentially (one `readPump` goroutine per client, but `handleSyncCommand` acquires the write mutex). First to acquire the lock wins; its state is broadcast. The second message results in an identical or near-identical broadcast — harmless.

Play vs. pause conflict: first to the server wins, its state is broadcast, the losing client sees their action reversed ~100ms later. Correct and expected behaviour.

---

## state.js additions

```js
const roomState = {
  // ... existing fields ...
  clockOffset: 0,   // ADD: ms offset between server clock and local clock
}

const resetRoomState = () => {
  // ... existing resets ...
  roomState.clockOffset = 0   // ADD: clear offset on leave so stale value doesn't
                               // affect clock_sync calculation on next join
}
```

---

## Edge Cases

| Scenario | Handling |
|---|---|
| User joins while playing | Server computes `position + elapsed`, sends `sync_state` with `isPlaying: true`; `applySync` seeks and plays |
| User joins while paused | Server sends `sync_state` with `isPlaying: false`; `applySync` seeks and pauses |
| User joins mid-scrub | Server sends pre-scrub position. User waits for final seek command. Accepted for v1 |
| Tab backgrounds and returns | `visibilitychange` triggers immediate drift check; correction within one tick |
| User offline mid-session | Delayed delivery safe — broadcast carries ground truth position |
| Seek < 0 | Server rejects, drops message silently |
| Seek ≥ 86400 | Server rejects, drops message silently |
| Seek beyond `video.duration` | Client clamps: `Math.min(target, video.duration \|\| Infinity)` |
| High latency (> 2s) | Offset applies; position jumps forward. Correct but jarring. Not engineered around for v1 |
| Seek spam | `pointerup` debounce (fires once on release) + server rate limiter (5/s) |
| Slow client blocking broadcast | `broadcastToRoom` uses non-blocking `select/default`; dead connections evicted after broadcast loop |
| Server restart | In-memory state lost. Reconnecting clients get no `sync_state`; wait for next user command. Hard failure accepted for v1 |
| Clock skew | Single handshake on connect covers dominant case. Drift < 100ms over 4h is negligible vs. network jitter |
| Late joiner beyond duration | Client clamps to `video.duration`; silently placed at end. Documented limitation |
| Seek rebuffer during drift check | `video.paused` gate prevents spurious correction while buffering |
| Reconnect before first `sync_state` | `localApplyTime === 0` guard skips drift checks until first `applySync` fires |
| Two conflicting play/pause commands | Hub mutex serializes; first wins, second is harmless duplicate or gets reversed ~100ms later |
| Seekbar keyboard navigation | Tab to seekbar + arrow keys moves slider locally (`input` fires) but no `pointerup` → no sync command. Documented gap for v1. Distinct from document-level arrow key shortcuts which sync via `player.nudge()` |
| Initiating user play position correction | Local optimism: video starts immediately, then `applySync` corrects position by latency offset (~50–150ms) on echo. Intentional v1 behaviour |
| `video.duration` NaN before metadata | `NaN \|\| Infinity` = `Infinity` — clamp is a no-op. Correct |

---

## What Is Not Built in This Step

- Chat messages (Step 9)
- File fingerprint mismatch warning (Step 5)
- WebRTC signaling (Step 6)
- Persistent playback history
- Sequence numbers — debounce + rate limit sufficient for v1
- Periodic clock re-sync — drift over 4h is negligible
- Suppressing local optimism on the initiating client — deferred to a future step

---

## Build Sequence

1. **Go:** Add `lastSyncWindow int64` and `syncCount int` to `Client` struct.
2. **Go:** Add `RoomPlaybackState` struct and `playbackStates map[string]RoomPlaybackState` to Hub. Add `setRoomPlayback` and `getRoomIsPlaying` helpers with write-lock.
3. **Go:** Add `clock_sync` case to `readPump` switch — echo `clientTime` + `serverTime`.
4. **Go:** Add `sync_command` case to `readPump` switch — call `handleSyncCommand`. Implement `handleSyncCommand`: validate, rate-limit, stamp, update playback state, `broadcastToRoom`.
5. **Go:** Add `sync_state` send in `handleRegister` — if room has playback state, compute elapsed position if `isPlaying`, send `sync_state` to joining client.
6. **Go test:** Two tabs, same room — play/pause/seek stays locked; sender sees their own video respond.
7. **Client:** `state.js` — add `clockOffset: 0` to `roomState`; add reset to `resetRoomState()`.
8. **Client:** `ws.js` — add `wsSend('clock_sync', { clientTime: Date.now() })` at end of `session_init` handler; add `clock_sync` response handler to compute and store `roomState.clockOffset`.
9. **Client:** `player.js` — change `seekBar 'change'` → `'pointerup'` for `dispatchPlayerAction`.
10. **Client:** `sync.js` — `clock_sync` handler resets `localApplyTime = 0`; `player:action` listener sends `wsSend('sync_command', ...)`; `sync_command` and `sync_state` handlers call `applySync`; implement `applySync`.
11. **Client:** `worker.js` — 5s tick + `check` message response.
12. **Client:** `sync.js` — drift guard with `localApplyTime === 0` guard, `video.paused` gate, rate-reset before hard seek, `playbackRate` nudge for 0.5–2s, hard seek + rate reset for >2s.
13. **Integration test:** Three tabs, same room:
    - play/pause/seek stays locked across all three
    - late joiner catches up correctly
    - backgrounded tab corrects on return
    - initiating user sees their own video respond (with small position correction on play)
    - arrow key nudges (`ArrowLeft`/`ArrowRight`) sync to all clients
    - seekbar keyboard navigation (tab + arrow) does not sync — local only

Steps 1–10 are testable end-to-end before the Worker is written. The Worker is additive — sync works without it, degrading gracefully when tabs are backgrounded.

---

## Script Load Order

```html
<!-- HTML — order matters: ws.js registers clock_sync offset handler first -->
<script src="/js/state.js"></script>
<script src="/js/ws.js"></script>
<script src="/js/player.js"></script>
<script src="/js/sync.js"></script>  <!-- registers its own clock_sync handler second — both run -->
<script src="/js/ui.js"></script>
```

`handlers` in `ws.js` is a plain object. Registering two handlers for the same `type` would overwrite. The `clock_sync` type is split by responsibility: `ws.js` writes `clockOffset`, `sync.js` resets `localApplyTime`. Both must be registered — the simplest approach is to have `ws.js`'s `clock_sync` handler call `notifyClockSync()`, a small function that `sync.js` defines and `ws.js` calls. Alternatively, use a `CustomEvent` (`document.dispatchEvent(new CustomEvent('ws:clock_sync'))`). Either is fine; the CustomEvent approach keeps modules decoupled and is preferred.