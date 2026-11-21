import "dotenv/config"

import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { HOST, MUX_AUDIO_FILTER, PORT, RTMP_INPUT_BASE_URL } from "@/ingest/src/config"
import { MediaIngestSession } from "@/ingest/src/sessions/media-ingest-session"
import {
  type ManagedSession,
  type MuxSessionPayload,
  type RtmpSessionPayload,
  type SessionKind,
} from "@/ingest/src/types"
import { readJsonBody } from "@/ingest/src/utils/http"
import { INGEST_CONTROL_HEADER } from "@/lib/ingest-control"
import { livestreamSessionManager } from "@/lib/livestream-session-manager"

const sessions = new Map<string, ManagedSession>()
const sessionOperations = new Map<string, Promise<unknown>>()

function getSessionMapKey(kind: SessionKind, sessionId: string) {
  return `${kind}:${sessionId}`
}

function isYouTubeUrl(value: string) {
  try {
    const url = new URL(value)
    const hostname = url.hostname.toLowerCase().replace(/^www\./u, "")
    return (
      (url.protocol === "https:" || url.protocol === "http:") &&
      (hostname === "youtube.com" ||
        hostname.endsWith(".youtube.com") ||
        hostname === "youtu.be")
    )
  } catch {
    return false
  }
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false
  const url = URL.parse(value)
  return url?.protocol === "http:" || url?.protocol === "https:"
}

function isControlAuthorized(request: IncomingMessage) {
  const expectedSecret = process.env.INGEST_CONTROL_SECRET?.trim()
  if (!expectedSecret) {
    return process.env.NODE_ENV !== "production"
  }

  return request.headers[INGEST_CONTROL_HEADER] === expectedSecret
}

function writeJson(
  response: ServerResponse,
  status: number,
  payload: unknown
) {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(payload))
}

function runSessionOperation<T>(key: string, operation: () => Promise<T>) {
  const previous = sessionOperations.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(operation)
  sessionOperations.set(key, next)
  return next.finally(() => {
    if (sessionOperations.get(key) === next) sessionOperations.delete(key)
  })
}

function createOrReplaceSession(kind: SessionKind, sessionId: string, session: ManagedSession) {
  const key = getSessionMapKey(kind, sessionId)
  return runSessionOperation(key, async () => {
    await sessions.get(key)?.stop({ notifyApp: false })
    sessions.set(key, session)
    await session.start()
  })
}

function stopSession(
  kind: SessionKind,
  sessionId: string,
  expectedSession?: ManagedSession
) {
  const key = getSessionMapKey(kind, sessionId)
  return runSessionOperation(key, async () => {
    const session = sessions.get(key)
    if (!session || (expectedSession && session !== expectedSession)) return false

    try {
      await session.stop({ notifyApp: !expectedSession })
      return true
    } finally {
      sessions.delete(key)
    }
  })
}

