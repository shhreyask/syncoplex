// ── WebRTC — Camera Tiles ────────────────────────────────────────
//
// Owns all RTCPeerConnection objects. One per remote peer.
// Creates, updates, and removes tile <div>s in #tiles.
// Never touches <video#main-video> — movie audio cannot enter WebRTC.
//
// Public API (called by ui.js):
//   webrtc.onMemberJoined(member)
//   webrtc.onMemberReconnected(member)
//   webrtc.onMemberLeft(userId)
//   webrtc.onSecondMemberVisible()
//   webrtc.teardownAll()

// === CONFIGURATION ===

const WEBRTC_BITRATE_CAP     = 150_000  // 150 Kbps — tiles are 120×68px
const WEBRTC_ICE_POOL_SIZE   = 4        // pre-gather candidates before offer
const WEBRTC_RECONNECT_GRACE = 2500     // ms — wait before ICE restart
const WEBRTC_BACKSTOP_MS     = 30000    // ms — max time in 'disconnected'
const WEBRTC_MAX_PENDING     = 50       // ICE candidate buffer cap per peer

const WEBRTC_STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
]

// === TURN CREDENTIALS (1-hour client-side cache) ===

let turnCredentials          = null
let turnCredentialsExpiresAt = 0

const getTurnCredentials = async () => {
  if (turnCredentials && Date.now() < turnCredentialsExpiresAt - 60_000) {
    return turnCredentials
  }
  const res = await fetch('/api/turn-credentials')
  if (!res.ok) throw new Error('turn-credentials fetch failed')
  const data               = await res.json()
  turnCredentials          = data.iceServers
  turnCredentialsExpiresAt = data.expiresAt
  return turnCredentials
}

// === LOCAL STREAM (promise-cached, constrained to 320×180@24fps) ===

let localStream        = null
let localStreamPromise = null

const getLocalStream = async () => {
  if (localStream) return localStream

  if (!localStreamPromise) {
    localStreamPromise = navigator.mediaDevices.getUserMedia({
      video: {
        width:     { max: 320 },
        height:    { max: 180 },
        frameRate: { max: 24  },
      },
      audio: true,
    })
    .then(stream => {
      localStream = stream
      return stream
    })
    .catch(() => {
      localStreamPromise = null  // allow retry on next join
      return null
    })
  }

  return localStreamPromise
}

// === BITRATE CAP ===

const capVideoBitrate = async (pc) => {
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue
    const params = sender.getParameters()
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}]
    }
    params.encodings[0].maxBitrate = WEBRTC_BITRATE_CAP
    await sender.setParameters(params).catch(() => {})
  }
}

// === PEER CONNECTION MANAGEMENT ===

const peerConnections = {}
const reconnectTimers = {}
const pendingCandidates = {}

const addTracksToConnection = (pc) => {
  if (!localStream) return
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream))
}

const createPeerConnection = async (remoteUserId, iceServers) => {
  const pc = new RTCPeerConnection({
    iceServers,
    iceCandidatePoolSize: WEBRTC_ICE_POOL_SIZE,
  })
  peerConnections[remoteUserId] = pc

  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return
    // All candidates sent — IPv4 and IPv6 both. No filtering.
    wsSend('ice_candidate', { targetUserId: remoteUserId, candidate })
  }

  pc.ontrack = ({ streams }) => {
    attachRemoteTile(remoteUserId, streams[0])
  }

  pc.onconnectionstatechange = async () => {
    const state = pc.connectionState

    if (state === 'connected') {
      clearTimeout(reconnectTimers[remoteUserId])
      delete reconnectTimers[remoteUserId]
      await capVideoBitrate(pc)
    }

    if (state === 'disconnected') {
      reconnectTimers[remoteUserId] = setTimeout(() => {
        const current = peerConnections[remoteUserId]
        if (current === pc &&
           (pc.connectionState === 'disconnected' ||
            pc.connectionState === 'failed')) {
          closePeerConnection(remoteUserId)
        }
      }, WEBRTC_BACKSTOP_MS)
    }

    if (state === 'failed') {
      clearTimeout(reconnectTimers[remoteUserId])
      delete reconnectTimers[remoteUserId]
      closePeerConnection(remoteUserId)
    }
  }

  addTracksToConnection(pc)
  return pc
}

const closePeerConnection = (userId) => {
  const pc = peerConnections[userId]
  if (!pc) return
  pc.close()
  delete peerConnections[userId]
  delete pendingCandidates[userId]
  removeTile(userId)
}

// === SIGNALING — OFFER / ANSWER ===

const _onMemberJoined = async (member) => {
  if (member.userId === roomState.myUserId) return

  const [stream, iceServers] = await Promise.all([
    getLocalStream(),
    getTurnCredentials(),
  ])

  if (stream && !tilesContainer.querySelector('.tile-self')) {
    createLocalTile(stream)
  }

  await createOffer(member.userId, iceServers)
}

const createOffer = async (remoteUserId, iceServers) => {
  const pc = await createPeerConnection(remoteUserId, iceServers)
  const offer = await pc.createOffer()
  await pc.setLocalDescription(offer)
  wsSend('webrtc_offer', {
    targetUserId: remoteUserId,
    payload: pc.localDescription,
  })
  // capVideoBitrate NOT called here — remote description not set yet.
}

