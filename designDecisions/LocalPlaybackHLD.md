# Step 3 — File Picker, `<video>` Element, Local Playback — High Level Design

---

## What This Step Is

A single new JS file (`player.js`) and expansions to `index.html`, `style.css`, and `ui.js`. No new server code. No new routes. No WebSocket messages. Everything in this step happens entirely inside the browser. At the end of it, a user who has joined a room can pick a local movie file and watch it play in a full-viewport `<video>` element with working controls.

Sync (step 4), fingerprinting (step 5), and WebRTC (steps 6–7) are deliberately outside this scope. This step is the foundation those steps will plug into. It must be right before anything else is built on top of it.

Every decision below flows from the same four principles:

- **Secure** — hostile inputs, bad actors, and flaky clients never affect other users
- **Fast** — the server adds microseconds of latency, never milliseconds
- **Smooth** — reconnects are seamless, membership state is always accurate, no ghost users
- **Light** — minimal memory, minimal Redis calls, minimal complexity

This step is entirely client-side. "Fast" and "Light" apply to the browser: no blocking operations on the main thread, no memory leaks, no unnecessary DOM churn.

---

## What Changes

```
frontend/public/
├── index.html          Replace the watch view placeholder with real structure
├── style.css           Add watch-view, overlay, control bar, file picker styles
└── js/
    ├── state.js        Add formatTime() utility at the bottom
    ├── ws.js           No changes
    ├── player.js       NEW — owns the <video> element and all file/playback logic
    └── ui.js           Add lobby→watch transition trigger, file picker button in lobby
```

No Go files change. No Redis schema changes. No new WebSocket message types.

The concatenation order gains one entry:

```bash
cat js/state.js js/ws.js js/player.js js/sync.js js/webrtc.js js/ui.js > public/app.js
#                                ↑ new
```

`player.js` sits after `ws.js` (which it reads `roomState` from) and before `sync.js` (which will call into it in step 4). This ordering is the contract — `player.js` exposes a plain object surface that `sync.js` will later drive.

---

## Module Ownership — Why `player.js` Is a Separate File

`ws.js` owns the WebSocket connection exclusively. Nothing else touches it. The same principle applies here: **`player.js` owns the `<video>` element and the time-sensitive display elements.** Nothing else in the app calls `video.play()`, `video.pause()`, or sets `video.currentTime` directly.

The time-sensitive display elements — `timeCurrent`, `seekBar`, `timeTotal`, `volumeSlider` — are owned by `player.js` for the same reason as the `<video>` element: they must be updated at video-tick frequency, synchronously with playback state, without going through the event bus. They are not UI elements in the `ui.js` sense — `ui.js` never reads or writes them. They are extensions of the playback surface.

`controlsBar`, `filePickerOverlay`, `btnPlayPause`, and every other element in the watch view are owned by `ui.js`. `player.js` holds no reference to them and has no knowledge of their existence.

This boundary matters for step 4. The sync engine will call `player.play(position)`, `player.pause(position)`, `player.seekTo(position)` — a narrow, stable API. If the `<video>` element were touched from multiple places, a single misordering of operations would cause a race between local user input and an incoming sync command. Centralised ownership eliminates that class of bug before it can exist.

```
player.js owns:
  - the <video> element
  - timeCurrent, seekBar, timeTotal, volumeSlider
    (time-sensitive display — updated at video-tick frequency, never via event bus)
  - creating and revoking blob URLs
  - responding to File API events
  - exposing: play(pos), pause(pos), seekTo(pos), nudge(secs), openPicker(),
              getCurrentTime(), getDuration()
  - setting roomState.blobUrl, roomState.fileState
  - dispatching 'player:ready' and 'player:action' events

player.js does NOT own:
  - controlsBar, filePickerOverlay, btnPlayPause, or any other UI element
  - calling showView() — that decision belongs to ui.js
  - WebSocket communication
  - roomState.members
  - file fingerprinting (step 5 — fingerprint.js Worker)
```

### Cross-module communication

`player.js` and `ui.js` communicate in two directions. The direction matters:

**`ui.js` → `player.js`:** Direct call at runtime. `player` is a plain object on the global scope — fully available by the time any click handler fires. `ui.js` calls `player.openPicker()` directly. No event needed, no indirection, no ceremony.

