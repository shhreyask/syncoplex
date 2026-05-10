# Step 4 — Sync Engine — High Level Design

## What This Step Is

`sync.js` — one new file, ~100 lines. It plugs into the existing architecture with minimal surface changes: one line in `player.js`, two handlers added to `ws.js`, and new message routing in `hub.go`'s `readPump`. No new dependencies, no build step changes.

The sync engine receives authoritative playback commands from the server, applies them unconditionally (seek to position, play or pause), updates `roomState.playback`, and lets `player.js` drive the video. It runs a Web Worker heartbeat to catch drift in backgrounded tabs.

**Principles applied:**
- **Fast** — no queues, no async chains. `sync.js` listens to existing `player:action` events.
- **Secure** — server is sole authority. Clients never trust each other. All playback state flows server → all clients.
- **Light** — ~100 lines, no new dependencies, no build step changes.
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

**Go server:** add `sync_command` handler in `readPump`'s switch — validate, compute position, update room state, call `broadcastToRoom` directly (includes sender). Add `sync_state` send on join if room has playback state. Clean up `playbackStates` when room empties. No clock sync. No changes to `handleBroadcast`. No new routes. No Redis schema changes.

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
3. Server validates, computes authoritative position, broadcasts to all clients including sender.
4. `applySync` fires on all clients — seek to position, execute action.

**Effect:** there is a ~50–150ms perceived delay between clicking and the video responding. This is the cost of universal truth. Every user's video is pulled to the exact same server-computed position on every command, guaranteeing sync never drifts cumulatively.

---

## Message Protocol

All messages use the existing `{ type, payload }` envelope from Step 1.

### Client → Server

```js
wsSend('sync_command', { action: 'play' })
wsSend('sync_command', { action: 'pause' })
wsSend('sync_command', { action: 'seek', position: 8043.7 })
```

`play` and `pause` carry no position — the server computes it. `seek` carries the target position chosen by the user.

### Server → All Clients (Authoritative Broadcast)

```json
{
  "type": "sync_command",
  "payload": {
    "action": "play",
    "position": 4521.3,
    "isPlaying": true
  }
}
```

```json
{
  "type": "sync_command",
  "payload": {
    "action": "pause",
    "position": 4589.1,
    "isPlaying": false
  }
}
```

```json
{
  "type": "sync_command",
  "payload": {
    "action": "seek",
    "position": 8043.7,
    "isPlaying": true
  }
}
```

`position` is the authoritative playback position computed by the server. `isPlaying` is the resulting state. Clients seek to `position` and then play or pause based on `isPlaying`. No interpretation, no compensation.

### Server → Late Joiner

```json
{
  "type": "sync_state",
  "payload": {
    "action": "seek",
    "position": 4589.1,
    "isPlaying": true
  }
}
```

If `isPlaying` is true, server computes `position = lastRecordedPosition + (now - recordedAt) / 1000` before sending. Client processes through standard `applySync()` — no special-casing.

---

## Server-Side State

### Room Playback State

```go
type RoomPlaybackState struct {
    LastRecordedPosition float64 // seconds — the canonical position at recordedAt
    RecordedAt           int64   // unix ms — when this position was recorded
    IsPlaying            bool    // true = playing, false = paused
}
```

One struct per room, stored in a `map[string]RoomPlaybackState` on the Hub.

**Initialization:** when a room's first member loads a file and the room has no playback state yet, the server defaults to:

```go
RoomPlaybackState{
    LastRecordedPosition: 0,
    RecordedAt:           time.Now().UnixMilli(),
    IsPlaying:            false,
}
```

This is written on the first `sync_command` received for a room that has no existing playback state.

**Cleanup:** when the last member leaves a room and the room is deleted from `h.rooms`, the corresponding entry is also deleted from `h.playbackStates`:

```go
delete(h.playbackStates, client.roomCode)
```

