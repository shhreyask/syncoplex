// ── UI Layer ─────────────────────────────────────────────────────
//
// Listens for 'room:updated' and re-renders affected components.
// Never calls ws.js directly — all communication goes through
// roomState and wsSend().
//
// Flow:
//   Landing → Create/Join → Lobby (no connection yet)
//   User enters name → clicks Set Name → WebSocket connects
//   wsStatus === 'connected' → Pick File & Watch button appears
//   user picks file → fingerprint computed → server verdict arrives
//   verdict === 'valid' → showView('watch')   ← ONLY path to watch
//   verdict === 'mismatch' → red error above button, re-pick on click
//
// Note: player:ready no longer triggers showView('watch'). The
// fingerprint verdict is the sole gate. player:ready always fires
// before the verdict (~200ms earlier), so the video is guaranteed
// ready by the time the transition happens.

// ── Element References ───────────────────────────────────────────

const $ = (id) => document.getElementById(id)

// Landing
const btnCreate     = $('btn-create')
const inputJoinCode = $('input-join-code')
const btnJoin       = $('btn-join')
const landingError  = $('landing-error')

// Lobby
const lobbyRoomCode      = $('lobby-room-code')
const btnCopyCode        = $('btn-copy-code')
const inputName          = $('input-name')
const btnSetName         = $('btn-set-name')
const lobbyError         = $('lobby-error')
const wsStatusDot        = $('ws-status-indicator')
const wsStatusLabel      = $('ws-status-label')
const membersList        = $('members-list')
const btnLeaveLobby      = $('btn-leave-lobby')
const btnPickFile        = $('btn-pick-file')
const fingerprintSpinner = $('fingerprint-spinner')
const fingerprintError   = $('fingerprint-error')

// Reconnect pill (injected into body)
const reconnectPill = (() => {
  const el = document.createElement('div')
  el.id = 'reconnect-pill'
  el.textContent = 'Reconnecting…'
  document.body.appendChild(el)
  return el
})()

// ── View Transitions ─────────────────────────────────────────────

const showView = (view) => {
  document.body.dataset.view = view
}

// ── Error Helpers ────────────────────────────────────────────────

const showError = (el, msg) => {
  el.textContent = msg
  el.hidden = false
}

const clearError = (el) => {
  el.textContent = ''
  el.hidden = true
}

// ── Landing Handlers ─────────────────────────────────────────────

const enterLobby = (roomCode) => {
  roomState.roomCode = roomCode
  lobbyRoomCode.textContent = roomCode
  inputName.value = ''
  clearError(lobbyError)
  showView('lobby')
  inputName.focus()
}

btnCreate.addEventListener('click', async () => {
  clearError(landingError)
  btnCreate.disabled = true
  btnCreate.textContent = 'Creating…'

  try {
    const res = await fetch('/rooms', { method: 'POST' })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()

    const roomCode = data.code
    if (!roomCode) throw new Error('No room code in response')

    history.pushState({}, '', `/room/${roomCode}`)
    enterLobby(roomCode)
  } catch (err) {
    showError(landingError, 'Could not create room. Is the server running?')
    console.error(err)
  } finally {
    btnCreate.disabled = false
    btnCreate.textContent = 'Create Room'
  }
})

btnJoin.addEventListener('click', () => joinFromInput())
inputJoinCode.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinFromInput() })

const joinFromInput = async () => {
  clearError(landingError)

  const code = validateRoomCode(inputJoinCode.value)
  if (!code) {
    showError(landingError, 'Enter a valid room code — e.g. WOLF-BEAR-482134')
    return
  }

  btnJoin.disabled = true
  btnJoin.textContent = 'Checking…'

  try {
    const res = await fetch(`/rooms/${code}`)
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()

    if (!data.exists) { showError(landingError, 'Room not found.'); return }
    if (data.full)    { showError(landingError, 'Room is full.');    return }

    history.pushState({}, '', `/room/${code}`)
    enterLobby(code)
  } catch (err) {
    showError(landingError, 'Could not reach server.')
    console.error(err)
  } finally {
    btnJoin.disabled = false
    btnJoin.textContent = 'Join'
  }
}

