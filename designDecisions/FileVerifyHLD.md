# Step 5 — File Verification — High Level Design

---

## What This Step Is

One new JS file (`fileVerify.js`, a main-thread coordinator), one new Web Worker file (`workerFileVerify.js`), additions to `state.js`, `ws.js`, and `player.js`, a small expansion to `hub.go`, and CSS additions to `style.css`. No new HTTP routes. No Redis schema changes. Two new WebSocket message types.

The file-verify step answers one question: **does every user in the room have the same file?** It does this by computing a lightweight hash in the browser, sending only the hex string to the server, and letting the server own all comparison logic. The client receives a single verdict — `valid` or `mismatch` — and acts on it.

Blocking happens in two places. On the client: the transition to the watch view is deferred until the verdict is `valid`. On the server: `sync_command` messages from unvalidated clients are silently dropped — they cannot affect shared playback state regardless of what the client sends. Only the user with the wrong file is blocked. Everyone already watching is completely unaffected.

**Principles applied:**

- **Secure** — the file never leaves the user's machine. Only a hex string crosses the wire. The canonical hash is server-owned; no client can manipulate another client's verdict. Server-side enforcement means a client cannot strongarm past the lobby by ignoring the UI gate.
- **Fast** — 3 MB read, ~200ms on a mid-range device, runs entirely in a Web Worker. Resolves before the host presses play.
- **Smooth** — blocking is in the lobby, not mid-playback. The user is given an immediate re-pick path. The canonical hash shifts automatically when needed. Reconnecting users are re-validated transparently with no manual action.
- **Light** — the client does zero comparison logic. The server stores one string per room. No external libraries. Web APIs only (`Blob.slice`, `arrayBuffer`, `SubtleCrypto`).

---

## What Changes

```
frontend/public/js/
├── state.js                Add fileVerdict, fileHash, fileVerdictError to roomState;
│                           add FILE_VERDICTS constants
├── ws.js                   Cancel pending timeout on disconnect; reset fileVerdict on
│                           disconnect; re-send pending hash on onopen
├── player.js               Dispatch 'player:fileloaded' inside loadFile()
├── sync.js                 No changes
├── fileVerify.js           NEW — main-thread coordinator: spawns Worker, stores hash,
│                           sends to server, receives verdict, drives state, two timeouts,
│                           exposes cancelFingerprintTimeout for ws.js
├── workerFileVerify.js     NEW — Web Worker: reads chunks, hashes, returns hex
└── ui.js                   Wire FILE_VERDICTS into lobby render: spinner / ✓ / ✗;
                            gate showView('watch') on fileVerify:verdict instead of
                            player:ready

frontend/public/
├── index.html              Add fileVerify-spinner and fileVerify-error elements;
│                           add <script src="/js/fileVerify.js">
└── style.css               Add .fileVerify-pending, .spinner, @keyframes spin

server/
└── hub.go                  Add fileVerifyValid bool to Client struct
                            Add RoomFileVerifyState, FileVerifyEvent,
                            handleFileVerifyCommand
                            Gate handleSyncCommand on fileVerifyValid
                            Send sync_state after valid verdict in handleFileVerifyCommand
                            Remove sync_state send from handleRegister
                            ValidatedUsers cleanup in dropClient (departure path)
                            Delete fileVerifyStates entry in room-empty path
```

No new HTTP routes. No Redis schema changes. No changes to `rooms.go`, `session.go`, `middleware.go`, or `config.go`.

The script loading order in `index.html`:

```html
<!-- JS — order matters: state → ws → player → sync → fileVerify → ui -->
<!-- workerFileVerify.js is NOT listed here — loaded only via new Worker() -->
<script src="/js/state.js"></script>
<script src="/js/ws.js"></script>
<script src="/js/player.js"></script>
<script src="/js/sync.js"></script>
<script src="/js/fileVerify.js"></script>
<script src="/js/ui.js"></script>
```

`fileVerify.js` (the main-thread coordinator) sits after `sync.js` and before `ui.js`. The Worker file — `workerFileVerify.js` — is a separate script URL and is never included in the script list. `new Worker(url)` requires a separate script file.

---

## Module Ownership

```
fileVerify.js (main-thread coordinator) owns:
  - spawning and terminating the fileVerify Web Worker
  - storing the computed hex on roomState.fileHash
  - sending file_fileVerify over WebSocket (only when wsStatus === 'connected')
  - receiving fileVerify_verdict and writing roomState.fileVerdict
  - dispatching 'fileVerify:verdict' for ui.js to react to
  - two sequential 15-second timeouts: one covering Worker stall, one covering server round-trip
  - re-triggering on file re-pick
  - exposing cancelFingerprintTimeout() for ws.js to call on disconnect

fileVerify.js does NOT own:
  - rendering the verdict UI — that is ui.js
  - triggering showView('watch') — that is ui.js
  - the video element or blob URL — that is player.js
  - WebSocket connection management — that is ws.js
  - re-sending the hash on reconnect — that is ws.js (onopen handler)

workerFileVerify.js (Web Worker) owns:
  - reading the three file chunks via Blob.slice().arrayBuffer()
  - computing SHA-256 via SubtleCrypto
  - returning the hex string to the main thread
  - nothing else — it is terminated immediately after posting the result
```

---

## The Sampling Strategy