This prevents unbounded growth of the map on a long-running server with many transient rooms.

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

    // Validate action
    validActions := map[string]bool{"play": true, "pause": true, "seek": true}
    if !validActions[p.Action] { return }

    // Rate limit — max 5 sync commands/second per client
    now := time.Now().UnixMilli()
    if now-c.lastSyncWindow > 1000 {
        c.lastSyncWindow = now
        c.syncCount = 0
    }
    c.syncCount++
    if c.syncCount > 5 { return }

    h.mu.Lock()
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
        // Only process if currently paused — silent drop if already playing
        if state.IsPlaying {
            h.mu.Unlock()
            return
        }
        // Position stays the same — pause already recorded it
        broadcastPosition = state.LastRecordedPosition
        state.RecordedAt = now
        state.IsPlaying = true
        broadcastIsPlaying = true

    case "pause":
        // Only process if currently playing — silent drop if already paused
        if !state.IsPlaying {
            h.mu.Unlock()
            return
        }
        // Compute current position lazily
        elapsed := float64(now-state.RecordedAt) / 1000.0
        state.LastRecordedPosition = state.LastRecordedPosition + elapsed
        state.RecordedAt = now
        state.IsPlaying = false
        broadcastPosition = state.LastRecordedPosition
        broadcastIsPlaying = false

    case "seek":
        // Validate seek position
        if p.Position < 0 || p.Position >= 86400 {
            h.mu.Unlock()
            return
        }
        state.LastRecordedPosition = p.Position
        state.RecordedAt = now
        // isPlaying remains unchanged
        broadcastPosition = p.Position
        broadcastIsPlaying = state.IsPlaying
    }

    h.playbackStates[c.roomCode] = state
    h.mu.Unlock()

    // Broadcast to all clients including sender
    h.broadcastToRoom(c.roomCode, makeEnvelope("sync_command", map[string]interface{}{
        "action":    p.Action,
        "position":  broadcastPosition,
        "isPlaying": broadcastIsPlaying,
    }))
}
```

Rate limit fields (`lastSyncWindow int64`, `syncCount int`) are added to the `Client` struct. They are read and written only in `readPump` — which runs in the client's own goroutine — so no mutex is needed for them.

### Late Joiner — `handleRegister`

```go
// Inside handleRegister, after sending room_state
h.mu.RLock()
state, exists := h.playbackStates[client.roomCode]
h.mu.RUnlock()

if exists {
    now := time.Now().UnixMilli()
    position := state.LastRecordedPosition
    if state.IsPlaying {
        elapsed := float64(now-state.RecordedAt) / 1000.0
        position = position + elapsed
    }

    // Compute position locally for this send — do NOT persist the rebase.
    // The original state remains unchanged so future calculations
    // (lastRecordedPosition + elapsed) are always correct.
    client.send <- makeEnvelope("sync_state", map[string]interface{}{
        "action":    "seek",
        "position":  position,
        "isPlaying": state.IsPlaying,
    })
}
```

**No state mutation:** the computed `position` is used only for the `sync_state` message to this joining client. The persisted `RoomPlaybackState` is not modified. Any future calculation of `lastRecordedPosition + (now - recordedAt) / 1000` produces the correct current position regardless of how many clients join.

**Mutex discipline:** `handleRegister` runs inside the Hub's select loop (hub goroutine). `handleSyncCommand` runs from `readPump` (per-client goroutine). Both access `playbackStates`. `handleRegister` acquires `h.mu.RLock()` for the read. `handleSyncCommand` acquires `h.mu.Lock()` for the read-modify-write. This eliminates the data race.

### Room Cleanup — `dropClient`

```go
// Inside dropClient, in the "room empties" path:
if remaining == 0 {
    delete(h.rooms, client.roomCode)
    delete(h.hostIds, client.roomCode)
    delete(h.playbackStates, client.roomCode)  // ← prevent memory leak
}
```

### Concurrency note

The Hub's `sync.RWMutex` (already used for `roomMemberCount`) is extended to cover `playbackStates` reads and writes:
- `handleSyncCommand` (called from per-client `readPump` goroutine): acquires `h.mu.Lock()` for the state read-modify-write.
- `handleRegister` (runs on hub goroutine): acquires `h.mu.RLock()` for the state read.
- `dropClient` (runs on hub goroutine): acquires `h.mu.Lock()` when deleting entries (already holds it for room map deletion).

---

## Client-Side Execution

### sync.js — init

```js
// sync.js

