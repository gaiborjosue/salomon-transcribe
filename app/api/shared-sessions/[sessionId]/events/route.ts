import { sharedSessionManager } from "@/lib/shared-session-manager"

export const runtime = "nodejs"

function serializeSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await params
  const session = sharedSessionManager.getSessionById(sessionId)

  if (!session) {
    return new Response("Shared session not found.", { status: 404 })
  }

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      const send = (eventName: string, payload: unknown) => {
        controller.enqueue(encoder.encode(serializeSseEvent(eventName, payload)))
      }

      const unsubscribe = sharedSessionManager.subscribe(sessionId, (event) => {
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
      })

      if (!unsubscribe) {
        controller.close()
        return
      }

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
