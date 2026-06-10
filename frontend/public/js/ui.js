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
//   user picks file → fileVerify computed → server verdict arrives
//   verdict === 'valid' → camera/mic permission prompted → showView('watch')
//   verdict === 'mismatch' → red error above button, re-pick on click

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
const fileVerifySpinner = $('fileVerify-spinner')
const fileVerifyError   = $('fileVerify-error')

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

    history.pushState({ view: 'lobby' }, '', `/room/${roomCode}`)  
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

    history.pushState({ view: 'lobby' }, '', `/room/${code}`)  
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
  const shareUrl = `${location.origin}/room/${roomState.roomCode}`
  navigator.clipboard.writeText(shareUrl).then(() => {
    btnCopyCode.textContent = '✓'
    setTimeout(() => { btnCopyCode.textContent = '⎘' }, 1500)
  })
})

btnLeaveLobby.addEventListener('click', () => {  
  history.back()
})

// "Pick File & Watch" — visible only when connected.
// No permission prompt here — permissions are asked after the file
// verdict comes back valid, right before entering watch view.
btnPickFile.addEventListener('click', () => player.openPicker())

// ── WebRTC Wiring ────────────────────────────────────────────────
//
// These onMessage calls register additional handlers for message types
// that ws.js already handles (addMember, removeMember). ws.js's
// onMessage supports multiple handlers per type — both fire in order.

let secondMemberNotified = false

onMessage('user_joined', (payload) => {
  webrtc.onMemberJoined({ userId: payload.userId, name: payload.name })

  // Warm TURN cache when the second member appears in the room.
  // members array does not include self, so length >= 1 means 2+ people.
  if (!secondMemberNotified && roomState.members.length >= 1) {
    secondMemberNotified = true
    webrtc.onSecondMemberVisible()
  }
})

onMessage('user_reconnected', (payload) => {
  webrtc.onMemberReconnected({ userId: payload.userId, name: payload.name })
})

onMessage('user_left', (payload) => {
  webrtc.onMemberLeft(payload.userId)
})

// Also check on room_state (initial snapshot) — if we join a room that
// already has members, warm the TURN cache immediately.
onMessage('room_state', () => {
  if (!secondMemberNotified && roomState.members.length >= 1) {
    secondMemberNotified = true
    webrtc.onSecondMemberVisible()
  }
})

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

const renderFingerprintVerdict = () => {
  const verdict = roomState.fileVerdict
  const error   = roomState.fileVerdictError
  const hasFile = roomState.fileHash !== null

  fileVerifySpinner.hidden = true
  fileVerifySpinner.classList.remove('fileVerify-pending')
  clearError(fileVerifyError)

  if (verdict === FILE_VERDICTS.MISMATCH) {
    showError(fileVerifyError, "This file doesn't match the room. Choose the correct version.")

  } else if (verdict === FILE_VERDICTS.PENDING) {
    if (error) {
      showError(fileVerifyError, error)
    } else if (hasFile) {
      fileVerifySpinner.classList.add('fileVerify-pending')
      fileVerifySpinner.hidden = false
    }
  }
}

// ── Auto-transition on valid verdict ─────────────────────────────
//
// When the file verdict is valid, ask for camera/mic permissions
// BEFORE transitioning to watch view. If denied, the user still
// enters watch — they just get a black tile.

let pendingWatchTransition = false

const tryEnterWatch = async () => {
  const ready = roomState.fileState !== FILE_STATES.WAITING &&
                roomState.fileState !== FILE_STATES.HASHING
  if (roomState.fileVerdict === FILE_VERDICTS.VALID && ready) {
    await webrtc.requestPermissions()
    history.pushState({ view: 'watch' }, '', location.pathname)  
    showView('watch')
    render()
    pendingWatchTransition = false
    // Now that we're in watch view with permissions settled,
    // connect to everyone already in the room.
    webrtc.connectToExistingMembers(roomState.members)
  } else {
    pendingWatchTransition = true
  }
}

document.addEventListener('fileVerify:verdict', (e) => {
  if (e.detail.verdict === FILE_VERDICTS.VALID) {
    tryEnterWatch()
  }
})

// ── Watch View Renderer ──────────────────────────────────────────

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

// ── Controls Auto-Hide ───────────────────────────────────────────

let hideTimer
let controlsVisible = true

const resetHideTimer = () => {
  if (document.body.dataset.view !== 'watch') return
  const webrtcControls = document.getElementById('webrtc-controls')
  if (!controlsVisible) {
    controlsBar.classList.remove('hidden')
    if (webrtcControls) webrtcControls.classList.remove('hidden')
    controlsVisible = true
  }
  clearTimeout(hideTimer)
  hideTimer = setTimeout(() => {
    if (!video.paused) {
      controlsBar.classList.add('hidden')
      if (webrtcControls) webrtcControls.classList.add('hidden')
      controlsVisible = false
    }
  }, 3000)
}

document.addEventListener('mousemove',  resetHideTimer)
document.addEventListener('touchstart', resetHideTimer, { passive: true })

// ── Keyboard Shortcuts ───────────────────────────────────────────

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

document.addEventListener('player:ready', () => {
  if (pendingWatchTransition) tryEnterWatch()
  render()
})

// ── Browser Back Button ──────────────────────────────────────────  
//
// History stack: landing → lobby (/room/CODE) → watch (/room/CODE)
// Back from watch returns to lobby (WS stays alive, file state resets).
// Back from lobby returns to landing (full disconnect).

window.addEventListener('popstate', () => {
  const currentView = document.body.dataset.view

  if (currentView === 'watch') {
    // watch → lobby: tear down WebRTC + file, keep WS alive
    webrtc.teardownAll()
    video.pause()
    pendingWatchTransition     = false
    roomState.file             = null
    if (roomState.blobUrl) {
      URL.revokeObjectURL(roomState.blobUrl)
      roomState.blobUrl = null
    }
    roomState.fileReady        = false
    roomState.fileHash         = null
    roomState.fileState        = FILE_STATES.WAITING
    roomState.fileVerdict      = FILE_VERDICTS.PENDING
    roomState.fileVerdictError = null
    roomState.playback         = { playing: false, position: 0, serverTime: null }
    showView('lobby')
    notifyUpdate()
    return
  }

  if (currentView === 'lobby') {
    // lobby → landing: full teardown
    webrtc.teardownAll()
    disconnect()
    resetRoomState()
    showView('landing')
    return
  }
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
    // Highlight Join as the primary action when URL has a room code
    btnJoin.classList.remove('btn-secondary')
    btnJoin.classList.add('btn-primary')
    btnCreate.classList.remove('btn-primary')
    btnCreate.classList.add('btn-secondary')
  }
  history.replaceState({ view: 'landing' }, '', location.pathname)  
  showView('landing')
}

initFromUrl()