// ── UI Layer ─────────────────────────────────────────────────────
//
// Listens for 'room:updated' and re-renders affected components.
// Never calls ws.js directly — all communication goes through
// roomState and wsSend().
//
// Flow:
//   Landing → Create/Join → Lobby (no connection yet)
//   User enters name → clicks Set Name → WebSocket connects

// ── Element References ───────────────────────────────────────────

const $ = (id) => document.getElementById(id)

// Landing
const btnCreate     = $('btn-create')
const inputJoinCode = $('input-join-code')
const btnJoin       = $('btn-join')
const landingError  = $('landing-error')

// Lobby
const lobbyRoomCode = $('lobby-room-code')
const btnCopyCode   = $('btn-copy-code')
const inputName     = $('input-name')
const btnSetName    = $('btn-set-name')
const lobbyError    = $('lobby-error')
const wsStatusDot   = $('ws-status-indicator')
const wsStatusLabel = $('ws-status-label')
const membersList   = $('members-list')
const btnLeaveLobby = $('btn-leave-lobby')

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
//
// enterLobby only sets state and switches view.
// No WebSocket connection is made here.
// The user connects by entering a name and clicking Set Name.

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
//
// Set Name is the single action that:
//   1. Validates the name
//   2. Stores it in roomState
//   3. Opens the WebSocket connection
//
// If already connected (name change), it disconnects and reconnects.

btnSetName.addEventListener('click', () => {
  const name = validateName(inputName.value)
  if (!name) {
    showError(lobbyError, 'Name must be 1–32 characters.')
    return
  }
  clearError(lobbyError)
  setMyName(name)

  // Disconnect first in case this is a name change mid-session
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
  } else if (status === 'connecting') {
    wsStatusDot.classList.add('status-connecting')
    wsStatusLabel.textContent = 'Connecting…'
    if (roomState.myUserId) reconnectPill.classList.add('visible')
  } else {
    wsStatusDot.classList.add('status-disconnected')
    wsStatusLabel.textContent = 'Disconnected'
  }
}

// ── Main Render ──────────────────────────────────────────────────

const render = () => {
  const view = document.body.dataset.view
  if (view === 'lobby') {
    renderWsStatus()
    renderMembers()
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