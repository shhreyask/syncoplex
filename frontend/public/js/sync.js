// ── sync.js ──────────────────────────────────────────────────────
//
// Sync engine. Intercepts player:action events, routes them to the
// server via wsSend, and applies authoritative server commands back
// to the video via applySync().
//
// Depends on (load order): state.js, ws.js, player.js
// Does NOT wire the control bar — player.js owns that.
// Does NOT modify roomState.playback directly except inside applySync.

// ── Drift Guard Baseline ─────────────────────────────────────────
//
// Set on every applySync call. Used by the drift worker to compute
// expected position from elapsed local time.
// localTime === 0 means no applySync has fired yet — drift checks skip.

let lastApply = { position: 0, localTime: 0 }

// ── Pending Sync ─────────────────────────────────────────────────
//
// Stores a sync message received before video metadata has loaded.
// Re-applied on loadedmetadata. Without this, seekTo is silently
// ignored by the browser and the user starts at position 0.

let pendingSync = null

// ── Player Action → Server ───────────────────────────────────────
//
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
//
// sync_command: authoritative broadcast from server (all clients, including sender)
// sync_state:   sent only to late joiners on room join

onMessage('sync_command', (payload) => applySync(payload))
onMessage('sync_state',   (payload) => applySync(payload))

// ── Video Ended ──────────────────────────────────────────────────
//
// Notify server to pause when video reaches its natural end.
// Server processes normally — computes position, sets isPlaying: false,
// broadcasts to all. If room was already paused (another client's ended
// fired first), server silently drops the duplicate.

video.addEventListener('ended', () => {
  if (roomState.playback.playing) {
    wsSend('sync_command', { action: 'pause' })
  }
})

// ── Deferred Apply ───────────────────────────────────────────────
//
// If a sync message arrived before video metadata loaded, re-apply it
// now. Common for late joiners on slow connections.

video.addEventListener('loadedmetadata', () => {
  if (pendingSync) {
    applySync(pendingSync)
    pendingSync = null
  }
})

// ── applySync ────────────────────────────────────────────────────
//
// Applies an authoritative server command unconditionally.
// Server sent position + isPlaying — execute it.

function applySync(msg) {
  // Guard: metadata not loaded yet — browser will silently ignore seekTo.
  // Defer until loadedmetadata fires.
  if (video.readyState < 1) {
    pendingSync = msg
    return
  }

  // Clamp to duration. video.duration may be Infinity for streams;
  // guarded above against NaN (readyState < 1 check handles that case).
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

// ── Drift Guard — Web Worker ─────────────────────────────────────
//
// Solves problems orthogonal to the sync protocol:
//   - Browsers throttle backgrounded tabs → video.currentTime drifts
//   - Natural playback rate variance (~0.01%) accumulates over time
//   - Seek rebuffering can stall playback silently

let driftWorker = new Worker('/js/worker.js')

driftWorker.onerror = () => {
  // Restart on crash — sync works without the drift guard,
  // it just degrades gracefully when tabs are backgrounded.
  driftWorker = new Worker('/js/worker.js')
}

// Trigger an immediate drift check when a backgrounded tab returns.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    driftWorker.postMessage({ type: 'check' })
  }
})

driftWorker.onmessage = () => {
  // No baseline yet — skip until first applySync fires.
  // Without this guard: elapsed is enormous on first load, expected
  // overflows, hard-seek clamps to video.duration → user lands at end.
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
    // Soft correction — nudge rate toward expected position
    video.playbackRate = expected > video.currentTime ? 1.05 : 0.95
  } else {
    // In sync — restore normal rate
    video.playbackRate = 1.0
  }
}