A full SHA-256 of a 10 GB file is a non-starter. Instead a deterministic partial fingerprint is constructed from four inputs:

```
fingerprint = SHA-256(
    fileSize_as_8_byte_LE          // 8 bytes   — rejects wrong files at zero CPU cost
  + 1 MB at byte offset 0          // container header and first keyframe region
  + 1 MB at byte offset floor(size / 2)   // mid-file divergence catch
  + 1 MB at byte offset (size - 1MB)      // tail — catches muxed subtitles, truncation
)
```

**Total data read: ~3 MB. Total data hashed: ~3 MB + 8 bytes.**

**Why these three chunks:**

- The header contains container metadata and the first video keyframe. Different encodes almost always diverge here.
- The middle chunk is far enough into the file to catch re-encodes or edits that share the same header.
- The tail catches files that were truncated or had content appended (subtitles muxed in, alternate endings).
- File size alone rejects completely wrong files (wrong movie entirely) at zero CPU cost — before any disk read.

**Why SHA-256 and not a faster non-cryptographic hash:**
`SubtleCrypto.digest('SHA-256', ...)` is browser-native, requires zero dependencies, and completes in a few milliseconds on 3 MB of input. A non-cryptographic hash like xxHash would be marginally faster but requires a JS implementation — extra code for imperceptible gain. SHA-256 wins on the **light** principle.

**Fingerprint collision acknowledgement:**
The partial fingerprint is a strong signal, not a cryptographic proof of file identity. Two files differing only in metadata tags or muxed tracks may produce identical fingerprints if the sampled byte regions happen to be identical. For the purpose of a casual watch party, false positives (two different files passing) are benign — users will notice drift within seconds of playback starting. False negatives (same file failing) are not possible given deterministic inputs on identical byte content.

---

## Where the Work Runs

```
Main thread (fileVerify.js)           Web Worker (workerFileVerify.js)
───────────────────────────           ────────────────────────────────
User picks file in lobby
setFileState('hashing')
fileVerdict = 'pending'
  │
  ├─ new Worker('/js/workerFileVerify.js')
  ├─ 15s Worker-stall timeout started
  ├─ worker.postMessage({ file }) ──►  Build 8-byte fileSize LE buffer
  │                                    file.slice(0, 1MB).arrayBuffer()
  │                                    file.slice(mid, mid+1MB).arrayBuffer()
  │                                    file.slice(end-1MB, end).arrayBuffer()
  │                                    Concatenate into one Uint8Array
  │                                    SubtleCrypto.digest('SHA-256', combined)
  │◄─ worker.postMessage({ hex }) ──── Return hex string
  │
  Worker-stall timeout cleared
  worker terminated
  roomState.fileHash = hex             ← stored for reconnect re-send
  15s server-verdict timeout started   ← second timeout for round-trip leg
  if wsStatus === 'connected':
    wsSend('file_fileVerify', { fileVerify: hex })
  // verdict arrives via fileVerify_verdict message
```

**Two sequential timeouts** cover the two failure legs independently:
- **Worker-stall timeout (15s):** started when `computeAndSendFingerprint` is called. Cleared when the Worker posts its result. If it fires, the Worker is terminated and `fileVerdictError` is set.
- **Server-verdict timeout (15s):** started after the Worker posts its result (i.e., after the hash is sent). Cleared when `fileVerify_verdict` arrives. If it fires, `fileVerdictError` is set.

The Worker is terminated after posting the result — it has no ongoing memory or CPU cost.

**Why a Worker at all for an already-async operation:**
`Blob.slice().arrayBuffer()` and `SubtleCrypto.digest` are both async and technically non-blocking on the main thread. However running in a Worker provides a clean boundary: the main thread remains free for WebSocket messages and lobby UI events throughout hashing, and the fileVerify logic is independently testable in isolation. The cost is one additional script file. The gain is correct architecture.

---

## Server-Side Canonical Hash Model

The server holds exactly **one value** per room: `canonicalHash`. This is the single source of truth for the room's expected file.

### `fileVerifyValid` on `Client`

```go
type Client struct {
    // ... existing fields ...
    fileVerifyValid bool   // true only after server sends a valid verdict for this client
}
```

This field lives on `Client`. It is read and written exclusively on the hub goroutine — no mutex needed.

- **Starts as `false`** on every connect and reconnect — a reconnecting user arrives unvalidated regardless of their previous session.
- **Set to `true`** inside `handleFileVerifyCommand`, immediately before sending the `fileVerify_verdict: valid` reply.
- **Never reset to `false`** after being set — a validated user remains validated for the lifetime of their connection.

### Room file-verify state

```go
// Inside hub.go — stored in h.fileVerifyStates map[string]RoomFileVerifyState
// Hub-goroutine-only — no mutex needed.
type RoomFileVerifyState struct {
    CanonicalHash   string
    CanonicalUserId string
    ValidatedUsers  map[string]bool  // userId → true for all users who have passed
}
```

One struct per room. **`ValidatedUsers` is a canonical management structure only.** It is never checked during playback, never sent to clients, and never persisted. Its sole purpose is enabling the canonical shift logic on re-pick and departure. It is not a playback gate — that role belongs to `client.fileVerifyValid`.

### The three rules

