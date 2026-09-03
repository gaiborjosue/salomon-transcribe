import { getApiSession } from "@/lib/api-auth"
import { getLivestreamIngestEventsUrl } from "@/lib/livestream-ingest-client"

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> }
) {
  const session = await getApiSession(request)
  if (!session) {
    return new Response("Unauthorized.", { status: 401 })
  }

  const { sessionId } = await params
  return Response.redirect(getLivestreamIngestEventsUrl(sessionId), 307)
}
