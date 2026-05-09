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
//   'player:action' → sync.js routes to server

// ── Element References ───────────────────────────────────────────

const video           = document.getElementById('main-video')
const fileInput       = document.getElementById('input-file')
const fileError       = document.getElementById('file-error')
const viewWatch       = document.getElementById('view-watch')
const timeCurrent     = document.getElementById('time-current')
const seekBar         = document.getElementById('seek-bar')
const timeTotal       = document.getElementById('time-total')
const volumeSlider    = document.getElementById('volume-slider')
const btnMute         = document.getElementById('btn-mute')
const btnPlayPause    = document.getElementById('btn-play-pause')
const controlsBar     = document.getElementById('controls-bar')
const filePickerOverlay = document.getElementById('file-picker-overlay')
const btnCC           = document.getElementById('btn-cc')
const subtitleInput   = document.getElementById('input-subtitle')
const subtitleTrack   = document.getElementById('subtitle-track')
const btnFullscreen   = document.getElementById('btn-fullscreen')

// ── Subtitle State ───────────────────────────────────────────────
//
// Never goes in roomState — subtitles are per-user, not synced.

let subtitleBlobUrl = null

// ── Range Fill Helper ────────────────────────────────────────────

const updateRangeFill = (el) => {
  const min = parseFloat(el.min) || 0
  const max = parseFloat(el.max) || 100
  const pct = ((parseFloat(el.value) - min) / (max - min)) * 100
  el.style.setProperty('--pct', `${pct}%`)
}

// ── Internal Helpers ─────────────────────────────────────────────

const dispatchPlayerAction = (action, position) => {
  document.dispatchEvent(new CustomEvent('player:action', { detail: { action, position } }))
}

const seekTo = (position) => {
  if (video.readyState >= 1) video.currentTime = position
}

// ── SRT → VTT Conversion ─────────────────────────────────────────
//
// VTT and SRT are nearly identical. Three differences:
//   1. VTT requires a "WEBVTT" header followed by a blank line
//   2. VTT timestamps use "." as decimal separator, SRT uses ","
//   3. Numeric sequence lines (1, 2, 3…) are valid VTT cue identifiers
//      so no stripping needed — browsers handle them fine.

