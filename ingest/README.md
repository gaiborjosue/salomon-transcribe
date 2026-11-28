# Media ingest

This service is intentionally separate from the Next.js app.

It is responsible for:

- decoding Mux, RTMP, and YouTube audio with `ffmpeg` and streaming it to Soniox
- resolving YouTube livestream audio with `yt-dlp`
- reading RTMP audio from MediaMTX and sending finalized English captions back to the app

All live inputs use Soniox one-way translation from Spanish speech to English text.
The microphone uses the Soniox React SDK and connects directly to Soniox with a
single-use temporary key issued by the signed-in app.

## Local run

### YouTube Live

Install `ffmpeg` and a current `yt-dlp`, and make sure both are on your `PATH`.
Use Node.js 22 or newer for YouTube extraction. If you install `yt-dlp` from
PyPI, use `yt-dlp[default]` to include the YouTube JavaScript challenge solver.

Set `SONIOX_API_KEY` in the repo root `.env`. Run `pnpm dev` for the app and
`pnpm ingest:dev` in another terminal for the worker. The worker's health check
is at `http://127.0.0.1:4100/health` by default.

Select **YouTube Live** in the app and enter the stream URL.

### RTMP

Start MediaMTX and the ingest worker from the repo root.

```bash
mediamtx ingest/mediamtx.yml
```

```bash
pnpm ingest:dev
```

Open the advanced RTMP page.

```text
http://localhost:3000/advanced/rtmp
```

## Environment

- `INGEST_PORT`
  - default: `4100`
- `INGEST_CONTROL_SECRET`
  - required in production for YouTube, Mux, and RTMP control requests
  - use the same value in the Next.js app and the ingest service
- `MEDIAMTX_RTMP_BASE_URL`
  - default: `rtmp://127.0.0.1:1935/live`
- `SONIOX_API_KEY`
  - set on both the Next.js app and the ingest service
  - the app key needs real-time speech-to-text and temporary API key creation permissions
  - the ingest service key needs real-time speech-to-text permission

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

## Production media ingestion

Vercel does not run the long-lived `yt-dlp`, `ffmpeg`, and WebSocket process. Deploy
`Dockerfile.ingest` on a persistent container host, configure the variables above,
and point the Vercel app at that service. Apply the Prisma migrations before
deploying the app so transcript entries can store speaker labels. End active
sessions before deploying the app and ingest service together.
YouTube event streams connect directly to the ingest service after the app creates
the session. Mux and RTMP write finalized captions through their app session APIs.