let lastApply = { position: 0, localTime: 0 }
let pendingSync = null  // stores sync message received before video metadata loads

// Intercept player actions and route through server — no local action
document.addEventListener('player:action', (e) => {
  const { action, position } = e.detail
  if (action === 'seek') {
    wsSend('sync_command', { action, position })
  } else {
    wsSend('sync_command', { action })
  }
})

// Apply authoritative commands from server (including sender's own echo)
onMessage('sync_command', (payload) => applySync(payload))
onMessage('sync_state',   (payload) => applySync(payload))

// Handle video ending — notify server to pause
video.addEventListener('ended', () => {
  if (roomState.playback.playing) {
    wsSend('sync_command', { action: 'pause' })
  }
})

// Re-apply sync if it arrived before video metadata was ready
video.addEventListener('loadedmetadata', () => {
  if (pendingSync) {
    applySync(pendingSync)
    pendingSync = null
  }
})
```

`sync.js` does not wire the control bar. It intercepts `player:action` events that `player.js` already dispatches. `player.nudge()` (arrow key shortcuts) dispatches `player:action` with action `'seek'` — arrow key nudges sync to all clients automatically.

### player.js — changes

**1. Remove local optimism from play/pause:**

```js
// player.js
btnPlayPause.addEventListener('click', () => {
  if (video.paused) {
    dispatchPlayerAction('play')         // no video.play() here
  } else {
    dispatchPlayerAction('pause')        // no video.pause() here
  }
})
```

**2. Replace the `change` listener on `seekBar` with `pointerup`:**

```js
// player.js — replace seekBar 'change' listener
seekBar.addEventListener('pointerup', () => {
  dispatchPlayerAction('seek', video.currentTime)
})
```

`pointerup` fires exactly once on pointer release, cross-browser, with no ambiguity. `change` on range inputs fires inconsistently during drag on iOS Safari. The `input` listener (local seek feedback) is unchanged.

**Known gap:** if a user tabs to the seekbar and uses keyboard arrow keys, the slider moves and local seek fires (`input`), but `pointerup` does not fire — no sync command is sent. This is distinct from the arrow key shortcuts (`ArrowLeft`/`ArrowRight` on the document) which do sync via `player.nudge()` → `player:action`. Documented limitation for v1.

### applySync — Unconditional

```js
function applySync(msg) {
  // Guard: if video metadata hasn't loaded yet, defer until loadedmetadata
  if (video.readyState < 1) {
    pendingSync = msg
    return
  }

  const target = Math.min(msg.position, video.duration || Infinity)
  // Note: video.duration may be NaN before metadata loads; guarded above.

  roomState.playback = {
    playing:  msg.isPlaying,
    position: target,
  }

  if (msg.isPlaying) {
    player.play(target)     // seekTo(target) + video.play() — defined in player.js API
  } else {
    player.pause(target)    // seekTo(target) + video.pause() — defined in player.js API
  }

  // Record baseline for drift guard (monotonic clock)
  lastApply = { position: target, localTime: performance.now() }

  notifyUpdate()
}
```

**No double-seek:** `player.play(target)` and `player.pause(target)` each call `seekTo` internally as defined in the file-picker HLD's public API. `applySync` does not call `seekTo` separately. One seek per sync command.

**No latency compensation.** The server sent a position and a command — execute it unconditionally.

**Deferred apply:** if `video.readyState < 1` (no metadata yet — common for late joiners on slow connections), the message is stored in `pendingSync` and re-applied when `loadedmetadata` fires. Without this guard, `seekTo` would be silently ignored by the browser and the user would start at position 0.

### Video `ended` Event

When the video reaches its end and fires `ended`, the client sends a `pause` command to the server. The server processes it normally: computes position (which will be at or near duration), sets `isPlaying = false`, broadcasts to all. This ensures:
- Room state correctly reflects `isPlaying: false` after the movie ends
- Late joiners don't get a position computed past the end of the video
- All clients land at the same final position

If the room was already paused (e.g., another client's `ended` event already triggered a pause), the server silently drops the duplicate — harmless.

---

## Drift Guard — Web Worker

### Why Keep It

The drift guard solves problems orthogonal to sync protocol design:
- Browsers throttle backgrounded tabs — `video.currentTime` drifts while the tab is hidden
- Natural playback rate variance (~0.01% over time) accumulates
- Seek rebuffering can stall playback silently

Without the drift guard, two users who received the same play command could diverge by seconds over a long viewing session without any new commands.

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
let driftWorker = new Worker('/js/worker.js')

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
  if (lastApply.localTime === 0) return   // no baseline yet — skip until first applySync
  if (video.paused) return                // rebuffering or genuinely paused — skip
  if (!roomState.playback.playing) return // room is paused — skip

  const elapsed  = (performance.now() - lastApply.localTime) / 1000
  const expected = lastApply.position + elapsed
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

**`lastApply.localTime === 0` guard:** without this, on first load `elapsed` is enormous, `expected` overflows, and the hard-seek path clamps to `video.duration` — landing the user at the end of the video. This guard is load-bearing.

**`video.playbackRate = 1.0` before hard seek:** if a previous tick set rate to 1.05 and drift then grows past 2s, the hard seek fires but rate stays at 1.05 indefinitely. Reset rate explicitly before seeking.

**Why `video.paused` not just `roomState.playback.playing`:** during seek rebuffer, the video element reports `paused = true` while `roomState.playback.playing` may still be `true`. Using `video.paused` prevents spurious drift correction against a buffering video.

**Monotonic clock (`performance.now()`):** `Date.now()` is wall-clock time and can jump backward or forward on NTP corrections, daylight saving transitions, or manual user adjustments. This would produce wildly wrong `elapsed` values and trigger spurious hard seeks. `performance.now()` is monotonic, immune to clock adjustments, and appropriate here since both the baseline and the check are local to the page session.

**Drift baseline is purely local:** `lastApply.position` is the server-computed position at the moment the client received and applied the command. `lastApply.localTime` is `performance.now()` at that moment. Expected position is computed from elapsed local time — no server clock involved, no offset needed.

---

## Conflict Resolution

Two users press play within milliseconds. The Hub acquires the write mutex for each `handleSyncCommand` call. First to acquire the lock sees `isPlaying = false`, processes the play, sets `isPlaying = true`, broadcasts. The second acquires the lock, sees `isPlaying = true` — silent drop. Clean, deterministic.

Play vs. pause conflict: first to the server wins, its state is broadcast. The losing client sees the room respond to the winner's action. Correct and expected behaviour.

---

## Seek Echo — Acknowledged Behaviour

When a user drags the seekbar, the `input` listener moves the video locally for visual feedback during the drag. On `pointerup`, the sync command is sent. When the server echo arrives, `applySync` seeks to approximately the same position the video is already at. This may cause a brief rebuffer on some browsers but not a visible position jump. Accepted v1 behaviour — suppressing the echo for the sender would require tracking "pending" commands, reintroducing complexity that contradicts the no-local-optimism model.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| User joins while playing | Server computes `lastRecordedPosition + elapsed`, sends `sync_state` with `isPlaying: true`; `applySync` seeks and plays |
| User joins while paused | Server sends `sync_state` with `isPlaying: false` and current `lastRecordedPosition`; `applySync` seeks and pauses |
| User joins mid-scrub | Server sends pre-scrub position. User waits for final seek command. Accepted for v1 |
| Tab backgrounds and returns | `visibilitychange` triggers immediate drift check; correction within one tick |
| User offline mid-session | Delayed delivery safe — broadcast carries ground truth position. Seek there unconditionally |
| Seek < 0 | Server rejects, drops message silently |
| Seek ≥ 86400 | Server rejects, drops message silently |
| Seek beyond `video.duration` | Client clamps: `Math.min(target, video.duration \|\| Infinity)` |
| Play when already playing | Server silent drop — no broadcast, no state change |
| Pause when already paused | Server silent drop — no broadcast, no state change |
| Seek spam | `pointerup` debounce (fires once on release) + server rate limiter (5/s) |
| Slow client blocking broadcast | `broadcastToRoom` uses non-blocking `select/default`; dead connections evicted after broadcast loop |
| Server restart | In-memory state lost. Reconnecting clients get no `sync_state`; wait for next user command. Hard failure accepted for v1 |
| Late joiner beyond duration | Client clamps to `video.duration`; silently placed at end. Documented limitation |
| Seek rebuffer during drift check | `video.paused` gate prevents spurious correction while buffering |
| No baseline yet (first load) | `lastApply.localTime === 0` guard skips drift checks until first `applySync` fires |
| Seekbar keyboard navigation | Tab to seekbar + arrow keys moves slider locally (`input` fires) but no `pointerup` → no sync command. Documented gap for v1. Distinct from document-level arrow key shortcuts which sync via `player.nudge()` |
| `video.duration` NaN before metadata | Guarded by `video.readyState < 1` check — sync deferred until `loadedmetadata` |
| Perceived delay on initiating user | ~50–150ms between click and video response. Imperceptible. Cost of universal truth |
| Sync arrives before metadata loads | Stored in `pendingSync`, re-applied on `loadedmetadata`. User starts at correct position |
| Video reaches end | `ended` event triggers pause command to server; room state correctly reflects `isPlaying: false` |
| Multiple clients hit `ended` simultaneously | First pause processed, subsequent ones silently dropped (already paused) |
| Room emptied and re-created | `playbackStates` entry deleted on empty; fresh state created on first sync command in new session |
| NTP clock adjustment during playback | Drift guard uses `performance.now()` (monotonic) — immune to wall-clock jumps |

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

1. **Go:** Add `lastSyncWindow int64` and `syncCount int` to `Client` struct.
2. **Go:** Add `RoomPlaybackState` struct and `playbackStates map[string]RoomPlaybackState` to Hub.
3. **Go:** Add `sync_command` case to `readPump` switch — call `handleSyncCommand`. Implement `handleSyncCommand`: validate, rate-limit, compute position, update playback state, `broadcastToRoom`.
4. **Go:** Add `sync_state` send in `handleRegister` — if room has playback state, compute elapsed position if `isPlaying` (read-only, no persist), send `sync_state` to joining client. Acquire `h.mu.RLock()` for the read.
5. **Go:** Add `delete(h.playbackStates, roomCode)` in `dropClient` room-empty path.
6. **Go test:** Two tabs, same room — play/pause/seek stays locked; sender sees their own video respond only after echo.
7. **Client:** `player.js` — remove local `video.play()`/`video.pause()` from button handler; change `seekBar 'change'` → `'pointerup'` for `dispatchPlayerAction`.
8. **Client:** `sync.js` — `player:action` listener sends `wsSend('sync_command', ...)`; `sync_command` and `sync_state` handlers call `applySync`; implement `applySync` with `readyState` guard and `pendingSync` defer.
9. **Client:** `sync.js` — `ended` event handler sends pause command.
10. **Client:** `worker.js` — 5s tick + `check` message response.
11. **Client:** `sync.js` — drift guard with `lastApply.localTime === 0` guard, `video.paused` gate, `performance.now()` monotonic clock, rate-reset before hard seek, `playbackRate` nudge for 0.5–2s, hard seek + rate reset for >2s.
12. **Integration test:** Three tabs, same room:
    - play/pause/seek stays locked across all three
    - late joiner catches up correctly
    - backgrounded tab corrects on return
    - initiating user sees their own video respond only after server echo
    - arrow key nudges (`ArrowLeft`/`ArrowRight`) sync to all clients
    - seekbar keyboard navigation (tab + arrow) does not sync — local only
    - double-tap play while playing — silent drop, no effect
    - video ends — room pauses for all clients
    - join before metadata loads — sync applies after loadedmetadata

Steps 1–8 are testable end-to-end before the Worker is written. The Worker is additive — sync works without it, degrading gracefully when tabs are backgrounded.

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