**`player.js` → `ui.js`:** Document events only. `player.js` is parsed before `ui.js` exists. Any direct call from `player.js` into a `ui.js` function would be a load-order violation. Events eliminate the dependency entirely:

```
player.js dispatches → 'player:ready'  → ui.js handles (call showView)
player.js dispatches → 'player:action' → sync.js handles (step 4, send WebSocket message)
```

This is consistent with how `ws.js` and `ui.js` already communicate — `ws.js` mutates `roomState` and calls `notifyUpdate()`, `ui.js` listens for `room:updated` and re-renders. No direct calls in either direction.

### `notifyUpdate` is for cross-module state changes only

`notifyUpdate()` dispatches `room:updated`, which triggers `render()` in `ui.js`. It is the right tool when a state change needs to be reflected across the app — a member joining, the WebSocket reconnecting, `fileState` changing.

It is the wrong tool for time-sensitive display updates. `timeupdate` fires up to 4 times per second. Routing it through `notifyUpdate` would mean dispatching a CustomEvent, triggering `render()`, running the full watch-view render branch, and touching the DOM — 4 times per second — for the sole purpose of updating a time label and a seek bar. This is continuous render churn with no benefit.

The time-sensitive elements are updated by direct DOM manipulation inside `player.js`. `notifyUpdate` is never called from `ontimeupdate`. `onplay` and `onpause` do call `notifyUpdate` — the play/pause button icon is rendered by `ui.js` and it needs to know when playback state changes. That is a legitimate cross-module concern. `ontimeupdate` is not.

---

## `formatTime` — Shared Utility in `state.js`

`player.js` calls `formatTime(video.currentTime)` and `formatTime(video.duration)`. `formatTime` is a pure utility function with no module affiliation and no side effects. It belongs at the bottom of `state.js` — loaded first, available everywhere, no load-order concern.

```js
// state.js — at the bottom, after all state definitions
const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
```

---

## The View Transition — Lobby to Watch

When the WebSocket connects and name is set, the user stays in the lobby. A "Pick File & Watch" button appears. Clicking it calls `player.openPicker()` directly. On file selection, `player.js` creates the blob URL, sets `video.src`, and when the video is ready (`oncanplay`), dispatches `'player:ready'`. `ui.js` handles `'player:ready'` and calls `showView('watch')`.

**The lobby button is only visible when `wsStatus === 'connected'`.** Picking a file before you're in the room is meaningless — there is no one to sync with, and the file hash (step 5) has nowhere to go.

```
wsStatus = 'connected'
    → lobby shows "Pick File & Watch" button
    → user clicks
         → ui.js calls player.openPicker()
              → fileInput.click()
                   → user selects file → loadFile(file) called
                        → video.src = blobUrl
                             → video.oncanplay fires
                                  → guard: fileState !== HASHING? return
                                  → setFileState('ready')
                                  → player.js dispatches 'player:ready'
                                       → ui.js handles: showView('watch')
```

---

## File Picker — Design Decisions

### No styled `<input type="file">`

The native file input is invisible. The visible button is a `<label>`. `player.openPicker()` calls `fileInput.click()` programmatically — the standard accessible pattern:

```html
<label class="btn btn-primary" for="input-file">Choose File</label>
<input id="input-file" type="file" accept=".mp4,.mkv,.avi,.mov" hidden />
```

### Drag-and-drop on the watch view background

Both paths — click picker and drag — funnel into the same `loadFile(file)` function. One code path, not two:

```js
// player.js
viewWatch.addEventListener('dragover', (e) => e.preventDefault())
viewWatch.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (file) loadFile(file)
})
```

`e.preventDefault()` on `dragover` is required — without it, the browser navigates away from the app on drop.

### `accept` is advisory, not enforcement

`accept=".mp4,.mkv,.avi,.mov"` signals intent to the OS file picker but cannot prevent other formats. Enforcement is silent: `video.onerror` fires if the browser cannot decode the file. A one-line hint appears under the picker:

```
MP4 recommended. MKV support varies by browser.
```

---

## Blob URL Lifecycle — No Memory Leaks

```js
// player.js
const loadFile = (file) => {
  if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)  // revoke before replacing

  roomState.file    = file
  roomState.blobUrl = URL.createObjectURL(file)
  video.src         = roomState.blobUrl
  setFileState(FILE_STATES.HASHING)  // step 5 inserts real work here — FSM is correct now
}
```

