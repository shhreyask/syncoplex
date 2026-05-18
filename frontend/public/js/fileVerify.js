// fileVerify.js — main-thread coordinator.
// Concatenated into app.js after sync.js and before ui.js.
// Owns: Worker lifecycle, hash storage, wsSend, verdict handling, timeout.
// Does NOT own: UI rendering, Join button, video element, WebSocket connection.

let fileVerifyWorker  = null
let fileVerifyTimeout = null

// Called by ws.js onclose — cancels any in-flight server-verdict timeout
// so a stale timeout can't overwrite a verdict that arrives after reconnect.
const cancelFingerprintTimeout = () => {
    clearTimeout(fileVerifyTimeout)
    fileVerifyTimeout = null
}

const computeAndSendFingerprint = (file) => {
    // Tear down any in-progress fileVerify before starting a new one.
    if (fileVerifyWorker) { fileVerifyWorker.terminate(); fileVerifyWorker = null }
    clearTimeout(fileVerifyTimeout)

    roomState.fileVerdict      = FILE_VERDICTS.PENDING
    roomState.fileVerdictError = null
    notifyUpdate()

    fileVerifyWorker = new Worker('/js/workerFileVerify.js')

    fileVerifyWorker.onmessage = ({ data: { hex } }) => {
        clearTimeout(fileVerifyTimeout)
        fileVerifyWorker.terminate()
        fileVerifyWorker = null

        roomState.fileHash = hex   // stored for reconnect re-send
        if (roomState.wsStatus === 'connected') {
            wsSend('file_fileVerify', { fileVerify: hex })
        }
        // fileVerdict stays PENDING until server replies with fileVerify_verdict.
        notifyUpdate()

        // Start a new timeout for the server verdict leg.
        // The Worker timeout covered hashing; this one covers the round-trip.
        fileVerifyTimeout = setTimeout(() => {
            roomState.fileVerdictError = 'Verification timed out. Try picking your file again.'
            roomState.fileVerdict      = FILE_VERDICTS.PENDING
            notifyUpdate()
        }, 15000)
    }

    fileVerifyWorker.onerror = () => {
        clearTimeout(fileVerifyTimeout)
        fileVerifyWorker.terminate()
        fileVerifyWorker = null
        roomState.fileVerdictError = 'Could not read your file. Try picking it again.'
        roomState.fileVerdict      = FILE_VERDICTS.PENDING
        notifyUpdate()
    }

    fileVerifyWorker.postMessage({ file })

    // 15-second timeout covers Worker stall/crash.
    fileVerifyTimeout = setTimeout(() => {
        if (fileVerifyWorker) { fileVerifyWorker.terminate(); fileVerifyWorker = null }
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
onMessage('fileVerify_verdict', ({ verdict }) => {
    clearTimeout(fileVerifyTimeout)   // verdict arrived — cancel timeout
    fileVerifyTimeout = null
    roomState.fileVerdict      = verdict === 'valid' ? FILE_VERDICTS.VALID : FILE_VERDICTS.MISMATCH
    roomState.fileVerdictError = null
    notifyUpdate()
    document.dispatchEvent(new CustomEvent('fileVerify:verdict', {
        detail: { verdict: roomState.fileVerdict }
    }))
})