**Rule 1 — First fingerprint in becomes canonical.**
The first `file_fileVerify` message received for a room with no existing canonical sets `CanonicalHash` to that user's hash. That user is immediately added to `ValidatedUsers`, `fileVerifyValid` is set to `true`, and they receive `{ verdict: "valid" }`. No comparison is performed.

**Rule 2 — Every subsequent fingerprint is compared to canonical.**
The server compares the incoming hex string against `CanonicalHash`. If they match, the user is added to `ValidatedUsers`, `fileVerifyValid` is set to `true`, and they receive `{ verdict: "valid" }`. If they do not match, they receive `{ verdict: "mismatch" }` and `fileVerifyValid` stays `false`. No broadcast to anyone else. The verdict is a targeted reply.

**Rule 3 — Canonical shifts when its owner re-picks.**
If the user identified by `CanonicalUserId` sends a new `file_fileVerify`:
- If `ValidatedUsers` contains any other user: those users all hold the canonical hash by definition (they matched it). Promote any one of them as the new canonical anchor. Update `CanonicalUserId`. Remove the re-picking user from `ValidatedUsers`. Set their `fileVerifyValid` back to `false`. Compare their new hash against the promoted canonical — reply accordingly.
- If the re-picking user is the only user who has fingerprinted so far: replace `CanonicalHash` with the new hash. They remain canonical. Reply `{ verdict: "valid" }`.

### Message flow

```
CLIENT                                          SERVER (hub goroutine)
──────                                          ──────────────────────
Worker computes hex
fileVerdict = 'pending'
  │
  ├─ { type: "file_fileVerify",    ──────────►  if fileVerifyStates[roomCode] empty:
  │    payload: { fileVerify: hex } }                state.CanonicalHash = hex
  │                                                  state.CanonicalUserId = userId
  │                                                  state.ValidatedUsers[userId] = true
  │                                                  client.fileVerifyValid = true
  │◄─ { type: "fileVerify_verdict",                 reply → { verdict: "valid" }
  │    payload: { verdict: "valid" } }               + send sync_state to this client
  │
  │                                             else if hex === CanonicalHash:
  │◄─ { type: "fileVerify_verdict",                 state.ValidatedUsers[userId] = true
  │    payload: { verdict: "valid" } }               client.fileVerifyValid = true
  │                                                  reply → { verdict: "valid" }
  │                                                  + send sync_state to this client
  │
  │                                             else:
  │◄─ { type: "fileVerify_verdict",                 reply → { verdict: "mismatch" }
       payload: { verdict: "mismatch" } }            (fileVerifyValid stays false)
```

The server sends the verdict **only to the requesting client**. Nobody else in the room receives anything. This is one string comparison and one targeted channel write — the lightest possible server behaviour.

**`sync_state` on valid verdict:** when a client receives a valid verdict, `handleFileVerifyCommand` immediately sends a `sync_state` snapshot to that client. This replaces the send that previously lived in `handleRegister` — ensuring the client gets the current playback position only after it has been validated, not before.

### Server-side enforcement — gating `sync_command`

```go
func (h *Hub) handleSyncCommand(c *Client, raw json.RawMessage) {
    // Server-side enforcement — a client who has not passed fileVerify
    // validation cannot affect room playback state regardless of what they send.
    // This gate is independent of the client-side UI gate in the lobby.
    if !c.fileVerifyValid {
        return
    }
    // ... existing logic unchanged ...
}
```

One guard at the top of `handleSyncCommand`. A client who never sent `file_fileVerify`, sent a mismatched hash, or is mid-reconnect re-validation cannot affect room playback state regardless of what they send. The server never broadcasts their commands. Other users are completely unaffected.

**What is not gated:** `relay` messages (WebRTC signaling must work for camera setup regardless of validation state) and `join`. Only `sync_command` is blocked — the one message type that affects shared playback state.

This means the block is not merely a client-side UI gate. A client bypassing the lobby UI entirely — sending `sync_command` without ever sending `file_fileVerify` — is silently ignored at the server. The UI gate and the server gate are independent layers.

### `handleFileVerifyCommand`

Runs on the hub goroutine. No mutex needed for `h.fileVerifyStates` or `h.rooms`.