// ── Lobby Handlers ───────────────────────────────────────────────

btnSetName.addEventListener('click', () => {
  const name = validateName(inputName.value)
  if (!name) {
    showError(lobbyError, 'Name must be 1–32 characters.')
    return
  }
  clearError(lobbyError)
  setMyName(name)

  disconnect()
  connect(roomState.roomCode, name)
})

inputName.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') btnSetName.click()
})

btnCopyCode.addEventListener('click', () => {
  if (!roomState.roomCode) return
  navigator.clipboard.writeText(roomState.roomCode).then(() => {
    btnCopyCode.textContent = '✓'
    setTimeout(() => { btnCopyCode.textContent = '⎘' }, 1500)
  })
})

btnLeaveLobby.addEventListener('click', () => {
  disconnect()
  resetRoomState()
  history.pushState({}, '', '/')
  showView('landing')
})

// "Pick File & Watch" — visible only when connected.
// On mismatch the button stays visible and re-opens the picker so the
// user can select a different file. On valid the verdict handler below
// auto-transitions — the user never needs to click again.
btnPickFile.addEventListener('click', () => player.openPicker())

// ── Member List Renderer ─────────────────────────────────────────

const renderMembers = () => {
  const all = [
    ...(roomState.myUserId ? [{
      userId: roomState.myUserId,
      name:   roomState.myName ?? 'You',
      isSelf: true,
    }] : []),
    ...roomState.members.map(m => ({ ...m, isSelf: false })),
  ]

  membersList.innerHTML = ''
  all.forEach(({ name, isSelf }) => {
    const li = document.createElement('li')
    if (isSelf) li.classList.add('is-self')
    li.textContent = name
    if (isSelf) {
      const tag = document.createElement('span')
      tag.className = 'member-tag'
      tag.textContent = '(you)'
      li.appendChild(tag)
    }
    membersList.appendChild(li)
  })
}

// ── WS Status Renderer ───────────────────────────────────────────

const renderWsStatus = () => {
  const status = roomState.wsStatus

  wsStatusDot.className = 'status-dot'

  if (status === 'connected') {
    wsStatusDot.classList.add('status-connected')
    wsStatusLabel.textContent = 'Connected'
    reconnectPill.classList.remove('visible')
    btnPickFile.hidden = false   // show only when connected
  } else if (status === 'connecting') {
    wsStatusDot.classList.add('status-connecting')
    wsStatusLabel.textContent = 'Connecting…'
    if (roomState.myUserId) reconnectPill.classList.add('visible')
    btnPickFile.hidden = true
  } else {
    wsStatusDot.classList.add('status-disconnected')
    wsStatusLabel.textContent = 'Disconnected'
    btnPickFile.hidden = true
  }
}

// ── Fingerprint Verdict Renderer ─────────────────────────────────
//
// Drives the small feedback area above the Pick File & Watch button.
//
//   pending, no file yet  → everything hidden (initial state)
//   pending, computing    → spinner visible
//   pending, error        → error text visible (timeout / Worker crash)
//   valid                 → all hidden — auto-transition fires below
//   mismatch              → red error text above button

const renderFingerprintVerdict = () => {
  const verdict = roomState.fileVerdict
  const error   = roomState.fileVerdictError
  const hasFile = roomState.fileHash !== null

  // Reset both indicators, then show only what's needed.
  fingerprintSpinner.hidden = true
  clearError(fingerprintError)

  if (verdict === FILE_VERDICTS.MISMATCH) {
    showError(fingerprintError, "This file doesn't match the room. Choose the correct version.")

  } else if (verdict === FILE_VERDICTS.PENDING) {
    if (error) {
      showError(fingerprintError, error)
    } else if (hasFile) {
      fingerprintSpinner.hidden = false
    }
  }
  // VALID — nothing shown; auto-transition has already fired.
}

