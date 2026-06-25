// ── Render Keep-Alive ────────────────────────────────────────
//
// Render's free tier spins down after 15 min without HTTP requests.
// WebSocket traffic does NOT count. This pings /healthz every 5 min
// to keep the container alive during active sessions.

let keepAliveTimer = null

const startKeepAlive = () => {
  stopKeepAlive()
  keepAliveTimer = setInterval(() => {
    fetch('/healthz').catch(() => {})
  }, 5 * 60 * 1000) // every 5 minutes
}

const stopKeepAlive = () => {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer)
    keepAliveTimer = null
  }
}