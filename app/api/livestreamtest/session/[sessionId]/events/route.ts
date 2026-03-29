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

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (eventName: string, payload: unknown) => {
        controller.enqueue(encoder.encode(serializeSseEvent(eventName, payload)))
      }

      const unsubscribe = session.subscribe((event) => {
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

      const keepAlive = setInterval(() => {
        controller.enqueue(encoder.encode(": keepalive\n\n"))
      }, 15_000)

      const abortHandler = () => {
        clearInterval(keepAlive)
        unsubscribe()
        controller.close()
      }

      request.signal.addEventListener("abort", abortHandler, { once: true })
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