// ── Auto-transition on valid verdict ─────────────────────────────
//
// This is the ONLY place showView('watch') is called for the normal
// lobby → watch flow. By the time this fires:
//   - fingerprintValid is true on the server (set before verdict is sent)
//   - player:ready has already fired (video is ready — it fires ~200ms earlier)
// So the user enters watch view with play immediately available.

document.addEventListener('fingerprint:verdict', (e) => {
  if (e.detail.verdict === FILE_VERDICTS.VALID) {
    showView('watch')
    render()
  }
})

// ── Watch View Renderer ──────────────────────────────────────────
//
// Called on every room:updated while in watch view.
// Manages overlay visibility, controls visibility, play/pause icon.
// Never touches video.currentTime — that belongs to player.js.

const renderWatch = () => {
  // Play/pause icon
  btnPlayPause.textContent = video.paused ? '▶' : '⏸'

  const ready = roomState.fileState !== FILE_STATES.WAITING &&
                roomState.fileState !== FILE_STATES.HASHING

  // Overlay: visible until file is ready
  filePickerOverlay.classList.toggle('hidden', ready)

  // Controls: hidden until ready; always visible while paused
  if (!ready) {
    controlsBar.classList.add('hidden')
  } else if (video.paused) {
    controlsBar.classList.remove('hidden')
  }
  // When playing and ready, the hide timer manages visibility
}

// ── Controls Auto-Hide ───────────────────────────────────────────
//
// opacity + pointer-events, never display:none — no layout thrash.
// Never hides while paused — checked before setting the timer.
// touchstart included because mousemove doesn't fire on touchscreens.

let hideTimer
let controlsVisible = true

const resetHideTimer = () => {
  if (document.body.dataset.view !== 'watch') return
  if (!controlsVisible) {
    controlsBar.classList.remove('hidden')
    controlsVisible = true
  }
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!video.paused) {
      controlsBar.classList.add('hidden')
      controlsVisible = false
    }
  }, 3000)
}

document.addEventListener('mousemove',  resetHideTimer)
document.addEventListener('touchstart', resetHideTimer, { passive: true })

// ── Keyboard Shortcuts ───────────────────────────────────────────
//
// All playback actions go through player.js — never touch
// video.currentTime directly here. That would bypass the
// readyState guard and dispatchPlayerAction, silently desyncing
// arrow key seeks in step 4.

document.addEventListener('keydown', (e) => {
  if (document.body.dataset.view !== 'watch') return
  if (e.target.matches('input, textarea, select, [contenteditable]')) return

  if (e.code === 'Space')      { e.preventDefault(); btnPlayPause.click() }
  if (e.code === 'ArrowRight') { e.preventDefault(); player.nudge(+5) }
  if (e.code === 'ArrowLeft')  { e.preventDefault(); player.nudge(-5) }
  if (e.code === 'KeyM')       { $('btn-mute').click() }
  if (e.code === 'KeyF')       { $('btn-fullscreen').click() }
})

// ── player:ready ─────────────────────────────────────────────────
//
// Fired by player.js when oncanplay fires for the first time.
//
// IMPORTANT: this no longer calls showView('watch'). The transition
// is owned exclusively by the fingerprint:verdict handler above.
// This prevents the race where the user enters watch view before
// fingerprintValid is true on the server, causing sync_commands to
// be silently dropped.
//
// render() is still called here to handle the re-pick-in-watch-view
// case — if a file is loaded while already in watch view, the overlay
// needs to update immediately.

document.addEventListener('player:ready', () => {
  render()
})

// ── Main Render ──────────────────────────────────────────────────

const render = () => {
  const view = document.body.dataset.view
  if (view === 'lobby') {
    renderWsStatus()
    renderMembers()
    renderFingerprintVerdict()
  }
  if (view === 'watch') {
    renderWatch()
  }
}

document.addEventListener('room:updated', render)

// ── Startup ──────────────────────────────────────────────────────

const initFromUrl = () => {
  const match = location.pathname.match(/^\/room\/([A-Z0-9-]+)$/i)
  if (match) {
    inputJoinCode.value = match[1].toUpperCase()
  }
  showView('landing')
}

initFromUrl()