const srtToVtt = (srt) => 'WEBVTT\n\n' + srt.replace(/(\d{1,2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')

// ── Subtitle Loading ─────────────────────────────────────────────

const loadSubtitle = (file) => {
  const reader = new FileReader()

  reader.onload = (e) => {
    let content = e.target.result

    // Convert SRT to VTT if needed
    if (file.name.toLowerCase().endsWith('.srt')) content = srtToVtt(content)

    // Revoke previous blob to avoid memory leak
    if (subtitleBlobUrl) URL.revokeObjectURL(subtitleBlobUrl)

    subtitleBlobUrl = URL.createObjectURL(
      new Blob([content], { type: 'text/vtt' })
    )

    applySubtitleTrack('showing')
    btnCC.classList.add('active')
  }

  reader.readAsText(file)
}

// ── Apply Subtitle Track ─────────────────────────────────────────
//
// Sets track src and mode together.
// Called on initial load and after video.src changes (new movie loaded).
// Uses showing ↔ hidden — never disabled, which forces a re-parse.

const applySubtitleTrack = (mode) => {
  if (!subtitleBlobUrl) return
  subtitleTrack.src  = subtitleBlobUrl
  subtitleTrack.track.mode = mode
}

// ── File Loading ─────────────────────────────────────────────────

const loadFile = (file) => {
  if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)

  roomState.file    = file
  roomState.blobUrl = URL.createObjectURL(file)
  video.src         = roomState.blobUrl

  // Restore subtitle track after video src change —
  // the browser resets all <track> elements when src changes.
  applySubtitleTrack(subtitleTrack.track.mode === 'hidden' ? 'hidden' : 'showing')

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
    updateRangeFill(seekBar)
  }
}

// ── Seek Bar ─────────────────────────────────────────────────────

seekBar.addEventListener('input', () => {
  seekTo((seekBar.value / 100) * video.duration)
  updateRangeFill(seekBar)
})

// 'pointerup' fires exactly once on pointer release, cross-browser.
// 'change' fired inconsistently during drag on iOS Safari — replaced here.
// Known gap: tab-to-seekbar + keyboard arrow keys move the slider locally
// but do not fire pointerup → no sync command sent. Documented for v1.
seekBar.addEventListener('pointerup', () => {
  dispatchPlayerAction('seek', video.currentTime)
})

// ── Play / Pause Button ──────────────────────────────────────────

btnPlayPause.addEventListener('click', () => {
  if (video.paused) {
    video.play().catch(err => {
      if (err.name !== 'AbortError') console.error('player: play failed —', err)
    })
    dispatchPlayerAction('play', video.currentTime)
    btnPlayPause.setAttribute('aria-label', 'Pause')
  } else {
    video.pause()
    dispatchPlayerAction('pause', video.currentTime)
    btnPlayPause.setAttribute('aria-label', 'Play')
  }
})

// ── Click to Play / Pause ────────────────────────────────────────

viewWatch.addEventListener('click', (e) => {
  if (controlsBar.contains(e.target)) return
  if (filePickerOverlay.contains(e.target)) return
  btnPlayPause.click()
})

// ── Mute Button ──────────────────────────────────────────────────

btnMute.addEventListener('click', () => {
  video.muted = !video.muted
  btnMute.textContent = video.muted ? '🔇' : '🔊'
  btnMute.setAttribute('aria-label', video.muted ? 'Unmute' : 'Mute')
})

// ── Volume Persistence ───────────────────────────────────────────

const VOLUME_KEY = 'syncoplex_volume'

const savedVolume = sessionStorage.getItem(VOLUME_KEY)
if (savedVolume !== null) {
  video.volume = Math.max(0, Math.min(1, parseFloat(savedVolume) || 1))
  volumeSlider.value = savedVolume
}
updateRangeFill(volumeSlider)

volumeSlider.addEventListener('input', () => {
  video.volume = parseFloat(volumeSlider.value)
  sessionStorage.setItem(VOLUME_KEY, volumeSlider.value)
  updateRangeFill(volumeSlider)
})

// ── CC Button ────────────────────────────────────────────────────
//
// No subs loaded → open file picker
// Subs loaded    → toggle showing ↔ hidden
// showing ↔ hidden, never disabled — disabled forces re-parse on toggle

btnCC.addEventListener('click', () => {
  if (!subtitleBlobUrl) {
    subtitleInput.click()
    return
  }

  const track = subtitleTrack.track
  if (track.mode === 'showing') {
    track.mode = 'hidden'
    btnCC.classList.remove('active')
  } else {
    track.mode = 'showing'
    btnCC.classList.add('active')
  }
})

// ── Subtitle File Input ──────────────────────────────────────────

subtitleInput.addEventListener('change', () => {
  const file = subtitleInput.files[0]
  if (file) loadSubtitle(file)
  subtitleInput.value = ''  // reset so same file can be re-picked
})

// ── Drag-and-Drop ────────────────────────────────────────────────

viewWatch.addEventListener('dragover', (e) => e.preventDefault())
viewWatch.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer.files[0]
  if (!file) return

  // Route to subtitle loader if it's a subtitle file
  const ext = file.name.split('.').pop().toLowerCase()
  if (ext === 'srt' || ext === 'vtt') {
    loadSubtitle(file)
  } else {
    loadFile(file)
  }
})

btnFullscreen.addEventListener('click', () => {
  if (!document.fullscreenElement) {
    viewWatch.requestFullscreen()
  } else {
    document.exitFullscreen()
  }
})

// ── Full Screen ───────────────────────────────────────────────────

document.addEventListener('fullscreenchange', () => {
  btnFullscreen.textContent = document.fullscreenElement ? '✕' : '⛶'
  btnFullscreen.setAttribute('aria-label', document.fullscreenElement ? 'Exit fullscreen' : 'Enter fullscreen')
})

// ── File Input ───────────────────────────────────────────────────

fileInput.addEventListener('change', () => {
  const file = fileInput.files[0]
  if (file) loadFile(file)
  fileInput.value = ''
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