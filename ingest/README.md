# RTMP ingest

This service is intentionally separate from the Next.js app.

It is responsible for:

- reading RTMP audio from MediaMTX
- decoding and normalizing audio with `ffmpeg`
- chunking PCM audio
- posting chunks back into the main app for classification and translation

## Local run

1. Start MediaMTX:

```bash
mediamtx /Users/edwardgaibor/Projects/salomon/ingest/mediamtx.yml
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
- `MEDIAMTX_RTMP_BASE_URL`
  - default: `rtmp://127.0.0.1:1935/live`

The main app can optionally set:

- `RTMP_INGEST_BASE_URL`
  - default: `http://127.0.0.1:4100`
- `RTMP_PUBLISH_BASE_URL`
  - default: `rtmp://localhost:1935/live`
