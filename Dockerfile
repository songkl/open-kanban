FROM golang:1.24-alpine AS builder

WORKDIR /app

RUN apk add --no-cache nodejs npm

COPY frontend/package*.json ./
RUN npm install

COPY frontend ./
RUN npm run build

COPY backend .
RUN mkdir -p cmd/server/web && cp -r dist/* cmd/server/web/ || true

WORKDIR /app/backend
RUN go mod download
RUN CGO_ENABLED=1 GOOS=linux go build -ldflags="-s -w" -o /app/kanban-server ./cmd/server

FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata

WORKDIR /app

COPY --from=builder /app/kanban-server .
COPY --from=builder /app/backend/cmd/server/web ./web

ENV PORT=8080
ENV DATABASE_URL=kanban.db
ENV WEB_DIR=web

EXPOSE 8080

CMD ["./kanban-server"]
