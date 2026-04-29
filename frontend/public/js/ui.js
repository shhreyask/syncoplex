// ── UI Layer ─────────────────────────────────────────────────────
//
// Listens for 'room:updated' and re-renders affected components.
// Never imports or calls ws.js directly — all communication goes
// through roomState and wsSend().
//
// Owns:
//   - View transitions (landing → lobby → watch)
//   - Landing: create room, join room
//   - Lobby: name input, member list, WS status, copy code, leave

// ── Element References ───────────────────────────────────────────

const $ = (id) => document.getElementById(id)

// Landing
const viewLanding      = $('view-landing')
const btnCreate        = $('btn-create')
const inputJoinCode    = $('input-join-code')
const btnJoin          = $('btn-join')
const landingError     = $('landing-error')

// Lobby
const viewLobby        = $('view-lobby')
const lobbyRoomCode    = $('lobby-room-code')
const btnCopyCode      = $('btn-copy-code')
const inputName        = $('input-name')
const btnSetName       = $('btn-set-name')
const lobbyError       = $('lobby-error')
const wsStatusDot      = $('ws-status-indicator')
const wsStatusLabel    = $('ws-status-label')
const membersList      = $('members-list')
const btnLeaveLobby    = $('btn-leave-lobby')

// Reconnect pill (injected into body)
const reconnectPill    = (() => {
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

const enterLobby = (roomCode, name) => {
  roomState.roomCode = roomCode
  setMyName(name)
  lobbyRoomCode.textContent = roomCode
  showView('lobby')
  connect(roomCode, name)
}

btnCreate.addEventListener('click', async () => {
  clearError(landingError)
  btnCreate.disabled = true
  btnCreate.textContent = 'Creating…'

  try {
    const res = await fetch('/rooms', { method: 'POST' })
    if (!res.ok) throw new Error(`Server returned ${res.status}`)
    const data = await res.json()

    // Push room URL so the code is bookmarkable
    history.pushState({}, '', `/room/${data.roomCode}`)

    const name = promptName()
    if (!name) {
      history.pushState({}, '', '/')
      return
    }

    enterLobby(data.roomCode, name)
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
    if (res.status === 404) { showError(landingError, 'Room not found.'); return }
    if (res.status === 403) { showError(landingError, 'Room is full.'); return }
    if (!res.ok) throw new Error(`Server returned ${res.status}`)

    const data = await res.json()
    if (data.full) { showError(landingError, 'Room is full.'); return }

    const name = promptName()
    if (!name) return

    history.pushState({}, '', `/room/${code}`)
    enterLobby(code, name)
  } catch (err) {
    showError(landingError, 'Could not reach server.')
    console.error(err)
  } finally {
    btnJoin.disabled = false
    btnJoin.textContent = 'Join'
  }
}

// Simple inline prompt — replaced with a proper UI field in lobby
// This is just to get a name before connecting; the lobby lets them change it
const promptName = () => {
  const raw = window.prompt('Your display name (max 32 chars):')
  if (raw === null) return null  // user cancelled
  const name = validateName(raw)
  if (!name) {
    alert('Name cannot be empty or over 32 characters.')
    return null
  }
  return name
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
  // Reconnect with new name — server will treat as fresh join
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
  roomState.roomCode  = null
  roomState.myUserId  = null
  roomState.myName    = null
  roomState.members   = []
  history.pushState({}, '', '/')
  showView('landing')
})

// ── Member List Renderer ─────────────────────────────────────────

const renderMembers = () => {
  const all = [
    // Self first — synthesised from roomState identity
    ...(roomState.myUserId ? [{
      userId:   roomState.myUserId,
      name:     roomState.myName ?? 'You',
      isSelf:   true,
    }] : []),
    // Others from members array
    ...roomState.members.map(m => ({ ...m, isSelf: false })),
  ]

  membersList.innerHTML = ''
  all.forEach(({ userId, name, isSelf }) => {
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
    // Only show pill if we were previously connected (i.e. a reconnect)
    if (roomState.myUserId) reconnectPill.classList.add('visible')
  } else {
    wsStatusDot.classList.add('status-disconnected')
    wsStatusLabel.textContent = 'Disconnected'
  }
}

// ── Main Render ──────────────────────────────────────────────────
//
// Called on every 'room:updated' event.
// Only renders components relevant to the current view.

const render = () => {
  const view = document.body.dataset.view

  if (view === 'lobby') {
    renderWsStatus()
    renderMembers()
  }
}

document.addEventListener('room:updated', render)

// ── Startup — Parse URL ──────────────────────────────────────────
//
// If the URL is /room/:code the user landed directly on a room link.
// Show the landing view so they can enter their name and join.
// The room code is pre-filled in the join input for them.

const initFromUrl = () => {
  const match = location.pathname.match(/^\/room\/([A-Z0-9-]+)$/i)
  if (match) {
    const code = match[1].toUpperCase()
    inputJoinCode.value = code
    showView('landing')
  } else {
    showView('landing')
  }
}

initFromUrl()