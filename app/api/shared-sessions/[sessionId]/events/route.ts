import { sharedSessionManager } from "@/lib/shared-session-manager"
import { muxSessionManager } from "@/lib/mux-session-manager"

export const runtime = "nodejs"

function serializeSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const url = new URL(request.url)
  const countAsViewer = url.searchParams.get("viewer") !== "0"
  let session = sharedSessionManager.getSessionById(sessionId)

  if (!session) {
    await muxSessionManager.ensureSharedSessionById(sessionId)
    session = sharedSessionManager.getSessionById(sessionId)
  }

  if (!session) {
    return new Response("Shared session not found.", { status: 404 })
  }

  let cleanupStream = () => {}

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      let keepAlive: ReturnType<typeof setInterval> | null = null
      let unsubscribe: (() => void) | null = null
      let abortHandler = () => {}

      const cleanup = () => {
        if (closed) {
          return
        }

        closed = true
        if (keepAlive) {
          clearInterval(keepAlive)
          keepAlive = null
        }
        unsubscribe?.()
        unsubscribe = null
        request.signal.removeEventListener("abort", abortHandler)
        try {
          controller.close()
        } catch {
          // Stream may already be closed by the runtime.
        }
      }
      cleanupStream = cleanup

      const send = (eventName: string, payload: unknown) => {
        if (closed) {
          return
        }

        try {
          controller.enqueue(encoder.encode(serializeSseEvent(eventName, payload)))
        } catch {
          cleanup()
        }
      }

      unsubscribe = sharedSessionManager.subscribe(
        sessionId,
        (event) => {
          if (event.type === "snapshot") {
            send("snapshot", event.snapshot)
            return
          }

          if (event.type === "entry") {
            send("entry", event.entry)
            return
          }

          send("meta", {
            sourceTitle: event.sourceTitle,
            status: event.status,
          })
        },
        { countAsViewer }
      )

      if (!unsubscribe) {
        controller.close()
        return
      }

      keepAlive = setInterval(() => {
        if (closed) {
          return
        }

        try {
          controller.enqueue(encoder.encode(": keepalive\n\n"))
        } catch {
          cleanup()
        }
      }, 15_000)

      abortHandler = () => {
        cleanup()
      }

      request.signal.addEventListener("abort", abortHandler, { once: true })
    },
    cancel() {
      cleanupStream()
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    },
  })
}
