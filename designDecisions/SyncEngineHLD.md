# Step 4 — Sync Engine — High Level Design

## What This Step Is

`sync.js` — one new file, ~120 lines. It plugs into the existing architecture with minimal surface changes: one line in `player.js`, two handlers added to `ws.js`, and a new `SyncEvent` type in `hub.go`. No new dependencies, no build step changes.

The sync engine receives authoritative playback commands from the server, applies them unconditionally (seek to position, play or pause), updates `roomState.playback`, and lets `player.js` drive the video. It runs a Web Worker heartbeat to catch drift in backgrounded tabs.

**Principles applied:**
- **Fast** — no queues, no async chains. `sync.js` listens to existing `player:action` events. Server processes sync commands on the hub goroutine with zero lock contention.
- **Secure** — server is sole authority. Clients never trust each other. All playback state flows server → all clients.
- **Light** — ~120 lines, no new dependencies, no build step changes. Typed payload struct eliminates per-broadcast heap allocations.
- **Smooth** — server-computed positions guarantee universal truth. Drift guard catches background-tab divergence.

---

## What Changes

```
frontend/public/js/
├── state.js        No sync-related additions needed
├── ws.js           Add sync_command and sync_state message handlers
├── player.js       Remove local optimism from play/pause; seekBar 'change' → 'pointerup'
├── sync.js         NEW — listens to player:action, applies server commands, drift guard
├── worker.js       NEW — drift checker (separate file; cannot be concatenated)
└── ui.js           No changes — renders from roomState.playback
```

**Go server:** add `SyncEvent` to the Hub's event system — `readPump` sends a `SyncEvent` into `h.events`; the hub goroutine processes it via `handleSyncCommand`. Add `sync_state` send on register if room has playback state. Clean up `playbackStates` when room empties. No clock sync. No new routes. No Redis schema changes.

---

## No Local Optimism — Explicit Position

There is no local optimism. When a user clicks play, pause, or seeks, the browser sends the command to the server and **waits**. The video does not change locally until the server's authoritative broadcast arrives back. The initiating user is treated identically to every other client in the room.

```js
// player.js — updated for step 4
btnPlayPause.addEventListener('click', () => {
  if (video.paused) {
    dispatchPlayerAction('play')    // sends to server, does NOT call video.play()
  } else {
    dispatchPlayerAction('pause')   // sends to server, does NOT call video.pause()
  }
})
```

The flow:

1. User clicks play → `player:action` fires with `{ action: 'play' }`.
2. `sync.js` intercepts, sends `sync_command` to server.
3. `readPump` sends a `SyncEvent` into `h.events`.
4. Hub goroutine picks it up, validates, computes authoritative position, broadcasts to all clients including sender.
5. `applySync` fires on all clients — seek to position, execute action.

**Effect:** there is a ~50–150ms perceived delay between clicking and the video responding. This is the cost of universal truth. Every user's video is pulled to the exact same server-computed position on every command, guaranteeing sync never drifts cumulatively.

---

## Message Protocol

All messages use the existing `{ type, payload }` envelope.

### Client → Server

```js
wsSend('sync_command', { action: 'play' })
wsSend('sync_command', { action: 'pause' })
wsSend('sync_command', { action: 'seek', position: 8043.7 })
```

`play` and `pause` carry no position — the server computes it. `seek` carries the target position chosen by the user.

### Server → All Clients (Authoritative Broadcast)

```json
{ "type": "sync_command", "payload": { "action": "play",  "position": 4521.3, "isPlaying": true  } }
{ "type": "sync_command", "payload": { "action": "pause", "position": 4589.1, "isPlaying": false } }
{ "type": "sync_command", "payload": { "action": "seek",  "position": 8043.7, "isPlaying": true  } }
```

`position` is the authoritative playback position computed by the server. `isPlaying` is the resulting state. Clients seek to `position` and then play or pause based on `isPlaying`. No interpretation, no compensation.

### Server → Late Joiner

```json
{ "type": "sync_state", "payload": { "action": "seek", "position": 4589.1, "isPlaying": true } }
```

If `isPlaying` is true, server computes `position = lastRecordedPosition + time.Since(recordedAt).Seconds()` before sending. Client processes through standard `applySync()` — no special-casing.

---

## Server-Side State

### Room Playback State

```go
type RoomPlaybackState struct {
    LastRecordedPosition float64
    RecordedAt           time.Time // preserves monotonic clock — use now.Sub(RecordedAt).Seconds()
    IsPlaying            bool
}
```