| Scenario | Revocation point |
|---|---|
| User picks a second file | Start of `loadFile()`, before creating new URL |
| User leaves the watch view | `resetRoomState()` in `state.js` — already revokes `blobUrl` |
| Tab closes | Browser handles it — no action needed |

---

## The `<video>` Element

```html
<video id="main-video" playsinline></video>
```

| Absent attribute | Reason |
|---|---|
| `controls` | Custom control bar replaces native UI |
| `autoplay` | Playback is initiated by sync command (step 4), never automatic |
| `loop` | Movies do not loop |
| `preload` | Local blob — nothing to preload, attribute is meaningless |

`playsinline` prevents iOS Safari from entering fullscreen automatically on play. Silently ignored on desktop.

`object-fit: contain` preserves aspect ratio against any viewport shape. Black bars appear as needed — correct cinematic behaviour.

---

## fileState — The Finite State Machine

```
WAITING
    ↓  user picks / drops file
HASHING                    ← fingerprint.js Worker computing (step 5)
    ↓  hash matches
READY                      ← step 3 endpoint: video loaded, canplay fired
    ↓  sync play received
PLAYING  ←──────────────→  PAUSED
```

Step 3 drives `WAITING → HASHING → READY` only. In step 3, with no fingerprint Worker yet, `HASHING` is set on file selection and `READY` is set immediately on `oncanplay`. Step 5 inserts a real async gap between them — no step 3 code changes.

### `oncanplay` fires more than once — guard required

`oncanplay` fires on initial load and again after every seek once the browser has rebuffered. Without a guard, every seek would re-dispatch `'player:ready'` and corrupt the FSM by overwriting `PLAYING` or `PAUSED` with `READY`.

The guard checks whether the initial transition has already happened — or been superseded:

```js
// player.js
video.oncanplay = () => {
  if (roomState.fileState !== FILE_STATES.HASHING) return  // already transitioned — ignore
  setFileState(FILE_STATES.READY)
  document.dispatchEvent(new CustomEvent('player:ready'))
}

video.onerror = () => {
  setFileState(FILE_STATES.WAITING)
  // ui.js re-renders on room:updated — shows overlay with error message
}
```

`!== HASHING` is the correct guard. `=== READY` would fail in step 4 when `fileState` is `PLAYING` — the guard would not match and the handler would incorrectly overwrite active playback state mid-movie.

---

## Watch View HTML Structure

```html
<section id="view-watch">

  <div id="file-picker-overlay">
    <div class="picker-box">
      <p class="picker-title">Select your local copy of the movie</p>
      <p class="picker-hint">MP4 recommended. MKV support varies by browser.</p>
      <label class="btn btn-primary" for="input-file">Choose File</label>
      <input id="input-file" type="file" accept=".mp4,.mkv,.avi,.mov" hidden />
      <p id="file-error" class="inline-error" hidden></p>
    </div>
  </div>

  <video id="main-video" playsinline></video>

  <div id="controls-bar">
    <button id="btn-play-pause" class="ctrl-btn">▶</button>
    <span   id="time-current"   class="time-label">0:00</span>
    <input  id="seek-bar"       class="seek-bar" type="range" min="0" max="100" value="0" step="0.01" />
    <span   id="time-total"     class="time-label">0:00</span>
    <input  id="volume-slider"  class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" />
    <button id="btn-mute"       class="ctrl-btn">🔊</button>
  </div>

</section>
```

The `<video>` element is always in the DOM. Only its `src` is absent until a file is loaded — the browser requests nothing with no `src`. The overlay sits on top until the file is ready, then disappears.

---

## Watch View CSS

```
#main-video
  width: 100%; height: 100%; object-fit: contain

#file-picker-overlay
  position: absolute; inset: 0
  display: flex; align-items: center; justify-content: center
  background: rgba(0,0,0,0.85); z-index: 10
  hidden via .hidden when fileState === 'ready'

#controls-bar
  position: absolute; bottom: 0; left: 0; right: 0
  padding: 1rem 1.5rem
  background: linear-gradient(transparent, rgba(0,0,0,0.75))
  display: flex; align-items: center; gap: 0.75rem
  opacity transition: 0.3s
  hidden until fileState === 'ready'
  auto-hides after 3s inactivity (never while paused)

.seek-bar, .volume-slider
  -webkit-appearance: none; appearance: none
  height: 4px; border-radius: 2px; background: var(--border)
  cursor: pointer
```

