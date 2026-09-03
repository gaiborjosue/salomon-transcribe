# Media ingest

This service is intentionally separate from the Next.js app.

It is responsible for:

- reading RTMP audio from MediaMTX
- resolving YouTube livestream audio with `yt-dlp`
- decoding and normalizing audio with `ffmpeg`
- chunking PCM audio
- posting chunks back into the main app for classification and translation

## Local run

1. Start MediaMTX:

```bash
mediamtx ingest/mediamtx.yml
```

2. Start the ingest worker from the repo root:

```bash
pnpm ingest:dev
```

3. Open the advanced RTMP page:

```text
http://localhost:3000/advanced/rtmp
```

## Environment

- `INGEST_PORT`
  - default: `4100`
- `INGEST_CONTROL_SECRET`
  - required in production; use the same value in the Next.js app
- `MEDIAMTX_RTMP_BASE_URL`
  - default: `rtmp://127.0.0.1:1935/live`
- `DASHSCOPE_API_KEY`
  - required for YouTube livestream translation

The main app can optionally set:

- `RTMP_INGEST_BASE_URL`
  - default: `http://127.0.0.1:4100`
- `RTMP_PUBLISH_BASE_URL`
  - default: `rtmp://localhost:1935/live`
- `LIVESTREAM_INGEST_BASE_URL`
  - internal or public HTTPS URL for the deployed ingest service
- `LIVESTREAM_INGEST_PUBLIC_BASE_URL`
  - optional browser-reachable URL when the internal URL is private
- `INGEST_CONTROL_SECRET`
  - required in production; must match the ingest service

## Production YouTube ingestion

Vercel does not run the long-lived `yt-dlp`, `ffmpeg`, and WebSocket process. Deploy
`Dockerfile.ingest` on a persistent container host, configure the variables above,
and point the Vercel app at that service. YouTube event streams connect directly to
the ingest service after the app creates the session.