One struct per room, stored in `h.playbackStates` on the Hub. **Hub-goroutine-only — no mutex needed.** All reads and writes happen inside `handleSyncCommand`, `handleRegister`, and `dropClient`, which all execute on the hub goroutine via the event loop.

**Why `time.Time` not `int64`:** `time.Now().UnixMilli()` strips Go's monotonic clock component. If the server's NTP daemon steps the clock backward during a session, `elapsed` goes negative and `LastRecordedPosition` corrupts for every client in the room. `time.Time` preserves the monotonic reading. `now.Sub(state.RecordedAt).Seconds()` compares monotonic readings and is immune to NTP corrections, DST transitions, and manual clock adjustments.

**Initialisation:** written on the first `sync_command` received for a room with no existing playback state. Defaults to position 0, paused.

**Cleanup:** deleted in `dropClient` when the room empties — prevents unbounded map growth on a long-running server with many transient rooms.

### Broadcast Payload Type

```go
type SyncCommandPayload struct {
    Action    string  `json:"action"`
    Position  float64 `json:"position"`
    IsPlaying bool    `json:"isPlaying"`
}
```

Used for both `sync_command` and `sync_state` messages. Typed struct instead of `map[string]interface{}` — eliminates a heap allocation and reflection-based marshal on every broadcast. At N clients per room each sync command triggers N marshals; this matters on the hot path.

---

## Server-Side Processing

### Event Routing — `readPump`

`sync_command` messages are sent into `h.events` as a `SyncEvent`. The hub goroutine processes them via `handleSyncCommand`. This is the key architectural difference from a naive direct call:

```go
// readPump switch
case "relay":
    c.hub.events <- &RelayEvent{
        roomCode:     c.roomCode,
        senderUserId: c.userId,
        data:         raw,
    }
case "sync_command":
    // Routed to hub goroutine via SyncEvent — handleSyncCommand runs there,
    // so h.playbackStates needs no mutex. broadcastToRoom reads h.rooms on
    // the hub goroutine — also safe with no lock.
    c.hub.events <- &SyncEvent{
        client: c,
        raw:    env.Payload,
    }
```

**Why not call `handleSyncCommand` directly from `readPump`:** a direct call runs on the readPump goroutine. `broadcastToRoom` then reads `h.rooms` on the readPump goroutine while the hub goroutine may be writing it in `handleRegister` or `dropClient`. Go maps are not safe for concurrent read+write — this panics. Routing through `h.events` guarantees `handleSyncCommand` runs on the hub goroutine, where `h.rooms` and `h.playbackStates` are owned exclusively.

### `handleSyncCommand`

Runs on the hub goroutine. No mutex needed for `h.playbackStates` or `h.rooms`.

```go
func (h *Hub) handleSyncCommand(c *Client, raw json.RawMessage) {
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
    default:
        return
    }

    // Rate limit — max 5 sync commands per second per client.
    // Monotonic arithmetic — immune to clock adjustments.
    now := time.Now()
    if now.Sub(c.lastSyncWindow) > time.Second {
        c.lastSyncWindow = now
        c.syncCount = 0
    }
    c.syncCount++
    if c.syncCount > 5 {
        return
    }

    // h.playbackStates — hub goroutine only, no mutex.
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
            return // silent drop — already playing
        }
        broadcastPosition = state.LastRecordedPosition
        state.RecordedAt = now
        state.IsPlaying = true
        broadcastIsPlaying = true

    case "pause":
        if !state.IsPlaying {
            return // silent drop — already paused
        }
        // Advance position lazily — now.Sub uses monotonic readings.
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
        // isPlaying unchanged — seek does not affect play/pause state.
        broadcastPosition = p.Position
        broadcastIsPlaying = state.IsPlaying
    }

    h.playbackStates[c.roomCode] = state

    // Broadcast to all clients including sender — no local optimism.
    h.broadcastToRoom(c.roomCode, makeEnvelope("sync_command", SyncCommandPayload{
        Action:    p.Action,
        Position:  broadcastPosition,
        IsPlaying: broadcastIsPlaying,
    }))
}
```

**Rate-limit fields:** `lastSyncWindow time.Time` and `syncCount int` live on `Client`. They are read and written only inside `handleSyncCommand`, which runs on the hub goroutine — no mutex needed.