**Controls auto-hide using `opacity` + `pointer-events`, never `display: none`.** Toggling display triggers layout recalculation on every mouse move. Opacity does not.

**Controls never hide while paused.** Enforced entirely in `ui.js` — `player.js` has no reference to `controlsBar`:

```js
// ui.js
let hideTimer

const resetHideTimer = () => {
  controlsBar.classList.remove('hidden')
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!video.paused) controlsBar.classList.add('hidden')
  }, 3000)
}

document.addEventListener('mousemove',  resetHideTimer)
document.addEventListener('touchstart', resetHideTimer)  // mousemove doesn't fire on touchscreens
```

---

## Control Bar — Local Only in Step 3

Every control operates entirely locally in step 3. Step 4 intercepts `'player:action'` events and routes them through the server. `player.js` does not change when step 4 is added.

```js
// player.js
const dispatchPlayerAction = (action, position) => {
  document.dispatchEvent(new CustomEvent('player:action', { detail: { action, position } }))
}
```

In step 3, nothing listens to `'player:action'`. It fires into the void. Zero changes to `player.js` when step 4 is added.

### Control elements

| Element | Local behaviour |
|---|---|
| `#btn-play-pause` | `video.paused ? video.play() : video.pause()` — icon via `room:updated` |
| `#seek-bar` | `seekTo(value)` on `input`; `ontimeupdate` owns it when not scrubbing |
| `#time-current` | Direct DOM update in `ontimeupdate` |
| `#time-total` | Set once on `loadedmetadata` |
| `#volume-slider` | `video.volume = value`; persisted to `sessionStorage` |
| `#btn-mute` | `video.muted = !video.muted` — icon toggles 🔇/🔊 |

### `timeupdate` — direct DOM writes, scrubbing flag

`ontimeupdate` fires up to 4 times per second. The time label and seek bar are updated directly — routing through `notifyUpdate` would trigger a full `render()` cycle 4×/second for no cross-module benefit.

During a drag, both the user and `ontimeupdate` would write to `seekBar.value` simultaneously, causing the scrubber to visibly fight the drag on slower machines. A scrubbing flag gives the user exclusive ownership of `seekBar.value` for the duration of the interaction.

The flag is set on `mousedown`/`touchstart` and cleared on document-level `mouseup`/`touchend`. Document-level listeners catch the pointer release regardless of where it lands — clearing on the element's own `change` event would leave the flag stuck if the pointer releases outside the element or if the value did not change:

```js
// player.js
let isScrubbing = false

seekBar.addEventListener('mousedown',  () => { isScrubbing = true })
seekBar.addEventListener('touchstart', () => { isScrubbing = true })
document.addEventListener('mouseup',   () => { isScrubbing = false })
document.addEventListener('touchend',  () => { isScrubbing = false })

video.ontimeupdate = () => {
  timeCurrent.textContent = formatTime(video.currentTime)
  if (video.duration && !isScrubbing) {
    seekBar.value = (video.currentTime / video.duration) * 100
  }
}
```

`video.duration` is `NaN` until `loadedmetadata` fires — `if (video.duration)` is the correct guard since `NaN` is falsy.

### Seek bar — two events, one job each

```js
// player.js
seekBar.addEventListener('input', () => {
  seekTo((seekBar.value / 100) * video.duration)   // live scrub — video follows the bar
})

seekBar.addEventListener('change', () => {
  dispatchPlayerAction('seek', video.currentTime)  // drag ended — step 4 intercepts this
})
```

`change` fires once when the drag ends. Sending a WebSocket message on every pixel of drag would flood the server — only `change` matters for sync.

### `video.play()` always caught

`video.play()` returns a Promise that rejects when interrupted — for example when `pause()` arrives while a `play()` is still resolving. Without a catch, this produces an uncaught rejection that masks real errors:

```js
video.play().catch(err => {
  if (err.name !== 'AbortError') console.error('player: play failed —', err)
})
```

`AbortError` is expected and suppressed. All other rejections are genuine and logged. Applied to every `video.play()` call — both the local button handler and the `player.play(position)` API used by sync.js.

### `readyState` guard on seek