```go
func (h *Hub) handleFileVerifyCommand(c *Client, hex string) {
    state := h.fileVerifyStates[c.roomCode] // zero value if not present

    var verdict string

    if state.CanonicalHash == "" {
        // Rule 1 — First fileVerify in becomes canonical.
        state.CanonicalHash   = hex
        state.CanonicalUserId = c.userId
        if state.ValidatedUsers == nil {
            state.ValidatedUsers = make(map[string]bool)
        }
        state.ValidatedUsers[c.userId] = true
        c.fileVerifyValid = true
        verdict = "valid"

    } else if c.userId == state.CanonicalUserId {
        // Rule 3 — Canonical user is re-picking their file.
        delete(state.ValidatedUsers, c.userId)
        c.fileVerifyValid = false

        // Find a replacement canonical anchor from other validated users.
        promoted := false
        for uid := range state.ValidatedUsers {
            state.CanonicalUserId = uid
            // CanonicalHash stays the same — all validated users matched it.
            promoted = true
            break
        }

        if !promoted {
            // No other validated users — this user is alone; update canonical.
            state.CanonicalHash   = hex
            state.CanonicalUserId = c.userId
            state.ValidatedUsers[c.userId] = true
            c.fileVerifyValid = true
            verdict = "valid"
        } else {
            if hex == state.CanonicalHash {
                state.ValidatedUsers[c.userId] = true
                c.fileVerifyValid = true
                verdict = "valid"
            } else {
                verdict = "mismatch"
            }
        }

    } else {
        // Rule 2 — Normal case: compare against canonical.
        if hex == state.CanonicalHash {
            state.ValidatedUsers[c.userId] = true
            c.fileVerifyValid = true
            verdict = "valid"
        } else {
            verdict = "mismatch"
        }
    }

    h.fileVerifyStates[c.roomCode] = state

    c.send <- makeEnvelope("fileVerify_verdict", map[string]string{
        "verdict": verdict,
    })

    // Send playback state snapshot to newly validated client.
    // This replaces the sync_state send that previously lived in handleRegister —
    // the client now receives the snapshot only after being validated.
    if verdict == "valid" {
        if ps, exists := h.playbackStates[c.roomCode]; exists {
            position := ps.LastRecordedPosition
            if ps.IsPlaying {
                position += time.Since(ps.RecordedAt).Seconds()
            }
            c.send <- makeEnvelope("sync_state", SyncCommandPayload{
                Action:    "seek",
                Position:  position,
                IsPlaying: ps.IsPlaying,
            })
        }
    }
}
```

### `ValidatedUsers` cleanup on user departure

When a user disconnects, `dropClient` must update the file-verify state. This is asymmetric with the re-pick case: the departing user is gone, so no verdict is sent — the canonical simply shifts and that is it.

```go
// In dropClient — runs on hub goroutine, before the room-empty check:
if fpState, ok := h.fileVerifyStates[client.roomCode]; ok {
    delete(fpState.ValidatedUsers, client.userId)

    if client.userId == fpState.CanonicalUserId {
        // Canonical user left — promote any remaining validated user.
        promoted := false
        for uid := range fpState.ValidatedUsers {
            fpState.CanonicalUserId = uid
            // CanonicalHash unchanged — all validated users matched it.
            promoted = true
            break
        }
        if !promoted {
            // No remaining validated users — reset entirely.
            // Next file_fileVerify sets a fresh canonical.
            fpState.CanonicalHash   = ""
            fpState.CanonicalUserId = ""
        }
    }
    h.fileVerifyStates[client.roomCode] = fpState
}
// Room-empty cleanup follows — deletes the whole entry if room is now empty.
```

No verdict is sent. `fileVerifyValid` on the departing client is irrelevant — the `Client` struct is about to be discarded. The room continues with a promoted canonical or a reset state, ready for the next `file_fileVerify` message.

### Cleanup on room empty

```go
// In the room-empties path (outside mutex, after unlock) — add alongside existing deletes:
if remaining == 0 {
    delete(h.hostIds, client.roomCode)
    delete(h.playbackStates, client.roomCode)
    delete(h.fileVerifyStates, client.roomCode)   // ← new
}
```

---

## State — Client Side

Additions to `state.js`:

```js
// state.js — additions only

const FILE_VERDICTS = {
    PENDING:  'pending',   // hash computing, in-flight to server, or awaiting re-pick
    VALID:    'valid',     // server confirmed match
    MISMATCH: 'mismatch',  // server rejected — wrong file
}

// Inside roomState — new fields:
const roomState = {
  // ... existing fields ...

  fileVerdict:      FILE_VERDICTS.PENDING,  // 'pending' | 'valid' | 'mismatch'
  fileHash:         null,                   // hex string, stored for reconnect re-send
  fileVerdictError: null,                   // string | null — shown when timeout or Worker crash
}
```

`fileVerdict` is separate from `fileState`. `fileState` tracks the video element's readiness (`hashing` → `ready` → `playing`). `fileVerdict` tracks the server's verdict on the hash. They are independent: a user can be `fileState: 'ready'` (video loaded) while `fileVerdict: 'mismatch'` (server rejected). The transition to watch view is gated on both.

`fileHash` persists across disconnects — it is the mechanism that enables transparent re-validation on reconnect without requiring the user to re-pick their file.

---

## Race: File Picked Before WebSocket Is Connected

If a user drops a file onto the lobby before the WebSocket handshake completes (slow network, connection still establishing), `computeAndSendFingerprint` fires, the Worker completes, and `wsSend` would be called against a disconnected socket.

**The fix:** `wsSend` inside `fileVerify.js` is conditional on `roomState.wsStatus === 'connected'`. The computed hex is always stored on `roomState.fileHash` first. The `ws.js` `onopen` handler checks for a pending hash and sends it:

```js
// ws.js — in the onopen handler, after the join message is sent:
if (roomState.fileHash && roomState.fileVerdict === FILE_VERDICTS.PENDING) {
    wsSend('file_fileVerify', { fileVerify: roomState.fileHash })
}
```

This covers both the initial race (file picked before connect) and the reconnect re-validation path (same mechanism, different trigger).

---

## Reconnect Re-validation

When a user reconnects via session token they skip the lobby and land in the watch view. Their new `Client` struct on the server has `fileVerifyValid = false`. They cannot send sync commands until re-validated.

The re-validation is automatic and requires no user action:

1. WebSocket disconnects → `ws.js` `onclose` fires:
   ```js
   // ws.js — onclose handler:
   cancelFingerprintTimeout()          // cancel any in-flight server-verdict timeout
   roomState.fileVerdict = FILE_VERDICTS.PENDING
   // fileHash is preserved — needed for re-send
   notifyUpdate()
   ```
2. Reconnect completes → `ws.js` `onopen` fires → join message sent → server restores session via token
3. `onopen` handler checks `roomState.fileHash` and `roomState.fileVerdict === PENDING` → sends `file_fileVerify` automatically
4. `handleFileVerifyCommand` runs — canonical is unchanged, hash still matches → `valid`, `fileVerifyValid = true`, `sync_state` sent
5. User can play/pause/seek again

The window between reconnect and re-validation is typically under 300ms (one WebSocket round trip). During this window, `sync_command` messages from this client are silently dropped. Any sync commands from other users still reach this client and `applySync` fires normally — their video stays in sync even during their own re-validation gap.

`cancelFingerprintTimeout()` is called in `onclose` to prevent a stale server-verdict timeout from overwriting the verdict that arrives after reconnect re-validation completes.

This divergence — a reconnected user being absent from `ValidatedUsers` and having `fileVerifyValid = false` until re-validation completes — is expected and by design. It is not a bug. The lobby gate already ran for this user. The re-validation is a lightweight server-side formality that resolves in under a second.

---

## Transition to Watch View

In the original flow `player:ready` triggered `showView('watch')`. **This is no longer the case.**

The `fileVerify:verdict` handler in `ui.js` is now the **sole gate** for the lobby → watch transition:

```js
// ui.js

let pendingWatchTransition = false

const tryEnterWatch = () => {
  const ready = roomState.fileState !== FILE_STATES.WAITING &&
                roomState.fileState !== FILE_STATES.HASHING
  if (roomState.fileVerdict === FILE_VERDICTS.VALID && ready) {
    showView('watch')
    render()
    pendingWatchTransition = false
  } else {
    pendingWatchTransition = true
  }
}

document.addEventListener('fileVerify:verdict', (e) => {
  if (e.detail.verdict === FILE_VERDICTS.VALID) {
    tryEnterWatch()
  }
})

// player:ready no longer calls showView('watch') — it assists if the verdict
// already arrived but the video wasn't ready yet.
document.addEventListener('player:ready', () => {
  if (pendingWatchTransition) tryEnterWatch()
  render()
})
```

**Why:** This prevents the race where the user enters watch view before `fileVerifyValid` is true on the server, causing `sync_command` messages to be silently dropped. By the time `fileVerify:verdict` fires, `fileVerifyValid` is already set on the server (it is set before the verdict is sent). `player:ready` fires ~200ms earlier — the video is always ready by the time the transition happens.

**The Pick File & Watch button** stays visible and clickable throughout the lobby. On `mismatch`, clicking it re-opens the file picker so the user can select a different file. There is no `btnJoin.disabled` pattern — the button is always available for re-pick. The watch-view transition gate is the verdict, not the button.

**Three UI states for the file selection area:**

| `fileVerdict` | `fileVerdictError` | File area shows | Watch transition |
|---|---|---|---|
| `pending` (no file) | `null` | File picker prompt (button) | Blocked |
| `pending` (computing / in-flight) | `null` | "Checking your file…" + spinner | Blocked |
| `pending` (timeout or crash) | string | Error message, button re-opens picker | Blocked |
| `valid` | any | Auto-transitions to watch view | Fires |
| `mismatch` | `null` | ✗ "This file doesn't match the room. Choose the correct version." Button re-opens picker | Blocked |

**Only the user whose verdict is `mismatch` sees this block.** Everyone already in the watch view is completely unaffected — they receive no message, no notification, no interruption.

**The first user in the room always receives `valid` immediately** (they set the canonical) — there is nothing to block against.

---

## Timeout on the Fingerprint Flow

Two sequential 15-second timeouts cover the two failure legs:

```js
// fileVerify.js

let fileVerifyWorker  = null
let fileVerifyTimeout = null

// Exposed for ws.js to call on disconnect — prevents stale timeout from
// overwriting the verdict that arrives after reconnect re-validation.
const cancelFingerprintTimeout = () => {
    clearTimeout(fileVerifyTimeout)
    fileVerifyTimeout = null
}

const computeAndSendFingerprint = (file) => {
    // Tear down any in-progress fileVerify before starting a new one.
    if (fileVerifyWorker) { fileVerifyWorker.terminate(); fileVerifyWorker = null }
    clearTimeout(fileVerifyTimeout)

    roomState.fileVerdict      = FILE_VERDICTS.PENDING
    roomState.fileVerdictError = null
    notifyUpdate()

    fileVerifyWorker = new Worker('/js/workerFileVerify.js')

    fileVerifyWorker.onmessage = ({ data: { hex } }) => {
        clearTimeout(fileVerifyTimeout)
        fileVerifyWorker.terminate()
        fileVerifyWorker = null

        roomState.fileHash = hex   // stored for reconnect re-send
        if (roomState.wsStatus === 'connected') {
            wsSend('file_fileVerify', { fileVerify: hex })
        }
        // fileVerdict stays PENDING until server replies with fileVerify_verdict.
        notifyUpdate()

        // Start a new timeout for the server-verdict leg.
        // The Worker timeout covered hashing; this one covers the round-trip.
        fileVerifyTimeout = setTimeout(() => {
            roomState.fileVerdictError = 'Verification timed out. Try picking your file again.'
            roomState.fileVerdict      = FILE_VERDICTS.PENDING
            notifyUpdate()
        }, 15000)
    }

    fileVerifyWorker.onerror = () => {
        clearTimeout(fileVerifyTimeout)
        fileVerifyWorker = null
        roomState.fileVerdictError = 'Could not read your file. Try picking it again.'
        roomState.fileVerdict      = FILE_VERDICTS.PENDING
        notifyUpdate()
    }

    fileVerifyWorker.postMessage({ file })

    // 15-second timeout covers Worker stall/crash.
    fileVerifyTimeout = setTimeout(() => {
        if (fileVerifyWorker) { fileVerifyWorker.terminate(); fileVerifyWorker = null }
        roomState.fileVerdictError = 'Verification timed out. Try picking your file again.'
        roomState.fileVerdict      = FILE_VERDICTS.PENDING
        notifyUpdate()
    }, 15000)
}

// Triggered by player.js whenever a new file is loaded.
document.addEventListener('player:fileloaded', (e) => {
    computeAndSendFingerprint(e.detail.file)
})

// Handle verdict from server.
onMessage('fileVerify_verdict', ({ verdict }) => {
    clearTimeout(fileVerifyTimeout)   // verdict arrived — cancel timeout
    fileVerifyTimeout = null
    roomState.fileVerdict      = verdict === 'valid' ? FILE_VERDICTS.VALID : FILE_VERDICTS.MISMATCH
    roomState.fileVerdictError = null
    notifyUpdate()
    document.dispatchEvent(new CustomEvent('fileVerify:verdict', {
        detail: { verdict: roomState.fileVerdict }
    }))
})
```

Both the `onerror` path and the timeout paths leave `fileVerdict` as `PENDING` (not `MISMATCH`) — the file itself is not wrong, something went wrong with the process. The user can re-pick their file to try again.

---

## workerFileVerify.js — The Web Worker

```js
// workerFileVerify.js — separate file, never included in index.html script list.
// Spawned by fileVerify.js; terminated immediately after posting the result.

self.onmessage = async ({ data: { file } }) => {
    const MB   = 1024 * 1024
    const size = file.size

    // Build 8-byte little-endian file size buffer.
    // Written as two 32-bit LE integers (lo, hi) — avoids BigInt for compatibility.
    const sizeBuffer = new ArrayBuffer(8)
    const sizeView   = new DataView(sizeBuffer)
    sizeView.setUint32(0, size >>> 0,                true)  // low 32 bits
    sizeView.setUint32(4, Math.floor(size / 2**32),  true)  // high 32 bits

    // Three 1 MB chunk slices — clamp to file bounds for small files.
    const midOffset = Math.floor(size / 2)
    const endOffset = Math.max(0, size - MB)

    const [headBuf, midBuf, tailBuf] = await Promise.all([
        file.slice(0,         Math.min(MB, size)).arrayBuffer(),
        file.slice(midOffset, Math.min(midOffset + MB, size)).arrayBuffer(),
        file.slice(endOffset, size).arrayBuffer(),
    ])

    // Concatenate: sizeBuffer + headBuf + midBuf + tailBuf
    const total    = sizeBuffer.byteLength + headBuf.byteLength
                   + midBuf.byteLength     + tailBuf.byteLength
    const combined = new Uint8Array(total)
    let   offset   = 0

    combined.set(new Uint8Array(sizeBuffer), offset); offset += sizeBuffer.byteLength
    combined.set(new Uint8Array(headBuf),    offset); offset += headBuf.byteLength
    combined.set(new Uint8Array(midBuf),     offset); offset += midBuf.byteLength
    combined.set(new Uint8Array(tailBuf),    offset)

    const hashBuffer = await crypto.subtle.digest('SHA-256', combined)
    const hex = Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('')

    self.postMessage({ hex })
}
```

---

## New WebSocket Message Types

Two additions to the message contract. Naming follows the existing `snake_case` convention used by all other message types (`sync_command`, `user_joined`, `room_state`, `host_changed`).

```
Client → Server:
    file_fileVerify      { fileVerify: "<64 char hex string>" }

Server → Client (targeted — only the requesting user, never broadcast):
    fileVerify_verdict   { verdict: "valid" | "mismatch" }
```

The server validates the hex string in `readPump` before routing it to the hub event loop. Invalid strings are dropped silently — never reach `handleFileVerifyCommand`.

```go
// In readPump switch — add alongside existing cases:
case "file_fileVerify":
    var p struct {
        FileVerify string `json:"fileVerify"`
    }
    if err := json.Unmarshal(env.Payload, &p); err != nil {
        continue
    }
    // Validate: exactly 64 lowercase hex chars.
    if len(p.FileVerify) != 64 {
        continue
    }
    valid := true
    for _, ch := range p.FileVerify {
        if !((ch >= '0' && ch <= '9') || (ch >= 'a' && ch <= 'f')) {
            valid = false
            break
        }
    }
    if !valid {
        continue
    }
    c.hub.events <- &FileVerifyEvent{client: c, hex: p.FileVerify}
```

---

## player.js — One Addition