**`MaxPlaybackPositionSeconds`:** defined as a named constant in `config.go` (value: 86400). No magic numbers in handler logic.

### Late Joiner — `handleRegister`

Runs on the hub goroutine. `h.playbackStates` is safe to read with no lock.

```go
// Inside handleRegister, after sending room_state
if state, exists := h.playbackStates[client.roomCode]; exists {
    position := state.LastRecordedPosition
    if state.IsPlaying {
        // time.Since uses the monotonic reading in state.RecordedAt.
        position += time.Since(state.RecordedAt).Seconds()
    }
    // Compute position locally for this send — do NOT persist the rebase.
    // The original RecordedAt stays unchanged so all future elapsed
    // calculations remain correct regardless of how many clients join.
    client.send <- makeEnvelope("sync_state", SyncCommandPayload{
        Action:    "seek",
        Position:  position,
        IsPlaying: state.IsPlaying,
    })
}
```

**No state mutation:** the computed `position` is used only for this one `sync_state` message. The persisted `RoomPlaybackState` is untouched. Any future `lastRecordedPosition + elapsed` calculation produces the correct current position regardless of how many clients have joined.

### Room Cleanup — `dropClient`

```go
// In the room-empties path (after h.mu.Unlock):
if remaining == 0 {
    delete(h.hostIds, client.roomCode)
    delete(h.playbackStates, client.roomCode)  // ← prevent memory leak
}
```

### Conflict Resolution

Two users press play within milliseconds. Both send `SyncEvent` into `h.events`. The hub goroutine processes them sequentially — first one in sees `IsPlaying = false`, processes the play, sets `IsPlaying = true`, broadcasts. Second one arrives, sees `IsPlaying = true` — silent drop. Clean, deterministic, no mutex contention.

---

## Client-Side Execution

### sync.js — init

```js
// ── Drift Guard Baseline ─────────────────────────────────────────
// Set on every applySync call. localTime === 0 means no applySync has
// fired yet — drift checks skip to avoid overflowing expected position
// on first load and hard-seeking to video.duration.
let lastApply = { position: 0, localTime: 0 }

// ── Pending Sync ─────────────────────────────────────────────────
// Stores a sync message received before video metadata has loaded.
// Re-applied on loadedmetadata. Without this, seekTo is silently
// ignored by the browser and the user starts at position 0.
//
// pendingSyncReceivedAt records performance.now() at storage time.
// On loadedmetadata, if the room was playing, position is fast-forwarded
// by the elapsed time — otherwise the late joiner lands seconds behind
// due to the file-pick delay.
let pendingSync = null
let pendingSyncReceivedAt = 0

// ── Player Action → Server ───────────────────────────────────────
// Intercepts every player:action event dispatched by player.js.
// Sends the command to the server — does NOT act on the video locally.
// The server echo (sync_command) drives the actual video change.
document.addEventListener('player:action', (e) => {
  const { action, position } = e.detail
  if (action === 'seek') {
    wsSend('sync_command', { action, position })
  } else {
    wsSend('sync_command', { action })
  }
})

// ── Server → Client ──────────────────────────────────────────────
onMessage('sync_command', (payload) => applySync(payload))
onMessage('sync_state',   (payload) => applySync(payload))

// ── Video Ended ──────────────────────────────────────────────────
// Notify server to pause when video reaches its natural end.
// If room was already paused (another client's ended fired first),
// server silently drops the duplicate — harmless.
video.addEventListener('ended', () => {
  if (roomState.playback.playing) {
    wsSend('sync_command', { action: 'pause' })
  }
})

// ── Deferred Apply ───────────────────────────────────────────────
// If a sync message arrived before video metadata loaded, re-apply now.
// Fast-forward position by elapsed time if the room was playing —
// the server computed position X at join time, but the user may have
// spent seconds picking a file before loadedmetadata fired.
video.addEventListener('loadedmetadata', () => {
  if (pendingSync) {
    if (pendingSync.isPlaying) {
      const elapsed = (performance.now() - pendingSyncReceivedAt) / 1000
      pendingSync = { ...pendingSync, position: pendingSync.position + elapsed }
    }
    applySync(pendingSync)
    pendingSync = null
    pendingSyncReceivedAt = 0
  }
})
```

### player.js — changes

**1. Remove local optimism from play/pause:**

