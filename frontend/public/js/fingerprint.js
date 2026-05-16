// fingerprint.js — main-thread coordinator.
// Concatenated into app.js after sync.js and before ui.js.
// Owns: Worker lifecycle, hash storage, wsSend, verdict handling, timeout.
// Does NOT own: UI rendering, Join button, video element, WebSocket connection.

let fingerprintWorker  = null
let fingerprintTimeout = null

// Called by ws.js onclose — cancels any in-flight server-verdict timeout
// so a stale timeout can't overwrite a verdict that arrives after reconnect.
const cancelFingerprintTimeout = () => {
    clearTimeout(fingerprintTimeout)
    fingerprintTimeout = null
}

const computeAndSendFingerprint = (file) => {
    // Tear down any in-progress fingerprint before starting a new one.
    if (fingerprintWorker) { fingerprintWorker.terminate(); fingerprintWorker = null }
    clearTimeout(fingerprintTimeout)

    roomState.fileVerdict      = FILE_VERDICTS.PENDING
    roomState.fileVerdictError = null
    notifyUpdate()

    fingerprintWorker = new Worker('/js/worker-fingerprint.js')

    fingerprintWorker.onmessage = ({ data: { hex } }) => {
        clearTimeout(fingerprintTimeout)
        fingerprintWorker.terminate()
        fingerprintWorker = null

        roomState.fileHash = hex   // stored for reconnect re-send
        if (roomState.wsStatus === 'connected') {
            wsSend('file_fingerprint', { fingerprint: hex })
        }
        // fileVerdict stays PENDING until server replies with fingerprint_verdict.
        notifyUpdate()

        // Start a new timeout for the server verdict leg.
        // The Worker timeout covered hashing; this one covers the round-trip.
        fingerprintTimeout = setTimeout(() => {
            roomState.fileVerdictError = 'Verification timed out. Try picking your file again.'
            roomState.fileVerdict      = FILE_VERDICTS.PENDING
            notifyUpdate()
        }, 15000)
    }

    fingerprintWorker.onerror = () => {
        clearTimeout(fingerprintTimeout)
        fingerprintWorker = null
        roomState.fileVerdictError = 'Could not read your file. Try picking it again.'
        roomState.fileVerdict      = FILE_VERDICTS.PENDING
        notifyUpdate()
    }

    fingerprintWorker.postMessage({ file })

    // 15-second timeout covers Worker stall/crash.
    fingerprintTimeout = setTimeout(() => {
        if (fingerprintWorker) { fingerprintWorker.terminate(); fingerprintWorker = null }
        roomState.fileVerdictError = 'Verification timed out. Try picking your file again.'
        roomState.fileVerdict      = FILE_VERDICTS.PENDING
        notifyUpdate()
    }, 15000)
}

// Triggered by player.js whenever a new file is loaded.
document.addEventListener('player:fileloaded', (e) => {
    computeAndSendFingerprint(e.detail.file)
})

// Handle verdict from server.
onMessage('fingerprint_verdict', ({ verdict }) => {
    clearTimeout(fingerprintTimeout)   // verdict arrived — cancel timeout
    fingerprintTimeout = null
    roomState.fileVerdict      = verdict === 'valid' ? FILE_VERDICTS.VALID : FILE_VERDICTS.MISMATCH
    roomState.fileVerdictError = null
    notifyUpdate()
    document.dispatchEvent(new CustomEvent('fingerprint:verdict', {
        detail: { verdict: roomState.fileVerdict }
    }))
})