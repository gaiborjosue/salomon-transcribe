import { headers } from "next/headers"
import { notFound, redirect } from "next/navigation"

import { AuthenticatedHomeShell } from "@/components/auth/authenticated-home-shell"
import { TranscriptSessionView } from "@/components/transcript-session-view"
import { auth } from "@/lib/auth"
import { parseTranscriptSessionRef } from "@/lib/transcript-session-path"
import {
  getTranscriptSessionDetail,
  listTranscriptSessions,
} from "@/lib/transcript-session-store"

export default async function TranscriptSessionPage({
  params,
}: {
  params: Promise<{ sessionRef: string }>
}) {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    redirect("/sign-in")
  }

  const { sessionRef } = await params
  const sessionId = parseTranscriptSessionRef(sessionRef)
  const [transcriptSessions, transcriptSession] = await Promise.all([
    listTranscriptSessions(session.user.id),
    getTranscriptSessionDetail({
      ownerUserId: session.user.id,
      sessionId,
    }),
  ])

  if (!transcriptSession) {
    notFound()
  }

  return (
    <AuthenticatedHomeShell
      activeHistorySessionId={transcriptSession.id}
      initialSessions={transcriptSessions}
      userLabel={session.user.email || session.user.name || "Signed in"}
    >
      <TranscriptSessionView session={transcriptSession} />
    </AuthenticatedHomeShell>
  )
}
