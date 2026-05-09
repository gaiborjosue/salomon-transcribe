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
import { verifyQwenLiveToken } from "@/lib/qwen-live-token"
import { WebSocketServer } from "ws"

const sessions = new Map<string, ManagedSession>()

function getSessionMapKey(kind: SessionKind, sessionId: string) {
  return `${kind}:${sessionId}`
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