```js
btnPlayPause.addEventListener('click', () => {
  if (!roomState.playback.playing) {
    dispatchPlayerAction('play')    // no video.play() here
  } else {
    dispatchPlayerAction('pause')   // no video.pause() here
  }
})
```

Note: uses `roomState.playback.playing` not `video.paused` — the video element may report paused during a seek rebuffer while the room is still playing. Reading room state gives the correct authoritative answer.

**2. Replace the `change` listener on `seekBar` with `pointerup`:**

```js
seekBar.addEventListener('pointerup', () => {
  dispatchPlayerAction('seek', video.currentTime)
  seekBar.blur()
})
```

`pointerup` fires exactly once on pointer release, cross-browser, with no ambiguity. `change` on range inputs fires inconsistently during drag on iOS Safari. `seekBar.blur()` prevents subsequent keyboard arrow key presses on the focused seekbar from moving the slider and triggering local `input` seeks without a corresponding sync command — see Keyboard Gap below.

**Known gap:** if a user tabs to the seekbar and uses keyboard arrow keys, the slider moves and local seek fires (`input`), but `pointerup` does not fire — no sync command is sent. This is distinct from document-level `ArrowLeft`/`ArrowRight` shortcuts which do sync via `player.nudge()` → `player:action`. Documented limitation for v1.

### applySync — Unconditional

```js
function applySync(msg) {
  // Guard: metadata not loaded — browser silently ignores seekTo.
  // Defer until loadedmetadata fires.
  if (video.readyState < 1) {
    pendingSync = msg
    pendingSyncReceivedAt = performance.now()
    return
  }

  // Clamp to duration. video.duration may be Infinity for streams;
  // NaN case guarded above by readyState < 1.
  const target = Math.min(msg.position, video.duration || Infinity)

  roomState.playback = {
    playing:  msg.isPlaying,
    position: target,
  }

  if (msg.isPlaying) {
    player.play(target)    // seekTo(target) + video.play()
  } else {
    player.pause(target)   // seekTo(target) + video.pause()
  }

  // Record baseline for drift guard — monotonic clock only.
  // performance.now() is immune to NTP corrections and clock adjustments.
  lastApply = { position: target, localTime: performance.now() }

  notifyUpdate()
}
```

**No double-seek:** `player.play(target)` and `player.pause(target)` call `seekTo` internally. `applySync` does not call `seekTo` separately. One seek per sync command.

**No latency compensation.** The server sent a position — execute it unconditionally. Compensation would require trusting the client's clock relationship to the server's clock, which is exactly what this architecture avoids.

---

## Drift Guard — Web Worker

### Why Keep It

The drift guard solves problems orthogonal to sync protocol correctness:
- Browsers throttle backgrounded tabs — `video.currentTime` drifts while the tab is hidden
- Natural playback rate variance (~0.01% over time) accumulates over a long session
- Seek rebuffering can stall playback silently

Without the drift guard, two users who received the same play command could diverge by seconds over a two-hour film without any new commands.

### worker.js

```js
// worker.js — separate file, cannot be concatenated with sync.js.
// new Worker(url) requires a separate script URL.
self.setInterval(() => self.postMessage({ type: 'tick' }), 5000)
self.addEventListener('message', (e) => {
  if (e.data.type === 'check') self.postMessage({ type: 'tick' })
})
```

### sync.js — drift guard

```js
// Factory wires onmessage and onerror on every instance — including restarts.
// Without the factory, onerror creates a new Worker but never re-attaches
// handlers, so drift correction silently stops after the first crash.
let workerRetries = 0
const MAX_WORKER_RETRIES = 3

function createDriftWorker() {
  const w = new Worker('/js/worker.js')
  w.onmessage = handleDriftTick
  w.onerror = () => {
    // Retry with backoff cap — prevents runaway allocation if worker.js
    // is missing or CSP-blocked.
    if (++workerRetries <= MAX_WORKER_RETRIES) {
      driftWorker = createDriftWorker()
    }
    // Beyond MAX_WORKER_RETRIES: drift guard disabled, sync still works.
  }
  return w
}

let driftWorker = createDriftWorker()

// Trigger an immediate drift check when a backgrounded tab returns to focus.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    driftWorker.postMessage({ type: 'check' })
  }
})

function handleDriftTick() {
  // No baseline yet — skip until first applySync fires.
  // Without this guard: on first load elapsed is enormous, expected overflows,
  // hard-seek clamps to video.duration → user lands at end of video.
  if (lastApply.localTime === 0) return

  // During seek rebuffer, video.paused === true while
  // roomState.playback.playing may still be true.
  // Use video.paused — not roomState — to avoid spurious correction.
  if (video.paused) return
  if (!roomState.playback.playing) return

  const elapsed  = (performance.now() - lastApply.localTime) / 1000
  const expected = lastApply.position + elapsed
  const drift    = Math.abs(expected - video.currentTime)

  if (drift > 2) {
    // Hard seek — reset rate first in case a previous tick left it at 1.05.
    // Without the reset, rate stays elevated indefinitely after a hard seek.
    video.playbackRate = 1.0
    player.seekTo(expected)
  } else if (drift > 0.5) {
    // Soft correction — nudge rate toward expected position.
    video.playbackRate = expected > video.currentTime ? 1.05 : 0.95
  } else {
    // In sync — restore normal rate.
    video.playbackRate = 1.0
  }
}
```

