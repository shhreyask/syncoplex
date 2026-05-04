# Step 3 — File Picker, `<video>` Element, Local Playback — High Level Design

---

## What This Step Is

A single new JS file (`player.js`) and expansions to `index.html`, `style.css`, and `ui.js`. No new server code. No new routes. No WebSocket messages. Everything in this step happens entirely inside the browser. At the end of it, a user who has joined a room can pick a local movie file and watch it play in a full-viewport `<video>` element with working controls, subtitles, and fullscreen support.

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
├── style.css           Add watch-view, overlay, control bar, file picker, subtitle styles
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

The time-sensitive display elements — `timeCurrent`, `seekBar`, `timeTotal`, `volumeSlider` — are owned by `player.js` for the same reason as the `<video>` element: they must be updated at video-tick frequency, synchronously with playback state, without going through the event bus. They are not UI elements in the `ui.js` sense — `ui.js` never reads or writes them.

`player.js` also owns `controlsBar`, `filePickerOverlay`, `btnPlayPause`, `btnCC`, `subtitleInput`, and `subtitleTrack`. These were moved from `ui.js` because:

1. `controlsBar` and `filePickerOverlay` are needed by the click-to-play-pause handler inside `player.js`
2. `btnPlayPause` icon is updated directly in `renderWatch()` which reads `video.paused` — keeping it in `ui.js` requires `video` to be referenced there, which is a boundary violation
3. All subtitle elements are purely `player.js` concerns — subtitles are per-user, not synced, and have no cross-module significance

This boundary matters for step 4. The sync engine will call `player.play(position)`, `player.pause(position)`, `player.seekTo(position)` — a narrow, stable API. Centralised ownership eliminates race conditions between local user input and incoming sync commands before they can exist.

```
player.js owns:
  - the <video> element
  - timeCurrent, seekBar, timeTotal, volumeSlider
  - controlsBar, filePickerOverlay, btnPlayPause, btnCC, btnFullscreen
  - subtitleTrack, subtitleInput
  - creating and revoking blob URLs (video and subtitle)
  - responding to File API events
  - exposing: play(pos), pause(pos), seekTo(pos), nudge(secs), openPicker(),
              getCurrentTime(), getDuration()
  - setting roomState.blobUrl, roomState.fileState
  - dispatching 'player:ready' and 'player:action' events

player.js does NOT own:
  - calling showView() — that decision belongs to ui.js
  - WebSocket communication
  - roomState.members
  - file fingerprinting (step 5 — fingerprint.js Worker)
```

### Cross-module communication

**`ui.js` → `player.js`:** Direct call at runtime. `player` is a plain object on the global scope — fully available by the time any click handler fires. `ui.js` calls `player.openPicker()` directly.

**`player.js` → `ui.js`:** Document events only. `player.js` is parsed before `ui.js` exists. Any direct call would be a load-order violation. Events eliminate the dependency entirely:

```
player.js dispatches → 'player:ready'  → ui.js handles (calls showView)
player.js dispatches → 'player:action' → sync.js handles (step 4, sends WebSocket message)
```

---

## `formatTime` — Shared Utility in `state.js`

```js
const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}
```

Pure utility, no module affiliation, no side effects. Loaded first in `state.js`, available everywhere.

---

## The View Transition — Lobby to Watch

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

The lobby button is only visible when `wsStatus === 'connected'`. Picking a file before joining the room is meaningless — there is no one to sync with.

---

## File Picker — Design Decisions

### No styled `<input type="file">`

The native file input is invisible. The visible button is a `<label>`. `player.openPicker()` calls `fileInput.click()` programmatically:

```html
<label class="btn btn-primary" for="input-file">Choose File</label>
<input id="input-file" type="file" accept=".mp4,.mkv,.avi,.mov" hidden />
```

### Drag-and-drop on the watch view

Both paths — click picker and drag — funnel into the same `loadFile(file)` or `loadSubtitle(file)` function. The drop handler routes by file extension:

```js
viewWatch.addEventListener('dragover', (e) => e.preventDefault())
viewWatch.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (!file) return

  if (file.name.endsWith('.srt') || file.name.endsWith('.vtt')) {
    loadSubtitle(file)
  } else {
    loadFile(file)
  }
})
```

`e.preventDefault()` on `dragover` is required — without it, the browser navigates away on drop.

### `accept` is advisory, not enforcement

`video.onerror` fires if the browser cannot decode the file. A hint appears under the picker: `MP4 recommended. MKV support varies by browser.`

MKV lag and stutter is a known limitation. Fix deferred to v2 — ffmpeg.wasm remuxing.

---

## Blob URL Lifecycle — No Memory Leaks

### Video blob

```js
const loadFile = (file) => {
  if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)

  roomState.file    = file
  roomState.blobUrl = URL.createObjectURL(file)
  video.src         = roomState.blobUrl

  // Restore subtitle track — browser resets all <track> elements on video src change
  applySubtitleTrack(subtitleTrack.track.mode === 'hidden' ? 'hidden' : 'showing')

  setFileState(FILE_STATES.HASHING)
  fileError.hidden = true
  fileError.textContent = ''
}
```

| Scenario | Revocation point |
|---|---|
| User picks a second file | Start of `loadFile()`, before creating new URL |
| User leaves the watch view | `resetRoomState()` in `state.js` |
| Tab closes | Browser handles it |

### Subtitle blob

```js
let subtitleBlobUrl = null  // local to player.js — never in roomState
```

Subtitles are per-user and not part of sync state. `subtitleBlobUrl` lives as a plain `let` inside `player.js`, mirroring the discipline of `roomState.blobUrl` for video. Revoked before replacement in `loadSubtitle()`.

---

## The `<video>` Element

```html
<video id="main-video" playsinline crossorigin="anonymous">
  <track id="subtitle-track" kind="subtitles" default />
</video>
```

| Attribute | Reason |
|---|---|
| `playsinline` | Prevents iOS Safari fullscreen-on-play behaviour |
| `crossorigin="anonymous"` | Required for `<track>` blob URLs in Firefox — without it subtitles load silently but never display |
| `controls` absent | Custom control bar replaces native UI |
| `autoplay` absent | Playback initiated by sync command (step 4), never automatic |
| `loop` absent | Movies do not loop |
| `preload` absent | Local blob — nothing to preload |

`object-fit: contain` preserves aspect ratio. Black bars appear as needed — correct cinematic behaviour.

---

## Subtitles

### Per-user, not synced

Each user loads their own subtitle file independently. Subtitle state is never in `roomState`, never sent over WebSocket, and has no effect on other users. This is by design — subtitle language preference is personal.

### Format support

| Format | Handling |
|---|---|
| `.vtt` | Browser native — load directly |
| `.srt` | Convert to VTT in JS before creating blob. Zero dependencies. |

SRT→VTT conversion is three things:
1. Prepend `WEBVTT\n\n` — the blank line after the header is required; single `\n` is a spec violation some browsers reject silently
2. Replace timestamp commas with dots (`00:00:01,000` → `00:00:01.000`)
3. Numeric sequence lines (`1`, `2`, `3`…) are valid VTT cue identifiers — no stripping needed

```js
const srtToVtt = (srt) => 'WEBVTT\n\n' + srt.replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
```

### Track mode — `showing` ↔ `hidden`, never `disabled`

The `<track>` element has three modes:

| Mode | Effect |
|---|---|
| `showing` | Cues visible |
| `hidden` | Track parsed and ready, cues invisible |
| `disabled` | Track unloaded — re-parse required on next enable |

Toggle is always `showing` ↔ `hidden`. Never `disabled` — toggling to `disabled` forces the browser to re-parse the blob on re-enable, causing a visible delay on large SRT files.

### Sync is automatic

The `<track>` element is driven entirely by `video.currentTime`. When `seekTo(position)` is called by the sync engine, subtitle cues update instantly to match — no subtitle-specific sync code needed.

### New video load resets the track

When `video.src` changes, the browser resets all `<track>` elements — mode goes back to `disabled`. `loadFile()` calls `applySubtitleTrack()` after setting the new src to restore the blob URL and previous mode:

```js
const applySubtitleTrack = (mode) => {
  if (!subtitleBlobUrl) return
  subtitleTrack.src = subtitleBlobUrl
  subtitleTrack.track.mode = mode
}
```

### CC button behaviour

| State | Click action |
|---|---|
| No subtitle loaded | Opens subtitle file picker |
| Subtitle loaded, showing | Switches to `hidden`, removes `.active` from button |
| Subtitle loaded, hidden | Switches to `showing`, adds `.active` to button |

`.active` applies `color: var(--accent)` — accent-coloured CC button indicates subtitles are on.

### Known limitation

SRT files from Windows machines are sometimes saved in non-UTF-8 encoding, causing garbled characters. Fix deferred — charset detection via `TextDecoder` adds complexity not warranted at this stage.

---

## fileState — The Finite State Machine

```
WAITING
    ↓  user picks / drops file
HASHING                    ← fingerprint.js Worker computing (step 5)
    ↓  hash matches
READY                      ← video loaded, canplay fired
    ↓  sync play received
PLAYING  ←──────────────→  PAUSED
```

Step 3 drives `WAITING → HASHING → READY` only. `HASHING` is set on file selection, `READY` on `oncanplay`. Step 5 inserts a real async gap — no step 3 code changes.

### `oncanplay` guard

`oncanplay` fires on initial load and again after every seek rebuffer. Guard prevents re-dispatching `'player:ready'` mid-playback:

```js
video.oncanplay = () => {
  if (roomState.fileState !== FILE_STATES.HASHING) return
  setFileState(FILE_STATES.READY)
  document.dispatchEvent(new CustomEvent('player:ready'))
}
```

`!== HASHING` is correct. `=== READY` would fail in step 4 when `fileState` is `PLAYING`.

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

  <video id="main-video" playsinline crossorigin="anonymous">
    <track id="subtitle-track" kind="subtitles" default />
  </video>

  <div id="controls-bar">
    <button id="btn-play-pause"  class="ctrl-btn">▶</button>
    <span   id="time-current"    class="time-label">0:00</span>
    <input  id="seek-bar"        class="seek-bar" type="range" min="0" max="100" value="0" step="0.01" />
    <span   id="time-total"      class="time-label">0:00</span>
    <input  id="volume-slider"   class="volume-slider" type="range" min="0" max="1" step="0.05" value="1" />
    <button id="btn-mute"        class="ctrl-btn">🔊</button>
    <button id="btn-cc"          class="ctrl-btn" title="Load subtitles">CC</button>
    <input  id="input-subtitle"  type="file" accept=".vtt,.srt" hidden />
    <button id="btn-fullscreen"  class="ctrl-btn" title="Fullscreen">⛶</button>
  </div>

</section>
```

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
  background: linear-gradient(transparent, rgba(0,0,0,0.75))
  opacity transition: 0.3s
  hidden until fileState === 'ready'
  auto-hides after 3s inactivity (never while paused)

.seek-bar
  flex: 1
  background: linear-gradient(to right, var(--accent) var(--pct, 0%), var(--border) var(--pct, 0%))
  fill updated via --pct CSS custom property set by updateRangeFill()

.volume-slider
  background: linear-gradient(to right, var(--text) var(--pct, 100%), var(--border) var(--pct, 100%))
  fill updated via --pct CSS custom property set by updateRangeFill()

.ctrl-btn.active
  color: var(--accent)   — CC button indicator when subtitles are on

::cue
  background: transparent
  color: #ffffff
  text-shadow: outline on all four sides   — readable on any scene brightness
```

**Controls auto-hide using `opacity` + `pointer-events`, never `display: none`.** Toggling display triggers layout recalculation on every mouse move. Opacity does not.

**Controls never hide while paused.** Enforced in the hide timer:

```js
hideTimer = setTimeout(() => {
  if (!video.paused) controlsBar.classList.add('hidden')
}, 3000)
```

---

## Range Fill — Seek Bar and Volume Slider