`video.currentTime = position` silently does nothing if `readyState < HAVE_METADATA (1)`. All seeks go through one internal function:

```js
// player.js
const seekTo = (position) => {
  if (video.readyState >= 1) video.currentTime = position
  // readyState < 1: safe to drop — oncanplay fires shortly after and sync.js
  // applies the authoritative position from room_state at that point
}
```

### Volume persistence

```js
// player.js — on init
const savedVolume = sessionStorage.getItem('syncoplex_volume')
if (savedVolume !== null) {
  video.volume = parseFloat(savedVolume)
  volumeSlider.value = savedVolume
}

// player.js — on change
volumeSlider.addEventListener('input', () => {
  video.volume = volumeSlider.value
  sessionStorage.setItem('syncoplex_volume', volumeSlider.value)
})
```

Restored before any file is loaded — the slider is correct the moment the watch view first appears. `sessionStorage` scoping matches the session token: survives refresh, cleared on tab close.

### Keyboard shortcuts

Registered in `ui.js` (input events belong there), but **every playback shortcut goes through `player.js`**. `ui.js` must never touch `video.currentTime` directly — doing so bypasses the `readyState` guard and `dispatchPlayerAction`, silently desyncing arrow key seeks in step 4.

`Space` routes through the button click. Arrow keys route through `player.nudge()`, which handles the seek and dispatches the event internally:

```js
// ui.js
document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'watch') return
  if (e.target.tagName === 'INPUT') return

  if (e.code === 'Space')      { e.preventDefault(); btnPlayPause.click() }
  if (e.code === 'ArrowRight') { e.preventDefault(); player.nudge(+5) }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); player.nudge(-5) }
  if (e.code === 'KeyM')       { btnMute.click() }
  if (e.code === 'KeyF')       { toggleFullscreen() }
})
```

```js
// player.js
const nudge = (seconds) => {
  const target = Math.max(0, Math.min(video.currentTime + seconds, video.duration || 0))
  seekTo(target)
  dispatchPlayerAction('seek', target)
}
```

Clamped to `[0, duration]`. `readyState` guard applied via `seekTo`. Event dispatched for step 4. `ui.js` knows none of this.

---

## `player.js` — Public API

```js
const player = {
  play: (position) => {
    seekTo(position)
    video.play().catch(err => {
      if (err.name !== 'AbortError') console.error('player: play failed —', err)
    })
  },
  pause:          (position) => { seekTo(position); video.pause() },
  seekTo,
  nudge:          (seconds)  => {
    const target = Math.max(0, Math.min(video.currentTime + seconds, video.duration || 0))
    seekTo(target)
    dispatchPlayerAction('seek', target)
  },
  openPicker:     ()         => fileInput.click(),
  getCurrentTime: ()         => video.currentTime,
  getDuration:    ()         => video.duration,
}
```

`play(position)` and `pause(position)` always seek before acting — the authoritative position comes from the server message, not from local `video.currentTime`. Latency compensation is `sync.js`'s responsibility. The `readyState` guard inside `seekTo` applies to all callers including sync.js.

`nudge` is the only method that also dispatches `player:action` — keyboard shortcuts in `ui.js` have no other way to trigger the sync event without calling `dispatchPlayerAction` directly, which would be a boundary violation.

`openPicker` is called directly by `ui.js` at runtime — no event needed, `player` is on the global scope by the time any click handler fires.

---

## Event Contract

Two events only. `player:pick` has been removed — it was unnecessary indirection between a button click and a method call available at runtime.

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `player:ready` | player.js → ui.js | none | video loaded; ui calls showView('watch') |
| `player:action` | player.js → sync.js | `{ action, position }` | playback command; sync.js routes to server in step 4 |

---

## Security — File Handling

The File API is entirely browser-sandboxed:

- The file never leaves the user's machine
- Cannot access files the user did not explicitly select
- Accessed only via `URL.createObjectURL` — an opaque blob URL never sent anywhere, never in a WebSocket message, never readable by another user

`video.onerror` is always handled. An unhandled error leaves the UI in an inconsistent state. The handler resets `fileState` to `WAITING`, causing `ui.js` to re-render the overlay with an error message.

---

## `ui.js` Additions

Three additions only. `ui.js` never touches `video.currentTime`, never calls `dispatchPlayerAction`, and the only `player.js` method it calls directly is `player.openPicker()` and `player.nudge()`.

