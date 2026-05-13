// ── File States ──────────────────────────────────────────────────
const FILE_STATES = {
  WAITING:  'waiting',
  HASHING:  'hashing',
  MISMATCH: 'mismatch',
  READY:    'ready',
  PLAYING:  'playing',
  PAUSED:   'paused',
}

// ── File Verdicts ─────────────────────────────────────────────────
// Tracks the server's verdict on the fingerprint hash.
// Independent of FILE_STATES — a file can be READY but MISMATCH.
const FILE_VERDICTS = {
  PENDING:  'pending',   // hash computing, in-flight to server, or awaiting re-pick
  VALID:    'valid',     // server confirmed match
  MISMATCH: 'mismatch',  // server rejected — wrong file
}

// ── Single Source of Truth ───────────────────────────────────────
const roomState = {
  // Identity
  myUserId:     null,
  myName:       null,
  sessionToken: null,

  // Room
  roomCode:     null,
  members:      [], // [{ userId, name, fileReady }]

  // Playback
  playback: {
    playing:    false,
    position:   0,
    serverTime: null,
  },

  // File
  file:             null,
  blobUrl:          null,
  fileReady:        false,
  fileHash:         null,   // hex string — stored for reconnect re-send
  fileState:        FILE_STATES.WAITING,

  // Fingerprint verdict
  fileVerdict:      FILE_VERDICTS.PENDING,  // 'pending' | 'valid' | 'mismatch'
  fileVerdictError: null,                   // string | null — shown on timeout or Worker crash

  // Connection
  wsStatus: 'disconnected', // 'disconnected' | 'connecting' | 'connected'
}

// ── Event Bus ────────────────────────────────────────────────────
//
// Any module that changes roomState calls notifyUpdate().
// ui.js listens for 'room:updated' and re-renders.
// ws.js and ui.js never reference each other directly.

const notifyUpdate = () => {
  document.dispatchEvent(new CustomEvent('room:updated'))
}

//Single reset call
const resetRoomState = () => {
    roomState.roomCode        = null
    roomState.myUserId        = null
    roomState.myName          = null
    roomState.sessionToken    = null
    roomState.members         = []
    roomState.playback        = { playing: false, position: 0, serverTime: null }
    roomState.file            = null
    if (roomState.blobUrl) URL.revokeObjectURL(roomState.blobUrl)
    roomState.blobUrl         = null
    roomState.fileReady       = false
    roomState.fileHash        = null
    roomState.fileState       = FILE_STATES.WAITING
    roomState.fileVerdict     = FILE_VERDICTS.PENDING
    roomState.fileVerdictError = null
    // one notifyUpdate() at the end, not one per field
    notifyUpdate()
}

// ── State Helpers ────────────────────────────────────────────────

const setWsStatus = (status) => {
  roomState.wsStatus = status
  notifyUpdate()
}

const setFileState = (state) => {
  roomState.fileState = state
  notifyUpdate()
}

const setMyName = (name) => {
  roomState.myName = name
  notifyUpdate()
}

// Add a member — no-op if already present
const addMember = (userId, name) => {
  if (roomState.members.find(m => m.userId === userId)) return
  roomState.members.push({ userId, name, fileReady: false })
  notifyUpdate()
}

// Remove a member by userId
const removeMember = (userId) => {
  roomState.members = roomState.members.filter(m => m.userId !== userId)
  notifyUpdate()
}

// Replace the full member list (used on room_state snapshot)
const setMembers = (list) => {
  roomState.members = list.map(m => ({ userId: m.userId, name: m.name, fileReady: false }))
  notifyUpdate()
}

// ── Session Token Persistence ────────────────────────────────────
//
// sessionStorage: survives tab refresh, cleared on tab close.
// Matches backend session semantics exactly.

const SESSION_KEY = 'syncoplex_token'

const saveSessionToken = (token) => {
  roomState.sessionToken = token
  sessionStorage.setItem(SESSION_KEY, token)
}

const loadSessionToken = () => {
  return sessionStorage.getItem(SESSION_KEY)
}

const clearSessionToken = () => {
  roomState.sessionToken = null
  sessionStorage.removeItem(SESSION_KEY)
}

// ── Utilities ────────────────────────────────────────────────────

const formatTime = (seconds) => {
  if (!seconds || isNaN(seconds)) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
  return `${m}:${String(s).padStart(2, '0')}`
}