// ── WebSocket Client ─────────────────────────────────────────────
//
// Owns the WebSocket connection exclusively.
// Nothing else in the app touches the WebSocket object.
//
// Flow:
//   connect(roomCode, name)
//     → opens /ws/:code
//     → sends join message immediately
//     → receives session_token, session_init, room_state
//     → registers handlers for user_joined, user_left, user_reconnected
//
// On disconnect: exponential backoff with jitter, auto-reconnects.

// ── Internal State ───────────────────────────────────────────────

let ws            = null
let reconnectAttempt = 0
let reconnectTimer   = null
let manualClose      = false  // true when user explicitly leaves — suppresses reconnect

// ── Backoff ──────────────────────────────────────────────────────

const getBackoff = (attempt) => {
  const base   = Math.min(500 * Math.pow(2, attempt), 5000) // cap at 5s
  const jitter = Math.random() * 500
  return base + jitter
}

// ── Message Handlers Registry ────────────────────────────────────
//
// Other modules register handlers via onMessage(type, fn).
// ws.js routes incoming messages to them by type.
// Unknown types are silently dropped.

const handlers = {}

const onMessage = (type, fn) => {
  handlers[type] = fn
}

// ── Send ─────────────────────────────────────────────────────────

const wsSend = (type, payload) => {
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  ws.send(JSON.stringify({ type, payload }))
}

// ── Input Validation ─────────────────────────────────────────────

const validateName = (name) => {
  name = name.trim().replace(/<[^>]*>/g, '') // strip HTML tags
  if (name.length === 0 || name.length > 32) return null
  return name
}

const validateRoomCode = (code) => {
  code = code.trim().toUpperCase()
  // Format: WORD-WORD-DIGITS  e.g. WOLF-BEAR-482134
  if (!/^[A-Z]+-[A-Z]+-[0-9]+$/.test(code)) return null
  return code
}

// ── Join Message ─────────────────────────────────────────────────
//
// Called once the WebSocket is open.
// If a session token exists in sessionStorage it is included —
// the server will restore the session transparently.

const sendJoin = (name) => {
  const payload = { name }
  const token = loadSessionToken()
  if (token) payload.sessionToken = token
  wsSend('join', payload)
}

// ── Connect ──────────────────────────────────────────────────────

const connect = (roomCode, name) => {
  if (ws) {
    ws.onclose = null  // prevent the old socket triggering reconnect
    ws.close()
  }

  manualClose = false
  setWsStatus('connecting')

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  const url      = `${protocol}//${location.host}/ws/${roomCode}`

  ws = new WebSocket(url)

  ws.onopen = () => {
    reconnectAttempt = 0
    setWsStatus('connected')
    sendJoin(name)
  }

  ws.onmessage = (event) => {
    let msg
    try {
      msg = JSON.parse(event.data)
    } catch {
      return // malformed — drop
    }

    if (typeof msg.type !== 'string') return
    if (handlers[msg.type]) handlers[msg.type](msg.payload ?? {})
    // Unknown types silently dropped
  }

  ws.onclose = () => {
    ws = null
    if (manualClose) {
      setWsStatus('disconnected')
      return
    }
    setWsStatus('disconnected')
    scheduleReconnect(roomCode, name)
  }

  ws.onerror = () => {
    // onerror always fires before onclose — let onclose drive reconnect logic
    ws?.close()
  }
}

// ── Reconnect ────────────────────────────────────────────────────

const scheduleReconnect = (roomCode, name) => {
  const delay = getBackoff(reconnectAttempt)
  reconnectAttempt++
  reconnectTimer = setTimeout(() => connect(roomCode, name), delay)
}

// ── Disconnect (manual leave) ────────────────────────────────────

const disconnect = () => {
  manualClose = true
  clearTimeout(reconnectTimer)
  if (ws) {
    ws.onclose = null
    ws.close()
    ws = null
  }
  setWsStatus('disconnected')
  clearSessionToken()
}

// ── Built-in Message Handlers ────────────────────────────────────
//
// These are core protocol messages handled entirely inside ws.js.
// UI-relevant state changes go through roomState + notifyUpdate()
// so ui.js re-renders without being called directly.

onMessage('session_token', (payload) => {
  if (payload.sessionToken) saveSessionToken(payload.sessionToken)
})

onMessage('session_init', (payload) => {
  if (payload.userId) roomState.myUserId = payload.userId
  // no notifyUpdate here — room_state arrives immediately after and will trigger it
})

onMessage('room_state', (payload) => {
  setMembers(payload.members ?? [])
  // playback applied in sync.js (step 4) — ignored here for now
})

onMessage('user_joined', (payload) => {
  addMember(payload.userId, payload.name)
})

onMessage('user_left', (payload) => {
  removeMember(payload.userId)
})

onMessage('user_reconnected', (payload) => {
  // Treat like a join — addMember is a no-op if already present
  addMember(payload.userId, payload.name)
})

onMessage('error', (payload) => {
  console.error('syncoplex server error:', payload.code, payload.message)
  // ui.js surfaces errors by reading roomState — for now log only
})