**Drift baseline is purely local:** `lastApply.position` is the server-computed position at the moment the client received and applied the command. `lastApply.localTime` is `performance.now()` at that moment. Expected position is computed from elapsed local time — no server clock involved, no offset needed.

---

## Seek Echo — Acknowledged Behaviour

When a user drags the seekbar, the `input` listener moves the video locally for visual feedback during the drag. On `pointerup`, the sync command is sent. When the server echo arrives, `applySync` seeks to approximately the same position the video is already at. This may cause a brief rebuffer on some browsers but not a visible position jump. Accepted v1 behaviour — suppressing the echo for the sender would require tracking pending commands, reintroducing complexity that contradicts the no-local-optimism model.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| User joins while playing | Server computes `lastRecordedPosition + time.Since(recordedAt).Seconds()`, sends `sync_state` with `isPlaying: true`; `applySync` seeks and plays |
| User joins while paused | Server sends `sync_state` with `isPlaying: false` and current `lastRecordedPosition`; `applySync` seeks and pauses |
| User joins mid-scrub | Server sends pre-scrub position. User waits for final seek command. Accepted for v1 |
| Tab backgrounds and returns | `visibilitychange` triggers immediate drift check; correction within one tick |
| User offline mid-session | Delayed delivery safe — broadcast carries ground truth position. Seek there unconditionally |
| Seek < 0 | Server rejects, drops message silently |
| Seek ≥ MaxPlaybackPositionSeconds | Server rejects, drops message silently |
| Seek beyond `video.duration` | Client clamps: `Math.min(target, video.duration \|\| Infinity)` |
| Play when already playing | Server silent drop — no broadcast, no state change |
| Pause when already paused | Server silent drop — no broadcast, no state change |
| Seek spam | `pointerup` fires once on release + server rate limiter (5/s per client) |
| Slow client blocking broadcast | `broadcastToRoom` uses non-blocking `select/default`; dead connections evicted after broadcast loop |
| Two users press play simultaneously | Hub goroutine processes `SyncEvent`s sequentially — first wins, second sees `IsPlaying = true` and drops silently |
| Server restart | In-memory state lost. Reconnecting clients get no `sync_state`; wait for next user command. Hard failure accepted for v1 |
| Late joiner beyond duration | Client clamps to `video.duration`; silently placed at end. Documented limitation |
| Seek rebuffer during drift check | `video.paused` gate prevents spurious correction while buffering |
| No baseline yet (first load) | `lastApply.localTime === 0` guard skips drift checks until first `applySync` fires |
| Seekbar keyboard navigation | Tab to seekbar + arrow keys: `seekBar.blur()` on `pointerup` removes focus after mouse seek; keyboard-only navigation still does not sync — documented gap for v1 |
| `video.duration` NaN before metadata | Guarded by `video.readyState < 1` — sync deferred until `loadedmetadata` |
| Perceived delay on initiating user | ~50–150ms between click and video response. Imperceptible. Cost of universal truth |
| Sync arrives before metadata loads | Stored in `pendingSync`, position fast-forwarded by elapsed time on `loadedmetadata` |
| Video reaches end | `ended` event triggers pause command to server; room state correctly reflects `isPlaying: false` |
| Multiple clients hit `ended` simultaneously | First pause processed, subsequent ones silently dropped (already paused) |
| Room emptied and re-created | `playbackStates` entry deleted on empty; fresh state created on first sync command in new session |
| NTP clock adjustment on server | `RecordedAt` is `time.Time` — `now.Sub(RecordedAt)` uses monotonic readings, immune to wall-clock jumps |
| NTP clock adjustment on client | Drift guard uses `performance.now()` (monotonic) — immune to wall-clock jumps |
| Drift worker crashes | `onerror` restarts via `createDriftWorker()` factory, up to `MAX_WORKER_RETRIES`. Beyond that: drift guard disabled gracefully, sync unaffected |
| Drift worker missing or CSP-blocked | Retry cap prevents runaway Worker allocation. Sync still works without drift guard |

