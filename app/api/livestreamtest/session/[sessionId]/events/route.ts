import { livestreamSessionManager } from "@/lib/livestream-session-manager"

export const runtime = "nodejs"

function serializeSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const session = livestreamSessionManager.getSession(sessionId)

  if (!session) {
    return new Response("Livestream session not found.", { status: 404 })
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

      unsubscribe = session.subscribe((event) => {
        if (event.type === "snapshot") {
          send("snapshot", event.snapshot)
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
