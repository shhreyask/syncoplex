# SyncoPlex

Watch videos with friends — in sync — using your own local files.

Everyone in the room loads the same file on their device. SyncoPlex keeps playback state (play, pause, seek) locked together over WebSockets. No video is ever uploaded or streamed through the server.

## How it works

1. Create a room (you get a code like `WOLF-BEAR-482134`)
2. Share the code with friends
3. Everyone picks the same local video file
4. A SHA-256 hash check ensures all files match
5. Play/pause/seek — every device follows

Voice chat is handled peer-to-peer via WebRTC (full mesh, up to 6 users per room). TURN relay is supported through Metered for NAT traversal.

## Stack

- **Backend:** Go (net/http + gorilla/websocket)
- **Frontend:** Vanilla JS, HTML, CSS — no build step
- **Realtime:** WebSocket hub (single-goroutine event loop) for sync, WebRTC for voice
- **Infra:** Single binary, Docker-ready

## Running locally

```bash
# clone
git clone https://github.com/shhreyask/syncoplex.git
cd syncoplex

# (optional) create a .env at root
echo 'PORT=8080' > .env
echo 'ALLOWED_ORIGIN=http://localhost:8080' >> .env

# run the server
cd server
go run .
```

Open `http://localhost:8080`.

### Docker

```bash
docker build -t syncoplex .
docker run -p 8080:8080 syncoplex
```

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | Server listen port |
| `ALLOWED_ORIGIN` | `https://syncoplex.app` | CORS / WebSocket origin check |
| `PUBLIC_DIR` | `../frontend/public` | Path to static frontend files |
| `METERED_TURN_HOST` | — | Metered TURN hostname (optional, enables relay) |
| `METERED_API_KEY` | — | Metered API key (optional) |

## Project layout

```
server/           Go backend
  main.go         HTTP server, routes, static file serving
  hub.go          WebSocket hub — event loop, sync logic, WebRTC relay
  rooms.go        Room creation, code generation, HTTP handlers
  session.go      Session tokens, reconnect logic
  store.go        In-memory room + session stores with TTL
  config.go       Constants and env loading
  turn.go         TURN credential proxy (Metered)
  middleware.go   Rate limiting, CORS, security headers

frontend/public/  Static SPA (no bundler)
  index.html      Landing → Lobby → Watch views
  style.css
  js/
    state.js      Client-side state machine
    ws.js         WebSocket connection + reconnect
    sync.js       Playback sync (apply server commands to video)
    player.js     Video element controls
    fileVerify.js File hash verification (SHA-256 via Web Worker)
    webrtc.js     Voice chat — full mesh P2P
    ui.js         DOM manipulation, view transitions

designDecisions/  Architecture docs (HLDs)
```