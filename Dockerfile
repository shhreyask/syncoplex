# ── Build Stage ───────────────────────────────────────────────────
FROM golang:1.25-alpine AS builder
WORKDIR /app

COPY go.mod go.sum ./
RUN go mod download

COPY server/ ./server/
RUN cd server && CGO_ENABLED=0 go build -o /syncoplex .

# ── Runtime Stage ─────────────────────────────────────────────────
FROM alpine:3.21
RUN apk add --no-cache ca-certificates

COPY --from=builder /syncoplex /syncoplex
COPY frontend/public /app/frontend/public

ENV PORT=8080
ENV PUBLIC_DIR=/app/frontend/public

EXPOSE 8080
CMD ["/syncoplex"]