// ── player.js ────────────────────────────────────────────────────
//
// Owns the <video> element and all file/playback logic.
// Nothing else in the app calls video.play(), video.pause(),
// or sets video.currentTime directly.
//
// Public API (used by ui.js and sync.js):
//   player.play(position), player.pause(position),
//   player.seekTo(position), player.nudge(seconds),
//   player.openPicker(), player.getCurrentTime(), player.getDuration()
//
// Events dispatched:
//   'player:ready'  → ui.js calls showView('watch')
//   'player:action' → sync.js routes to server (step 4)

// ── Element References ───────────────────────────────────────────

const video         = document.getElementById('main-video')
const fileInput     = document.getElementById('input-file')
const fileError     = document.getElementById('file-error')
const viewWatch     = document.getElementById('view-watch')
const timeCurrent   = document.getElementById('time-current')
const seekBar       = document.getElementById('seek-bar')
const timeTotal     = document.getElementById('time-total')
const volumeSlider  = document.getElementById('volume-slider')
const btnMute       = document.getElementById('btn-mute')
const btnPlayPause  = document.getElementById('btn-play-pause')

// ── Internal Helpers ─────────────────────────────────────────────

const dispatchPlayerAction = (action, position) => {
  document.dispatchEvent(new CustomEvent('player:action', { detail: { action, position } }))
}

const seekTo = (position) => {
  if (video.readyState >= 1) video.currentTime = position
  // readyState < 1: safe to drop — oncanplay fires shortly after and
  // sync.js applies the authoritative position from room_state at that point
}

// ── File Loading ─────────────────────────────────────────────────

const loadFile = (file) => {
  if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)

  roomState.file    = file
  roomState.blobUrl = URL.createObjectURL(file)
  video.src         = roomState.blobUrl

  setFileState(FILE_STATES.HASHING)

  fileError.hidden = true
  fileError.textContent = ''
}

// ── Video Event Handlers ─────────────────────────────────────────

video.oncanplay = () => {
  if (roomState.fileState !== FILE_STATES.HASHING) return
  setFileState(FILE_STATES.READY)
  document.dispatchEvent(new CustomEvent('player:ready'))
}

video.onerror = () => {
  setFileState(FILE_STATES.WAITING)
  fileError.textContent = 'Could not load file. Try an MP4.'
  fileError.hidden = false
}

video.onloadedmetadata = () => {
  timeTotal.textContent = formatTime(video.duration)
}

video.onplay  = () => notifyUpdate()
video.onpause = () => notifyUpdate()

// ── Scrubbing Flag ────────────────────────────────────────────────
//
// Prevents ontimeupdate from fighting the user's drag.
// Set on the element, cleared at document level so a pointer release
// outside the element doesn't leave the flag stuck.

let isScrubbing = false

seekBar.addEventListener('mousedown',  () => { isScrubbing = true })
seekBar.addEventListener('touchstart', () => { isScrubbing = true }, { passive: true })
document.addEventListener('mouseup',   () => { isScrubbing = false })
document.addEventListener('touchend',  () => { isScrubbing = false }, { passive: true })

// ── Time Display ─────────────────────────────────────────────────

video.ontimeupdate = () => {
  timeCurrent.textContent = formatTime(video.currentTime)
  if (video.duration && !isScrubbing) {
    seekBar.value = (video.currentTime / video.duration) * 100
  }
}

// ── Seek Bar ─────────────────────────────────────────────────────

seekBar.addEventListener('input', () => {
  seekTo((seekBar.value / 100) * video.duration)
})

seekBar.addEventListener('change', () => {
  dispatchPlayerAction('seek', video.currentTime)
})

// ── Play / Pause Button ──────────────────────────────────────────

btnPlayPause.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(err => {
      if (err.name !== 'AbortError') console.error('player: play failed —', err)
    })
    dispatchPlayerAction('play', video.currentTime)
  } else {
    video.pause()
    dispatchPlayerAction('pause', video.currentTime)
  }
})

// ── Mute Button ──────────────────────────────────────────────────

btnMute.addEventListener('click', () => {
  video.muted = !video.muted
  btnMute.textContent = video.muted ? '🔇' : '🔊'
})

// ── Volume Persistence ───────────────────────────────────────────

const VOLUME_KEY = 'syncoplex_volume'

const savedVolume = sessionStorage.getItem(VOLUME_KEY)
if (savedVolume !== null) {
  video.volume       = parseFloat(savedVolume)
  volumeSlider.value = savedVolume
}

volumeSlider.addEventListener('input', () => {
  video.volume = parseFloat(volumeSlider.value)
  sessionStorage.setItem(VOLUME_KEY, volumeSlider.value)
})

// ── Drag-and-Drop ────────────────────────────────────────────────

viewWatch.addEventListener('dragover', (e) => e.preventDefault())
viewWatch.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (file) loadFile(file)
})

// ── File Input ───────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (file) loadFile(file)
})

// ── Public API ───────────────────────────────────────────────────

const player = {
  play: (position) => {
    seekTo(position)
    video.play().catch(err => {
      if (err.name !== 'AbortError') console.error('player: play failed —', err)
    })
  },
  pause: (position) => {
    seekTo(position)
    video.pause()
  },
  seekTo,
  nudge: (seconds) => {
    const target = Math.max(0, Math.min(video.currentTime + seconds, video.duration || 0))
    seekTo(target)
    dispatchPlayerAction('seek', target)
  },
  openPicker:     () => fileInput.click(),
  getCurrentTime: () => video.currentTime,
  getDuration:    () => video.duration,
}