Browser range inputs have no native fill. Fill is painted via a CSS gradient using a `--pct` custom property, updated by a single helper:

```js
const updateRangeFill = (el) => {
  const min = parseFloat(el.min) || 0
  const max = parseFloat(el.max) || 100
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100
  el.style.setProperty('--pct', `${pct}%`)
}
```

`style.setProperty` triggers only a style recalculation — no layout, no paint, no compositing. Called:
- In `ontimeupdate` when not scrubbing (seek bar)
- In seek bar `input` listener (drag)
- In volume slider `input` listener
- Once on init for volume (restores persisted value visually)

During scrubbing, `ontimeupdate` skips both `seekBar.value` write and `updateRangeFill` — the `isScrubbing` guard wraps both.

---

## Click to Play / Pause

Clicking anywhere on the watch view outside the controls bar and overlay toggles play/pause:

```js
viewWatch.addEventListener('click', (e) => {
  if (controlsBar.contains(e.target)) return
  if (filePickerOverlay.contains(e.target)) return
  btnPlayPause.click()
})
```

Routes through `btnPlayPause.click()` so `dispatchPlayerAction` and `notifyUpdate` fire identically to a button click.

---

## Fullscreen

Fullscreen is managed via the Fullscreen API — not F11. The Fullscreen API keeps JS keyboard listeners intact. F11 (OS-level fullscreen) captures spacebar at the browser level before JS sees it and is not addressed.

```js
btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    viewWatch.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
})

document.addEventListener('fullscreenchange', () => {
  btnFullscreen.textContent = document.fullscreenElement ? '✕' : '⛶'
})
```

Spacebar works correctly inside Fullscreen API fullscreen.

---

## Control Bar — Local Only in Step 3

Every control operates entirely locally. Step 4 intercepts `'player:action'` events. `player.js` does not change when step 4 is added.

```js
const dispatchPlayerAction = (action, position) => {
  document.dispatchEvent(new CustomEvent('player:action', { detail: { action, position } }))
}
```

In step 3, nothing listens to `'player:action'`. It fires into the void.

### Control elements

| Element | Local behaviour |
|---|---|
| `#btn-play-pause` | `video.paused ? video.play() : video.pause()` |
| `#seek-bar` | `seekTo(value)` on `input`; `ontimeupdate` owns it when not scrubbing |
| `#time-current` | Direct DOM update in `ontimeupdate` |
| `#time-total` | Set once on `loadedmetadata` |
| `#volume-slider` | `video.volume = value`; persisted to `sessionStorage` |
| `#btn-mute` | `video.muted = !video.muted` — icon toggles 🔇/🔊 |
| `#btn-cc` | No subs: open picker. Subs loaded: toggle `showing` ↔ `hidden` |
| `#btn-fullscreen` | `requestFullscreen()` / `exitFullscreen()` |

### `video.play()` always caught

```js
video.play().catch(err => {
  if (err.name !== 'AbortError') console.error('player: play failed —', err)
})
```

`AbortError` is expected and suppressed. Applied to every `video.play()` call.

### `readyState` guard on seek

```js
const seekTo = (position) => {
  if (video.readyState >= 1) video.currentTime = position
}
```

### Volume persistence

```js
const VOLUME_KEY = 'syncoplex_volume'

const savedVolume = sessionStorage.getItem(VOLUME_KEY)
if (savedVolume !== null) {
  video.volume       = parseFloat(savedVolume)
  volumeSlider.value = savedVolume
}
updateRangeFill(volumeSlider)

volumeSlider.addEventListener('input', () => {
  video.volume = parseFloat(volumeSlider.value)
  sessionStorage.setItem(VOLUME_KEY, volumeSlider.value)
  updateRangeFill(volumeSlider)
})
```

Restored before any file is loaded. `sessionStorage` survives refresh, cleared on tab close.

### Scrubbing flag

```js
let isScrubbing = false

seekBar.addEventListener('mousedown',  () => { isScrubbing = true })
seekBar.addEventListener('touchstart', () => { isScrubbing = true }, { passive: true })
document.addEventListener('mouseup',   () => { isScrubbing = false })
document.addEventListener('touchend',  () => { isScrubbing = false }, { passive: true })
```

