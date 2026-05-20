// ── WebRTC — Camera Tiles ────────────────────────────────────────
//
// Owns all RTCPeerConnection objects. One per remote peer.
// Creates, updates, and removes tile <div>s in #tiles.
// Never touches <video#main-video> — movie audio cannot enter WebRTC.
//
// Public API (called by ui.js):
//   webrtc.requestPermissions()
//   webrtc.connectToExistingMembers(members)
//   webrtc.onMemberJoined(member)
//   webrtc.onMemberReconnected(member)
//   webrtc.onMemberLeft(userId)
//   webrtc.onSecondMemberVisible()
//   webrtc.teardownAll()

// === CONFIGURATION ===

const WEBRTC_BITRATE_CAP     = 150_000
const WEBRTC_ICE_POOL_SIZE   = 4
const WEBRTC_RECONNECT_GRACE = 2500
const WEBRTC_BACKSTOP_MS     = 30000
const WEBRTC_MAX_PENDING     = 50

// === STATE ===

// webrtcReady gates outbound signaling. Set to true after
// requestPermissions() resolves. Inbound offers (webrtc_offer)
// are always handled — so we can answer someone who's already
// in watch view while we're still joining.
let webrtcReady = false

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
let permissionDenied   = false

const getLocalStream = async () => {
  if (localStream) return localStream
  if (permissionDenied) return null

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
      permissionDenied = false
      return stream
    })
    .catch(() => {
      localStreamPromise = null
      permissionDenied = true
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
  // Don't initiate outbound offers until we're in watch view
  // with permissions settled. Inbound offers are always answered.
  if (!webrtcReady) return

  const [stream, iceServers] = await Promise.all([
    getLocalStream(),
    getTurnCredentials(),
  ])

  if (!tilesContainer.querySelector('.tile-self')) {
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
}

// Inbound offers are ALWAYS handled — even before webrtcReady.
// This lets us answer offers from users already in watch view
// while we're still joining.
onMessage('webrtc_offer', async ({ senderUserId, payload: offer }) => {
  const [stream, iceServers] = await Promise.all([
    getLocalStream(),
    getTurnCredentials(),
  ])

  if (!tilesContainer.querySelector('.tile-self')) {
    createLocalTile(stream)
  }

  const existingPc = peerConnections[senderUserId]

  if (existingPc && existingPc.connectionState !== 'failed') {
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
    if (existingPc) closePeerConnection(senderUserId)
    const pc = await createPeerConnection(senderUserId, iceServers)
    await pc.setRemoteDescription(new RTCSessionDescription(offer))
    drainPendingCandidates(senderUserId, pc)
    const answer = await pc.createAnswer()
    await pc.setLocalDescription(answer)
    await capVideoBitrate(pc)
    wsSend('webrtc_answer', { targetUserId: senderUserId, payload: pc.localDescription })
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
  if (!webrtcReady) return

  const existing = peerConnections[member.userId]

  if (existing && existing.connectionState === 'disconnected') {
    await new Promise(resolve => setTimeout(resolve, WEBRTC_RECONNECT_GRACE))

    if (existing.connectionState === 'connected') return
    if (existing.connectionState !== 'disconnected') return

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
  video.autoplay      = true
  video.muted         = true
  video.playsInline   = true

  if (stream) {
    video.srcObject = stream
  } else {
    tile.classList.add('tile-cam-off')
  }

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

  const videoEl = tile.querySelector('video')
  videoEl.srcObject = stream

  const hasVideo = stream && stream.getVideoTracks().length > 0 &&
                   stream.getVideoTracks().some(t => t.enabled)
  tile.classList.toggle('tile-cam-off', !hasVideo)

  if (stream) {
    stream.getVideoTracks().forEach(track => {
      track.onmute   = () => tile.classList.add('tile-cam-off')
      track.onunmute = () => tile.classList.remove('tile-cam-off')
    })
  }
}

const ensureRemoteTile = (userId, name) => {
  if (tilesContainer.querySelector(`[data-user-id="${userId}"]`)) return
  const tile          = document.createElement('div')
  tile.className      = 'tile tile-cam-off'
  tile.dataset.userId = userId

  const video         = document.createElement('video')
  video.autoplay      = true
  video.playsInline   = true

  const label         = document.createElement('span')
  label.className     = 'tile-label'
  label.textContent   = name || userId

  tile.append(video, label)
  tilesContainer.append(tile)
}

const removeTile = (userId) => {
  const tile = tilesContainer.querySelector(`[data-user-id="${userId}"]`)
  if (tile) tile.remove()
}

// === MEDIA CONTROLS OVERLAY (right edge of window) ===

const controlsOverlay = (() => {
  const panel = document.createElement('div')
  panel.id = 'webrtc-controls'
  panel.addEventListener('click',       (e) => e.stopPropagation())
  panel.addEventListener('mousedown',   (e) => e.stopPropagation())
  panel.addEventListener('pointerdown', (e) => e.stopPropagation())

  const btnMic = document.createElement('button')
  btnMic.className = 'wc-btn'
  btnMic.textContent = '🎤'
  btnMic.title = 'Toggle microphone'
  btnMic.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!localStream) return
    const track = localStream.getAudioTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    btnMic.textContent = track.enabled ? '🎤' : '🔇'
    btnMic.classList.toggle('wc-btn-off', !track.enabled)
  })

  const btnVid = document.createElement('button')
  btnVid.className = 'wc-btn'
  btnVid.textContent = '📹'
  btnVid.title = 'Toggle camera'
  btnVid.addEventListener('click', (e) => {
    e.stopPropagation()
    if (!localStream) return
    const track = localStream.getVideoTracks()[0]
    if (!track) return
    track.enabled = !track.enabled
    btnVid.textContent = track.enabled ? '📹' : '🚫'
    btnVid.classList.toggle('wc-btn-off', !track.enabled)
    const selfTile = tilesContainer.querySelector('.tile-self')
    if (selfTile) selfTile.classList.toggle('tile-cam-off', !track.enabled)
  })

  const btnLeave = document.createElement('button')
  btnLeave.className = 'wc-btn wc-btn-leave'
  btnLeave.textContent = '✕'
  btnLeave.title = 'Leave room'
  btnLeave.addEventListener('click', (e) => {
    e.stopPropagation()
    webrtc.teardownAll()
    disconnect()
    resetRoomState()
    history.pushState({}, '', '/')
    showView('landing')
  })

  panel.append(btnMic, btnVid, btnLeave)
  document.getElementById('view-watch').appendChild(panel)
  return panel
})()

// === PUBLIC API ===

const webrtc = {

  requestPermissions: async () => {
    await getLocalStream()
    webrtcReady = true
  },

  // Called by ui.js after entering watch view.
  // Sends offers to everyone already in the room.
  connectToExistingMembers: async (members) => {
    if (!webrtcReady) return

    const [stream, iceServers] = await Promise.all([
      getLocalStream(),
      getTurnCredentials(),
    ])

    if (!tilesContainer.querySelector('.tile-self')) {
      createLocalTile(stream)
    }

    for (const member of members) {
      if (member.userId === roomState.myUserId) continue
      if (peerConnections[member.userId]) continue  // already connected
      ensureRemoteTile(member.userId, member.name)
      await createOffer(member.userId, iceServers)
    }
  },

  onSecondMemberVisible: () => {
    getTurnCredentials().catch(() => {})
  },

  onMemberJoined: async (member) => {
    if (member.userId === roomState.myUserId) return
    ensureRemoteTile(member.userId, member.name)
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
    permissionDenied = false
    webrtcReady      = false
    tilesContainer.innerHTML = ''
    turnCredentials          = null
    turnCredentialsExpiresAt = 0
  },
}

window.addEventListener('beforeunload', () => webrtc.teardownAll())