---

## What Is Not Built in This Step

- Chat messages (Step 9)
- File fingerprint mismatch warning (Step 5)
- WebRTC signaling (Step 6)
- Persistent playback history
- Sequence numbers — debounce + rate limit sufficient for v1
- Clock sync — removed entirely; server computes all positions
- Local optimism — removed entirely; all clients wait for server echo

---

## Build Sequence

1. **Go:** Add `lastSyncWindow time.Time` and `syncCount int` to `Client` struct.
2. **Go:** Add `RoomPlaybackState` struct (`RecordedAt time.Time`) and `playbackStates map[string]RoomPlaybackState` to Hub. Add `SyncCommandPayload` typed struct.
3. **Go:** Add `MaxPlaybackPositionSeconds = 86400` to `config.go`.
4. **Go:** Add `SyncEvent{client, raw}` type with `execute()` calling `handleSyncCommand`. Add `sync_command` case to `readPump` switch sending `SyncEvent` into `h.events`.
5. **Go:** Implement `handleSyncCommand` on hub goroutine: zero-allocation action switch, monotonic rate limit, `time.Since` elapsed arithmetic, `SyncCommandPayload` broadcast.
6. **Go:** Add `sync_state` send in `handleRegister` — if room has playback state, compute elapsed with `time.Since` (no persist), send `SyncCommandPayload` to joining client. Hub-goroutine-only, no mutex.
7. **Go:** Add `delete(h.playbackStates, roomCode)` in `dropClient` room-empty path (outside mutex, after unlock).
8. **Go test:** Two tabs, same room — play/pause/seek stays locked; sender sees their own video respond only after echo.
9. **Client:** `player.js` — remove local `video.play()`/`video.pause()` from button handler; change to `roomState.playback.playing` check; change `seekBar 'change'` → `'pointerup'` with `seekBar.blur()`.
10. **Client:** `sync.js` — `player:action` listener sends `wsSend('sync_command', ...)`; `sync_command` and `sync_state` handlers call `applySync`; implement `applySync` with `readyState` guard and `pendingSync`/`pendingSyncReceivedAt` defer with elapsed fast-forward.
11. **Client:** `sync.js` — `ended` event handler sends pause command.
12. **Client:** `worker.js` — 5s tick + `check` message response.
13. **Client:** `sync.js` — `createDriftWorker()` factory with `onmessage`/`onerror` re-wiring and retry cap; `handleDriftTick` with `localTime === 0` guard, `video.paused` gate, `performance.now()` monotonic clock, rate-reset before hard seek, `playbackRate` nudge for 0.5–2s, hard seek + rate reset for >2s.
14. **Integration test:** Three tabs, same room:
    - play/pause/seek stays locked across all three
    - late joiner catches up correctly, position fast-forwarded by file-pick delay
    - backgrounded tab corrects on return
    - initiating user sees their own video respond only after server echo
    - arrow key nudges (`ArrowLeft`/`ArrowRight`) sync to all clients
    - seekbar keyboard navigation (tab + arrow) does not sync — local only
    - double-tap play while playing — silent drop, no effect
    - video ends — room pauses for all clients
    - join before metadata loads — sync applies after loadedmetadata with elapsed correction

Steps 1–10 are testable end-to-end before the Worker is written. The Worker is additive — sync works without it, degrading gracefully when tabs are backgrounded.

---

## Script Load Order

```html
<!-- HTML — order matters -->
<script src="/js/state.js"></script>
<script src="/js/ws.js"></script>
<script src="/js/player.js"></script>
<script src="/js/sync.js"></script>
<script src="/js/ui.js"></script>
```

`sync.js` registers handlers via `onMessage` (from `ws.js`) and listens to `player:action` events (from `player.js`). Both are available by the time `sync.js` executes. No cross-module handler conflicts — `sync_command` and `sync_state` are handled exclusively by `sync.js`.