// sync.js — depends on (load order): state.js, ws.js, player.js
// Does NOT wire the control bar — player.js owns that.
// Does NOT modify roomState.playback directly except inside applySync.

// Baseline for drift guard. localTime === 0 means no applySync has fired yet.
let lastApply = { position: 0, localTime: 0 }

// Stores a sync message received before video metadata has loaded.
// Re-applied on loadedmetadata — without this, seekTo is silently ignored
// and the user starts at position 0.
// pendingSyncReceivedAt lets us fast-forward position if the room was playing
// while the user was picking a file.
let pendingSync = null
let pendingSyncReceivedAt = 0

// Intercept player actions — send to server, do NOT act on video locally.
// The server echo drives the actual video change.
document.addEventListener('player:action', (e) => {
  const { action, position } = e.detail
  if (action === 'seek') {
    wsSend('sync_command', { action, position })
  } else {
    wsSend('sync_command', { action })
  }
})

// sync_command: authoritative broadcast (all clients, including sender)
// sync_state:   sent only to late joiners on room join
onMessage('sync_command', (payload) => applySync(payload))
onMessage('sync_state',   (payload) => applySync(payload))

// Notify server to pause when video ends. If the room is already paused
// (another client's ended fired first), server silently drops the duplicate.
video.addEventListener('ended', () => {
  if (roomState.playback.playing) {
    wsSend('sync_command', { action: 'pause' })
  }
})

// Re-apply a deferred sync once metadata loads. If the room was playing,
// fast-forward position by the time elapsed since the message was stored —
// otherwise the late joiner lands several seconds behind.
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

function applySync(msg) {
  // Metadata not loaded — seekTo would be silently ignored. Defer.
  if (video.readyState < 1) {
    pendingSync = msg
    pendingSyncReceivedAt = performance.now()
    return
  }

  // video.duration is Infinity for streams; NaN case is guarded by readyState check above.
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

  // performance.now() is monotonic — immune to NTP corrections and clock adjustments.
  lastApply = { position: target, localTime: performance.now() }

  notifyUpdate()
}

// ── Drift Guard — Web Worker ─────────────────────────────────────
//
// Catches drift orthogonal to the sync protocol:
//   - Browsers throttle backgrounded tabs → video.currentTime drifts
//   - Natural playback rate variance accumulates over long sessions
//   - Seek rebuffering can stall playback silently
//
// Sync works without this — drift correction degrades gracefully if the
// worker fails. Exponential backoff + retry cap prevents tight allocation
// loops if worker.js is missing or CSP-blocked.

let driftWorker = null
let workerRetries = 0
const MAX_WORKER_RETRIES = 5

function startDriftWorker() {
  if (workerRetries >= MAX_WORKER_RETRIES) {
    driftWorker = null  // explicit null — visibilitychange ?. becomes a true no-op
    return
  }

  driftWorker = new Worker('/js/worker.js')

  driftWorker.onmessage = () => {
    workerRetries = 0

    if (lastApply.localTime === 0) return

    if (video.paused) return
    if (!roomState.playback.playing) return

    const elapsed  = (performance.now() - lastApply.localTime) / 1000
    const expected = lastApply.position + elapsed
    const drift    = Math.abs(expected - video.currentTime)

    if (drift > 2) {
      video.playbackRate = 1.0
      player.seekTo(expected)
    } else if (drift > 0.5) {
      video.playbackRate = expected > video.currentTime ? 1.05 : 0.95
    } else {
      video.playbackRate = 1.0
    }
  }

  driftWorker.onerror = () => {
    driftWorker.terminate()  // release the failed worker before scheduling retry
    driftWorker = null
    workerRetries++
    const delay = Math.min(1000 * 2 ** workerRetries, 30_000)
    setTimeout(startDriftWorker, delay)
  }
}

startDriftWorker()

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    driftWorker?.postMessage({ type: 'check' })
  }
})