`player.js` gains one line inside `loadFile()`: dispatching `'player:fileloaded'` after the blob URL is set. `fileVerify.js` listens for this event. `player.js` does not call into `fileVerify.js` directly — the event is the boundary, consistent with how `player.js` communicates with `sync.js`.

```js
// player.js — inside loadFile(), after video.src = roomState.blobUrl:
document.dispatchEvent(new CustomEvent('player:fileloaded', { detail: { file } }))
```

No other changes to `player.js`.

---

## Timing — Resolves Before Play

```
t = 0ms     User picks file in lobby
t = 0ms     Worker spawned, three chunk reads begin (async, off main thread)
t ≈ 200ms   SHA-256 complete (estimate on a mid-range device, ~3 MB input)
t ≈ 200ms   file_fileVerify sent over WebSocket; server-verdict timeout started
t ≈ 230ms   Hub goroutine processes FileVerifyEvent
t ≈ 230ms   fileVerify_verdict + sync_state delivered to client only
t ≈ 230ms   fileVerdict set; fileVerify:verdict dispatched; showView('watch') fires
```

The entire flow resolves well under a second. The host cannot press play until they have joined the watch view. Verification is complete long before play is possible.

---

## Edge Cases

| Scenario | Handling |
|---|---|
| User joins when others have already fingerprinted | Their hash is compared to the existing canonical. They receive `valid` or `mismatch`. |
| User re-picks the same file | Worker re-runs, same hex produced, sent again. Server compares — matches canonical, `valid` returned. |
| User re-picks a different file (non-canonical) | Worker re-runs, new hex sent. Server compares against canonical — `valid` or `mismatch` accordingly. |
| Canonical user re-picks | Rule 3 applies. Canonical promoted to another validated user. Re-picking user validated against promoted canonical. |
| Canonical user departs | `dropClient` removes from `ValidatedUsers`, promotes another validated user as canonical, or resets if none remain. No verdict sent — user is gone. |
| Non-canonical user departs | Removed from `ValidatedUsers`. No canonical shift. No verdict sent. |
| Two users send `file_fileVerify` simultaneously | Hub goroutine processes events sequentially — first in sets canonical, second is compared to it. |
| File smaller than 3 MB | Chunk offsets clamped to file bounds — `file.slice(offset, Math.min(offset + MB, size))`. SHA-256 runs on whatever bytes exist. Still deterministic. |
| File exactly 0 bytes | `sizeBuffer` encodes 0, all three slices return empty ArrayBuffers. SHA-256 of the 8-byte size-only input. Unique fingerprint. |
| Only one user ever in the room | They set the canonical, receive `valid`, watch transition fires. No comparison ever happens. |
| File picked before WebSocket connected | `wsSend` skipped. Hex stored in `roomState.fileHash`. `onopen` handler sends it after connect. |
| WebSocket disconnects while verdict in-flight | `cancelFingerprintTimeout()` called — stale server-verdict timeout cancelled. `fileVerdict` reset to `PENDING` on disconnect. On reconnect, `onopen` re-sends stored `fileHash`. New verdict arrives and sets state correctly. |
| Worker stalls past timeout | 15s Worker-stall timeout terminates Worker. `fileVerdictError` set. User re-picks to retry. |
| Server never replies (network issue) | 15s server-verdict timeout fires. `fileVerdictError` set. Same recovery path. |
| Worker crashes | `onerror` fires. `fileVerdictError` set. Watch transition stays blocked. User re-picks to retry. |
| Reconnecting validated user | `fileVerifyValid = false` on new Client. `onopen` re-sends `fileHash`. Re-validation completes in one round trip (~300ms). `sync_command` silently dropped during gap. |
| Two users, both with wrong files | First in sets canonical, second receives `mismatch`. Correct — their files do not match each other. |
| Client sends `sync_command` without ever sending `file_fileVerify` | `fileVerifyValid = false` — silently dropped at server. Room playback unaffected. |
| Client bypasses lobby UI and sends `sync_command` directly | Same as above — server gate is independent of client UI. |
| Server receives malformed hex | Length check and character validation in `readPump` — silently dropped before reaching `handleFileVerifyCommand`. |
| Files differ only in metadata tags | Fingerprint is a strong signal, not a cryptographic proof. If sampled regions are identical, files may pass as matching. False positives are benign — drift will be noticed within seconds. False negatives are not possible for identical byte content. |
| Room empties and re-created | `fileVerifyStates` entry deleted on empty. Next user to pick a file sets a fresh canonical. |

---

## What This Step Does Not Do

| Thing | Deferred to |
|---|---|
| Check video duration as a secondary signal | v2 — requires metadata load before verification, adds sequencing complexity |
| Display filenames in the mismatch warning | Not implemented — filenames are unreliable identifiers |
| Re-hash during playback | Not needed — fingerprint is a join-time check, not a runtime monitor |
| Full file hash | Explicitly out of scope — performance |
| Notify existing room members of a new member's verdict | By design — not their concern |
| Persist canonical hash to Redis | Not needed — ephemeral within a session |
| Block `relay` messages from unvalidated clients | By design — WebRTC signaling must work regardless of validation state |

---

## Files This Step Produces