async function handleRequest(incomingRequest: IncomingMessage, outgoingResponse: ServerResponse) {
  const method = incomingRequest.method || "GET"
  const url = new URL(incomingRequest.url || "/", `http://127.0.0.1:${PORT}`)

  if (method === "GET" && url.pathname === "/health") {
    writeJson(outgoingResponse, 200, { ok: true })
    return
  }

  if (method === "POST" && !isControlAuthorized(incomingRequest)) {
    writeJson(outgoingResponse, 401, { error: "Ingest control request is unauthorized." })
    return
  }

  if (method === "POST" && url.pathname === "/youtube-sessions") {
    const body = await readJsonBody(incomingRequest)
    const streamUrl = typeof body?.streamUrl === "string" ? body.streamUrl.trim() : ""

    if (!streamUrl || !isYouTubeUrl(streamUrl)) {
      writeJson(outgoingResponse, 400, {
        error: "A valid YouTube livestream URL is required.",
      })
      return
    }

    try {
      const session = await livestreamSessionManager.createSession(streamUrl)
      writeJson(outgoingResponse, 200, { sessionId: session.getSnapshot().id })
    } catch (error) {
      writeJson(outgoingResponse, 500, {
        error:
          error instanceof Error
            ? error.message
            : "Unable to start the YouTube livestream session.",
      })
    }
    return
  }

  const youtubeEventsMatch = url.pathname.match(
    /^\/youtube-sessions\/([^/]+)\/events$/u
  )
  if (method === "GET" && youtubeEventsMatch) {
    const sessionId = decodeURIComponent(youtubeEventsMatch[1])
    const session = livestreamSessionManager.getSession(sessionId)
    if (!session) {
      writeJson(outgoingResponse, 404, { error: "Livestream session not found." })
      return
    }

    outgoingResponse.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    })
    outgoingResponse.flushHeaders()

    const send = (eventName: string, payload: unknown) => {
      outgoingResponse.write(
        `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`
      )
    }
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "snapshot") {
        send("snapshot", event.snapshot)
        return
      }

      if (event.type === "partial") {
        send("partial", { captions: event.captions })
        return
      }

      if (event.type === "segment") {
        send("segment", event.entry)
        return
      }

      send("status", {
        error: event.error,
        sourceTitle: event.sourceTitle,
        status: event.status,
      })
    })
    const keepAlive = setInterval(() => {
      outgoingResponse.write(": keepalive\n\n")
    }, 15_000)
    const cleanup = () => {
      clearInterval(keepAlive)
      unsubscribe()
    }
    outgoingResponse.on("close", cleanup)
    return
  }

  const youtubeControlMatch = url.pathname.match(
    /^\/youtube-sessions\/([^/]+)\/control$/u
  )
  if (method === "POST" && youtubeControlMatch) {
    const sessionId = decodeURIComponent(youtubeControlMatch[1])
    const session = livestreamSessionManager.getSession(sessionId)
    if (!session) {
      writeJson(outgoingResponse, 404, { error: "Livestream session not found." })
      return
    }

    const body = (await readJsonBody(incomingRequest)) as
      | { action?: "pause" | "resume" | "stop" }
      | null

    try {
      if (body?.action === "pause") {
        await session.pause()
      } else if (body?.action === "resume") {
        await session.resume()
      } else if (body?.action === "stop") {
        await livestreamSessionManager.stopSession(sessionId)
        writeJson(outgoingResponse, 200, { ok: true, snapshot: session.getSnapshot() })
        return
      } else {
        writeJson(outgoingResponse, 400, { error: "Unsupported action." })
        return
      }

      writeJson(outgoingResponse, 200, { ok: true })
    } catch (error) {
      writeJson(outgoingResponse, 500, {
        error:
          error instanceof Error
            ? error.message
            : "Unable to update the livestream session.",
      })
    }
    return
  }

  if (method === "POST" && url.pathname === "/sessions") {
    const body = (await readJsonBody(incomingRequest)) as Partial<RtmpSessionPayload> | null

    if (
      !isHttpUrl(body?.appBaseUrl) ||
      typeof body?.ingestToken !== "string" || !body.ingestToken ||
      typeof body.sessionId !== "string" || !body.sessionId ||
      typeof body.streamKey !== "string" || !body.streamKey
    ) {
      writeJson(outgoingResponse, 400, { error: "Invalid RTMP session payload." })
      return
    }

    const sessionId = body.sessionId
    const sessionPath = `/api/rtmp-sessions/${encodeURIComponent(sessionId)}`
    const inputUrl = `${RTMP_INPUT_BASE_URL.replace(/\/+$/u, "")}/${encodeURIComponent(body.streamKey)}`
    const session = new MediaIngestSession({
      appBaseUrl: body.appBaseUrl,
      entriesPath: `${sessionPath}/entries`,
      ingestToken: body.ingestToken,
      inputUrl,
      onStopFromControlPlane: (active) => stopSession("rtmp", sessionId, active),
      sessionId,
      statusPath: `${sessionPath}/status`,
    })

    await createOrReplaceSession("rtmp", sessionId, session)

    writeJson(outgoingResponse, 200, { ok: true })
    return
  }

  if (method === "POST" && url.pathname === "/mux-sessions") {
    const body = (await readJsonBody(incomingRequest)) as Partial<MuxSessionPayload> | null

    if (
      !isHttpUrl(body?.appBaseUrl) ||
      typeof body?.ingestToken !== "string" || !body.ingestToken ||
      typeof body.sessionId !== "string" || !body.sessionId ||
      !isHttpUrl(body.playbackUrl)
    ) {
      writeJson(outgoingResponse, 400, { error: "Invalid Mux session payload." })
      return
    }

    const sessionId = body.sessionId
    const sessionPath = `/api/mux/live-streams/${encodeURIComponent(sessionId)}`
    const session = new MediaIngestSession({
      appBaseUrl: body.appBaseUrl,
      audioFilter: MUX_AUDIO_FILTER,
      entriesPath: `${sessionPath}/entries`,
      ingestToken: body.ingestToken,
      inputUrl: body.playbackUrl,
      onStopFromControlPlane: (active) => stopSession("mux", sessionId, active),
      perfPath: `${sessionPath}/perf`,
      sessionId,
      statusPath: `${sessionPath}/status`,
    })

    await createOrReplaceSession("mux", sessionId, session)

    writeJson(outgoingResponse, 200, { ok: true })
    return
  }

  if (method === "POST" && /^\/sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = decodeURIComponent(url.pathname.split("/")[2])
    const stopped = await stopSession("rtmp", sessionId)

    if (!stopped) {
      writeJson(outgoingResponse, 404, { error: "Session not found." })
      return
    }

    writeJson(outgoingResponse, 200, { ok: true })
    return
  }

  if (method === "POST" && /^\/mux-sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = decodeURIComponent(url.pathname.split("/")[2])
    const stopped = await stopSession("mux", sessionId)

    if (!stopped) {
      writeJson(outgoingResponse, 404, { error: "Session not found." })
      return
    }

    writeJson(outgoingResponse, 200, { ok: true })
    return
  }

  writeJson(outgoingResponse, 404, { error: "Not found." })
}

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error: unknown) => {
    if (response.headersSent) {
      response.end()
    } else if (error instanceof URIError) {
      writeJson(response, 400, { error: "Invalid session identifier." })
    } else {
      console.error("[Ingest] Request failed", error)
      writeJson(response, 500, { error: "Ingest request failed." })
    }
  })
})

server.listen(PORT, HOST, () => {
  console.info(`[Ingest] Listening on http://${HOST}:${PORT}`)
})
