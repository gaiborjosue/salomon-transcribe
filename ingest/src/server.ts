import "dotenv/config"

import { createServer } from "node:http"

import { HOST, PORT, RTMP_INPUT_BASE_URL } from "@/ingest/src/config"
import { ChunkedIngestSession } from "@/ingest/src/sessions/chunked-ingest-session"
import { MicRealtimeBridge } from "@/ingest/src/sessions/mic-realtime-bridge"
import { MuxQwenIngestSession } from "@/ingest/src/sessions/mux-qwen-ingest-session"
import {
  type ManagedSession,
  type MuxSessionPayload,
  type RtmpSessionPayload,
  type SessionKind,
} from "@/ingest/src/types"
import { readJsonBody } from "@/ingest/src/utils/http"
import { livestreamSessionManager } from "@/lib/livestream-session-manager"
import type { LivestreamMode } from "@/lib/livestream-types"
import { verifyQwenLiveToken } from "@/lib/qwen-live-token"
import { WebSocketServer } from "ws"

const sessions = new Map<string, ManagedSession>()

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

function isYouTubeControlAuthorized(request: import("node:http").IncomingMessage) {
  const expectedSecret = process.env.INGEST_CONTROL_SECRET?.trim()
  if (!expectedSecret) {
    return process.env.NODE_ENV !== "production"
  }

  return request.headers["x-salomon-ingest-secret"] === expectedSecret
}

function writeJson(
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown
) {
  response.writeHead(status, { "Content-Type": "application/json" })
  response.end(JSON.stringify(payload))
}

async function createOrReplaceSession(
  kind: SessionKind,
  sessionId: string,
  session: ManagedSession
) {
  const key = getSessionMapKey(kind, sessionId)
  const previous = sessions.get(key)
  if (previous) {
    await previous.stop()
    sessions.delete(key)
  }

  sessions.set(key, session)
  session.start()
}

async function stopSession(
  kind: SessionKind,
  sessionId: string,
  options?: { notifyApp?: boolean }
) {
  const key = getSessionMapKey(kind, sessionId)
  const session = sessions.get(key)

  if (!session) {
    return false
  }

  await session.stop(options)
  sessions.delete(key)
  return true
}

const server = createServer(async (incomingRequest, outgoingResponse) => {
  const method = incomingRequest.method || "GET"
  const url = new URL(incomingRequest.url || "/", `http://127.0.0.1:${PORT}`)

  if (method === "GET" && url.pathname === "/health") {
    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && url.pathname === "/youtube-sessions") {
    if (!isYouTubeControlAuthorized(incomingRequest)) {
      writeJson(outgoingResponse, 401, {
        error: "Livestream ingest control request is unauthorized.",
      })
      return
    }

    const body = (await readJsonBody(incomingRequest)) as
      | { mode?: LivestreamMode; streamUrl?: string }
      | null
    const streamUrl = typeof body?.streamUrl === "string" ? body.streamUrl.trim() : ""
    const mode = body?.mode === "sermon" ? "sermon" : "conversation"

    if (!streamUrl || !isYouTubeUrl(streamUrl)) {
      writeJson(outgoingResponse, 400, {
        error: "A valid YouTube livestream URL is required.",
      })
      return
    }

    try {
      const session = await livestreamSessionManager.createSession({ mode, streamUrl })
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
        send("partial", { text: event.text })
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
    if (!isYouTubeControlAuthorized(incomingRequest)) {
      writeJson(outgoingResponse, 401, {
        error: "Livestream ingest control request is unauthorized.",
      })
      return
    }

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
      !body?.appBaseUrl ||
      !body?.ingestToken ||
      !body?.sessionId ||
      !body?.streamKey
    ) {
      outgoingResponse.writeHead(400, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Invalid RTMP session payload." }))
      return
    }

    const sessionId = body.sessionId
    const inputUrl = `${RTMP_INPUT_BASE_URL.replace(/\/+$/u, "")}/${body.streamKey}`
    const session = new ChunkedIngestSession({
      appBaseUrl: body.appBaseUrl,
      chunkPath: `/api/rtmp-sessions/${sessionId}/chunk`,
      ingestToken: body.ingestToken,
      inputUrl,
      kind: "rtmp",
      onStopFromControlPlane: async () => {
        await stopSession("rtmp", sessionId, { notifyApp: false })
      },
      perfPath: undefined,
      sessionId,
      statusPath: `/api/rtmp-sessions/${sessionId}/status`,
    })

    await createOrReplaceSession("rtmp", sessionId, session)

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && url.pathname === "/mux-sessions") {
    const body = (await readJsonBody(incomingRequest)) as Partial<MuxSessionPayload> | null

    if (
      !body?.appBaseUrl ||
      !body?.ingestToken ||
      !body?.sessionId ||
      !body?.playbackUrl
    ) {
      outgoingResponse.writeHead(400, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Invalid Mux session payload." }))
      return
    }

    const sessionId = body.sessionId
    const session = new MuxQwenIngestSession({
      appBaseUrl: body.appBaseUrl,
      entriesPath: `/api/mux/live-streams/${sessionId}/entries`,
      ingestToken: body.ingestToken,
      inputUrl: body.playbackUrl,
      onStopFromControlPlane: async () => {
        await stopSession("mux", sessionId, { notifyApp: false })
      },
      perfPath: `/api/mux/live-streams/${sessionId}/perf`,
      sessionId,
      statusPath: `/api/mux/live-streams/${sessionId}/status`,
    })

    await createOrReplaceSession("mux", sessionId, session)

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && /^\/sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = url.pathname.split("/")[2]
    const stopped = await stopSession("rtmp", sessionId)

    if (!stopped) {
      outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Session not found." }))
      return
    }

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  if (method === "POST" && /^\/mux-sessions\/[^/]+\/stop$/u.test(url.pathname)) {
    const sessionId = url.pathname.split("/")[2]
    const stopped = await stopSession("mux", sessionId)

    if (!stopped) {
      outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
      outgoingResponse.end(JSON.stringify({ error: "Session not found." }))
      return
    }

    outgoingResponse.writeHead(200, { "Content-Type": "application/json" })
    outgoingResponse.end(JSON.stringify({ ok: true }))
    return
  }

  outgoingResponse.writeHead(404, { "Content-Type": "application/json" })
  outgoingResponse.end(JSON.stringify({ error: "Not found." }))
})

const micRealtimeServer = new WebSocketServer({ noServer: true })

server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", `http://127.0.0.1:${PORT}`)
  if (url.pathname !== "/mic-realtime") {
    socket.destroy()
    return
  }

  const token = url.searchParams.get("token")?.trim() || ""
  const payload = token ? verifyQwenLiveToken(token) : null
  if (!payload) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n")
    socket.destroy()
    return
  }

  micRealtimeServer.handleUpgrade(request, socket, head, (browserSocket) => {
    const bridge = new MicRealtimeBridge(browserSocket, payload)

    void bridge
      .start()
      .then(() => {
        browserSocket.on("message", (message, isBinary) => {
          bridge.handleBrowserMessage(message, isBinary)
        })

        browserSocket.on("close", () => {
          void bridge.stop()
        })

        browserSocket.on("error", () => {
          void bridge.stop()
        })
      })
      .catch((error) => {
        const message =
          error instanceof Error ? error.message : "Unable to start Qwen realtime."
        if (browserSocket.readyState === browserSocket.OPEN) {
          browserSocket.send(JSON.stringify({ error: message, type: "error" }))
          browserSocket.close()
        }
      })
  })
})

server.listen(PORT, HOST, () => {
  console.info(`[Ingest] Listening on http://${HOST}:${PORT}`)
})