| File | Change type | Purpose |
|---|---|---|
| `js/workerFileVerify.js` | New | Web Worker: chunks + SHA-256, returns hex |
| `js/fileVerify.js` | New | Main-thread coordinator: spawns Worker, stores hash, sends to server, receives verdict, two timeouts, drives state, exposes `cancelFingerprintTimeout` |
| `js/state.js` | Modified | Add `fileVerdict`, `fileHash`, `fileVerdictError` to `roomState`; add `FILE_VERDICTS` constants |
| `js/ws.js` | Modified | Call `cancelFingerprintTimeout` and reset `fileVerdict` in `onclose`; re-send `fileHash` in `onopen` if pending |
| `js/player.js` | Modified | Dispatch `'player:fileloaded'` inside `loadFile()` |
| `js/ui.js` | Modified | Add `renderFingerprintVerdict`; gate watch transition on `fileVerify:verdict` via `tryEnterWatch`; `player:ready` no longer calls `showView('watch')` |
| `index.html` | Modified | Add `fileVerify-spinner` and `fileVerify-error` elements; add `<script src="/js/fileVerify.js">` |
| `style.css` | Modified | Add `.fileVerify-pending`, `.spinner`, `@keyframes spin` |
| `server/hub.go` | Modified | Add `fileVerifyValid bool` to `Client`; add `RoomFileVerifyState`, `FileVerifyEvent`, `handleFileVerifyCommand`; gate `handleSyncCommand`; send `sync_state` after valid verdict; remove `sync_state` from `handleRegister`; departure cleanup in `dropClient`; delete entry in room-empty path |

---

## Build Sequence

1. **Go:** Add `fileVerifyValid bool` to `Client` struct in `hub.go`.
2. **Go:** Add `RoomFileVerifyState` struct and `h.fileVerifyStates map[string]RoomFileVerifyState` to `Hub`.
3. **Go:** Add `FileVerifyEvent{client, hex}` type with `execute()` calling `handleFileVerifyCommand`.
4. **Go:** Add hex validation and `file_fileVerify` case to `readPump` switch sending `FileVerifyEvent` into `h.events`.
5. **Go:** Implement `handleFileVerifyCommand` — canonical init, Rule 2 comparison, Rule 3 shift with `fileVerifyValid` management, targeted `fileVerify_verdict` reply, `sync_state` send on valid.
6. **Go:** Remove `sync_state` send from `handleRegister` (moved to `handleFileVerifyCommand`).
7. **Go:** Add `if !c.fileVerifyValid { return }` guard at top of `handleSyncCommand`.
8. **Go:** Add `ValidatedUsers` departure cleanup block to `dropClient` (before room-empty check).
9. **Go:** Add `delete(h.fileVerifyStates, roomCode)` in `dropClient` room-empty path.
10. **Go test:** Two `wscat` sessions in same room. First sends `file_fileVerify` with any hex → `valid`. Second sends same hex → `valid`. Second sends different hex → `mismatch`. Neither validated client can trigger `sync_command` before their verdict arrives.
11. **Client:** `state.js` — add `fileVerdict`, `fileHash`, `fileVerdictError` to `roomState`; add `FILE_VERDICTS` constants.
12. **Client:** `player.js` — add `'player:fileloaded'` dispatch inside `loadFile()`.
13. **Client:** `workerFileVerify.js` — size buffer, three chunk reads, SHA-256, post hex.
14. **Client:** `fileVerify.js` — Worker spawn/terminate, Worker-stall timeout, conditional `wsSend`, `roomState.fileHash` storage, server-verdict timeout, `onMessage('fileVerify_verdict', ...)`, `'fileVerify:verdict'` dispatch, `cancelFingerprintTimeout` export.
15. **Client:** `ws.js` — call `cancelFingerprintTimeout` and reset `fileVerdict` in `onclose`; re-send `fileHash` in `onopen` if pending.
16. **Client:** `index.html` — add `fileVerify-spinner` and `fileVerify-error` elements to lobby file section; add `<script src="/js/fileVerify.js">`.
17. **Client:** `style.css` — add `.fileVerify-pending`, `.spinner`, `@keyframes spin`.
18. **Client:** `ui.js` — add `renderFingerprintVerdict`; implement `tryEnterWatch` / `pendingWatchTransition`; gate `showView('watch')` exclusively on `fileVerify:verdict`; `player:ready` calls `tryEnterWatch` if transition is pending.
19. **Integration test:**
    - Solo in room: pick any file → `valid` → auto-transitions to watch view
    - Two tabs: both pick same file → both `valid`, both enter watch
    - Two tabs: second picks different file → second gets `mismatch`, watch blocked, first user unaffected
    - Canonical user re-picks correct file → `valid`
    - Canonical user re-picks wrong file → `mismatch`
    - Canonical user leaves → canonical shifts to remaining validated user → new joiner compared correctly
    - File picked before WS connected → hash stored → sent on `onopen` → verdict arrives correctly
    - Disconnect and reconnect → stale timeout cancelled → re-validation automatic → `sync_command` works again after one round trip
    - Bypass lobby UI, send `sync_command` directly → silently dropped by server
    - Simulate Worker stall (block Worker response) → Worker-stall timeout fires after 15s → error message appears → re-pick restores normal flow
    - Simulate server non-reply (hash sent but no verdict) → server-verdict timeout fires after 15s → error message appears → re-pick restores normal flow
    - File smaller than 3 MB → fingerprint produced, verdict received correctly