onMessage('webrtc_offer', async ({ senderUserId, payload: offer }) => {
  const [stream, iceServers] = await Promise.all([
    getLocalStream(),
    getTurnCredentials(),
  ])

  if (stream && !tilesContainer.querySelector('.tile-self')) {
    createLocalTile(stream)
  }

  const existingPc = peerConnections[senderUserId]

  if (existingPc && existingPc.connectionState !== 'failed') {
    // ICE restart — reuse existing PC.
    await existingPc.setRemoteDescription(new RTCSessionDescription(offer))
    drainPendingCandidates(senderUserId, existingPc)
    const answer = await existingPc.createAnswer()
    await existingPc.setLocalDescription(answer)
    await capVideoBitrate(existingPc)
    wsSend('webrtc_answer', {
      targetUserId: senderUserId,
      payload: existingPc.localDescription,
    })

  } else {
    // Fresh offer — new PC.
    if (existingPc) closePeerConnection(senderUserId)
    const pc = await createPeerConnection(senderUserId, iceServers)
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    drainPendingCandidates(senderUserId, pc)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await capVideoBitrate(pc)
    wsSend('webrtc_answer', {
      targetUserId: senderUserId,
      payload: pc.localDescription,
    })
  }
})

onMessage('webrtc_answer', async ({ senderUserId, payload: answer }) => {
  const pc = peerConnections[senderUserId]
  if (!pc) return
  await pc.setRemoteDescription(new RTCSessionDescription(answer))
  drainPendingCandidates(senderUserId, pc)
  await capVideoBitrate(pc)
})

// === ICE CANDIDATES (buffered, capped at 50) ===

onMessage('ice_candidate', async ({ senderUserId, candidate }) => {
  const pc = peerConnections[senderUserId]
  if (!pc || !pc.remoteDescription) {
    if (!pendingCandidates[senderUserId]) pendingCandidates[senderUserId] = []
    if (pendingCandidates[senderUserId].length >= WEBRTC_MAX_PENDING) return
    pendingCandidates[senderUserId].push(candidate)
    return
  }
  await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
})

const drainPendingCandidates = async (userId, pc) => {
  const queued = pendingCandidates[userId] || []
  delete pendingCandidates[userId]
  for (const candidate of queued) {
    await pc.addIceCandidate(new RTCIceCandidate(candidate)).catch(() => {})
  }
}

// === RECONNECT — TIERED LOGIC WITH 2.5s GRACE ===

const _onMemberReconnected = async (member) => {
  const existing = peerConnections[member.userId]

  if (existing && existing.connectionState === 'disconnected') {
    // Grace period — wait 2.5s before sending ICE restart offer.
    await new Promise(resolve => setTimeout(resolve, WEBRTC_RECONNECT_GRACE))

    if (existing.connectionState === 'connected') {
      return  // self-recovered
    }
    if (existing.connectionState !== 'disconnected') {
      return  // moved to 'failed' — that handler took over
    }

    clearTimeout(reconnectTimers[member.userId])
    delete reconnectTimers[member.userId]
    delete pendingCandidates[member.userId]

    const offer = await existing.createOffer({ iceRestart: true })
    await existing.setLocalDescription(offer)
    wsSend('webrtc_offer', {
      targetUserId: member.userId,
      payload: existing.localDescription,
    })

  } else {
    // PC gone — full re-offer.
    if (existing) closePeerConnection(member.userId)

    const [, iceServers] = await Promise.all([
      getLocalStream(),
      getTurnCredentials(),
    ])
    await createOffer(member.userId, iceServers)
  }
}

// === TILE LIFECYCLE ===

const tilesContainer = document.getElementById('tiles')

const createLocalTile = (stream) => {
  const tile          = document.createElement('div')
  tile.className      = 'tile tile-self'
  tile.dataset.userId = roomState.myUserId

  const video         = document.createElement('video')
  video.srcObject     = stream
  video.autoplay      = true
  video.muted         = true       // always muted — prevents feedback
  video.playsInline   = true

  const label         = document.createElement('span')
  label.className     = 'tile-label'
  label.textContent   = (roomState.myName || 'You') + ' (you)'

  tile.append(video, label)
  tilesContainer.append(tile)
}

const attachRemoteTile = (userId, stream) => {
  let tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
  if (!tile) {
    tile                = document.createElement('div')
    tile.className      = 'tile'
    tile.dataset.userId = userId

    const video         = document.createElement('video')
    video.autoplay      = true
    video.playsInline   = true

    const label         = document.createElement('span')
    label.className     = 'tile-label'
    const member        = roomState.members.find(m => m.userId === userId)
    label.textContent   = member ? member.name : userId

    tile.append(video, label)
    tilesContainer.append(tile)
  }
  tile.querySelector('video').srcObject = stream
}

const removeTile = (userId) => {
  const tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
  if (tile) tile.remove()
}

// === PUBLIC API ===

const webrtc = {

  onSecondMemberVisible: () => {
    getTurnCredentials().catch(() => {})
  },

  onMemberJoined: async (member) => {
    if (member.userId === roomState.myUserId) return
    await _onMemberJoined(member)
  },

  onMemberReconnected: async (member) => {
    if (member.userId === roomState.myUserId) return
    await _onMemberReconnected(member)
  },

  onMemberLeft: (userId) => {
    clearTimeout(reconnectTimers[userId])
    delete reconnectTimers[userId]
    closePeerConnection(userId)
  },

  teardownAll: () => {
    Object.keys(reconnectTimers).forEach(uid => clearTimeout(reconnectTimers[uid]))
    Object.keys(peerConnections).forEach(uid => closePeerConnection(uid))
    if (localStream) {
      localStream.getTracks().forEach(t => t.stop())
      localStream        = null
      localStreamPromise = null
    }
    tilesContainer.innerHTML = ''
    turnCredentials          = null
    turnCredentialsExpiresAt = 0
  },
}

window.addEventListener('beforeunload', () => webrtc.teardownAll())