Document-level `mouseup`/`touchend` — cannot get stuck if pointer releases outside the element.

### Seek bar — two events, one job each

```js
seekBar.addEventListener('input', () => {
  seekTo((seekBar.value / 100) * video.duration)
  updateRangeFill(seekBar)
})

seekBar.addEventListener('change', () => {
  dispatchPlayerAction('seek', video.currentTime)  // once on drag end — not per pixel
})
```

### Keyboard shortcuts

Registered in `ui.js`, all playback actions go through `player.js` — `ui.js` never touches `video.currentTime` directly:

```js
document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'watch') return
  if (e.target.tagName === 'INPUT') return

  if (e.code === 'Space')      { e.preventDefault(); btnPlayPause.click() }
  if (e.code === 'ArrowRight') { e.preventDefault(); player.nudge(+5) }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); player.nudge(-5) }
  if (e.code === 'KeyM')       { btnMute.click() }
  if (e.code === 'KeyF')       { btnFullscreen.click() }
})
```

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

---

## Event Contract

| Event | Direction | Payload | Purpose |
|---|---|---|---|
| `player:ready` | player.js → ui.js | none | video loaded; ui calls showView('watch') |
| `player:action` | player.js → sync.js | `{ action, position }` | playback command; sync.js routes to server in step 4 |

---

## `ui.js` Additions

Three additions only. `ui.js` never touches `video.currentTime`, never calls `dispatchPlayerAction`.

**1. Lobby — "Pick File & Watch" button**

```js
btnPickFile.addEventListener('click', () => player.openPicker())
```

**2. `'player:ready'` handler**

```js
document.addEventListener('player:ready', () => {
  showView('watch')
  render()
})
```

**3. Watch view renderer**

```js
const renderWatch = () => {
  btnPlayPause.textContent = video.paused ? '▶' : '⏸'

  const ready = roomState.fileState !== FILE_STATES.WAITING &&
                roomState.fileState !== FILE_STATES.HASHING

  filePickerOverlay.classList.toggle('hidden', ready)

  if (!ready) {
    controlsBar.classList.add('hidden')
  } else if (video.paused) {
    controlsBar.classList.remove('hidden')
  }
}
```

---

## Security — File Handling

- File never leaves the user's machine
- Cannot access files the user did not explicitly select
- Blob URLs are opaque — never sent over WebSocket, never readable by another user
- `video.onerror` always handled — resets `fileState` to `WAITING`, re-renders overlay with error message
- Subtitle file input value reset after each pick (`subtitleInput.value = ''`) — same file can be re-picked

---

## What This Step Does Not Do

| Thing | Deferred to |
|---|---|
| Send file hash to server | Step 5 — fingerprint.js Worker |
| Warn on hash mismatch | Step 5 |
| Send play/pause/seek over WebSocket | Step 4 — sync.js |
| Timestamp compensation for sync | Step 4 |
| MKV remuxing | v2 — ffmpeg.wasm |
| Volume boost beyond 1.0 | v2 — Web Audio API GainNode |
| Camera tiles | Step 7 — webrtc.js |
| Room sidebar | Step 9 — polish |
| Drift correction Worker | Step 6 — worker.js |
| Subtitle charset detection (non-UTF-8 SRT) | v2 — TextDecoder with charset sniffing |

---

## Memory Profile

```
<video> element                        1 DOM node
<track> element                        1 DOM node
Video blob URL                         pointer into browser file cache — not in JS heap
Subtitle blob URL                      pointer into browser file cache — not in JS heap
player object                          negligible
subtitleBlobUrl (let)                  string reference only
isScrubbing (let)                      1 boolean
sessionStorage key (volume)            negligible
formatTime in state.js                 negligible

Total JS heap addition                 < 1KB
```

A 20GB file costs exactly the same JS heap as a 500MB file. The File API reads from disk on demand. Only decoded frames live in the GPU's video buffer, managed entirely by the browser.