**1. Lobby — "Pick File & Watch" button**

```js
// ui.js — rendered when wsStatus === 'connected'
btnPickFile.addEventListener('click', () => player.openPicker())
```

**2. `'player:ready'` handler**

```js
// ui.js
document.addEventListener('player:ready', () => showView('watch'))
```

**3. Watch view renderer**

```js
// ui.js
const renderWatch = () => {
  btnPlayPause.textContent = video.paused ? '▶' : '⏸'

  const ready = roomState.fileState !== FILE_STATES.WAITING &&
                roomState.fileState !== FILE_STATES.HASHING
  filePickerOverlay.classList.toggle('hidden', ready)

  if (!ready) {
    controlsBar.classList.add('hidden')
  } else if (video.paused) {
    controlsBar.classList.remove('hidden')  // paused always overrides autohide
  }
  // when playing and ready, the hide timer manages visibility
}
```

```js
// player.js — notifies ui.js of playback state changes
video.onplay  = () => notifyUpdate()
video.onpause = () => notifyUpdate()
```

---

## What This Step Does Not Do

| Thing | Deferred to |
|---|---|
| Send file hash to server | Step 5 — fingerprint.js Worker |
| Warn on hash mismatch | Step 5 |
| Send play/pause/seek over WebSocket | Step 4 — sync.js |
| Timestamp compensation for sync | Step 4 |
| MKV remuxing | v2 — ffmpeg.wasm |
| Camera tiles | Step 7 — webrtc.js |
| Room sidebar | Step 9 — polish |
| Drift correction Worker | Step 6 — worker.js |

---

## Build Order Within Step 3

```
1. index.html watch view structure
   Replace placeholder with real HTML: overlay, video, controls
   No JS wired yet — verify structure and CSS in isolation
   Goal: design is correct before any logic is added

2. style.css watch view additions
   Full-viewport video, overlay positioning, control bar gradient,
   seek bar and volume slider styling, auto-hide class
   Goal: watch view looks correct with a hardcoded dummy file src

3. state.js addition
   formatTime(seconds) at the bottom
   Goal: available to player.js and ui.js with no load-order concern

4. player.js — file loading only
   loadFile(file), blob URL lifecycle, video.src assignment,
   oncanplay with !== HASHING guard → setFileState('ready') → dispatch 'player:ready',
   onerror handler, drag-and-drop,
   openPicker() on player object,
   volume persistence (sessionStorage read on init, write on change)
   Goal: pick any MP4 and it plays in the browser, no controls yet

5. player.js — control bar wiring
   play/pause button with video.play().catch(),
   isScrubbing flag — mousedown/touchstart on element,
                      mouseup/touchend cleared at document level,
   seek bar (input → seekTo, change → dispatchPlayerAction),
   ontimeupdate → direct DOM writes with duration and isScrubbing guards,
   loadedmetadata → timeTotal,
   volume slider, mute button,
   nudge(seconds) on player object,
   onplay + onpause → notifyUpdate() only,
   full player object API defined
   Goal: full local playback, seek bar never fights drag, flag cannot get stuck

6. ui.js — lobby button, player:ready handler, keyboard shortcuts, hide timer
   btnPickFile calls player.openPicker() directly
   'player:ready' listener calls showView('watch')
   renderWatch() handles all control visibility including paused-controls rule
   Arrow keys call player.nudge(), Space through button click
   mousemove + touchstart reset the hide timer
   hide timer checks video.paused before hiding
   Goal: full flow landing → lobby → file pick → watch,
         all keyboard shortcuts sync-safe, controls never hide while paused
```

Each checkpoint is independently verifiable. No network needed for checkpoints 1–5. Checkpoint 6 requires the server but not Redis.

---

## Memory Profile

```
<video> element                        1 DOM node
Blob URL                               pointer into browser file cache — not in JS heap
video.src                              string reference only — not the file data
player object                          negligible
Two document event listeners           negligible
Four element event listeners           negligible
One boolean (isScrubbing)              negligible
One sessionStorage key (volume)        negligible
formatTime in state.js                 negligible

Total JS heap addition                 < 1KB
```

A 20GB file costs exactly the same JS heap as a 500MB file. The File API reads from disk on demand. Only decoded frames live in the GPU's video buffer, managed entirely by the browser.