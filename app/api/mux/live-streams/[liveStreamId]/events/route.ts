import { muxSessionManager } from "@/lib/mux-session-manager"
import { getApiSession } from "@/lib/api-auth"

export const runtime = "nodejs"

function serializeSseEvent(event: string, data: unknown) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ liveStreamId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return new Response("Unauthorized.", { status: 401 })
  }

  const { liveStreamId } = await params
  const { searchParams } = new URL(request.url)
  const hostToken = searchParams.get("hostToken")?.trim() || ""

  if (!hostToken) {
    return new Response("Missing host token.", { status: 400 })
  }

  const ownerSession = await muxSessionManager.getOwnerSession(
    liveStreamId,
    session.user.id
  )
  if (!ownerSession || ownerSession.hostToken !== hostToken) {
    return new Response("Mux session not found.", { status: 404 })
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
          // Stream may already be closed.
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

      void (async () => {
        unsubscribe = await muxSessionManager.subscribe(liveStreamId, hostToken, (event) => {
          if (event.type === "snapshot") {
            send("snapshot", event.snapshot)
            return
          }

          if (event.type === "entry") {
            send("entry", event.entry)
            return
          }

          send("status", {
            error: event.error,
            muxStatus: event.muxStatus,
            status: event.status,
          })
        })

        if (!unsubscribe) {
          cleanup()
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
      })()
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
