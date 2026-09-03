import Link from "next/link"
import { headers } from "next/headers"

import { AuthenticatedHomeShell } from "@/components/auth/authenticated-home-shell"
import LiveTranslationHome from "@/components/live-translation-home"
import { Button } from "@/components/ui/button"
import HeroGeometric from "@/components/ui/hero-geometric"
import { auth } from "@/lib/auth"
import { listTranscriptSessions } from "@/lib/transcript-session-store"

export default async function HomePage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    return (
      <main className="relative min-h-screen overflow-hidden bg-white">
        <HeroGeometric
          title1="Salomon"
          title2="Transcribe"
          description="Start transcribing and translating live services in real time."
        />
        <div className="pointer-events-none absolute inset-x-0 top-[62%] z-20 flex justify-center px-6 sm:top-[64%]">
          <Button
            asChild
            size="lg"
            className="pointer-events-auto h-12 rounded-full bg-black px-7 text-white shadow-[0_18px_50px_rgba(0,0,0,0.18)] hover:bg-black/88"
          >
            <Link href="/sign-up">Get Started</Link>
          </Button>
        </div>
      </main>
    )
  }

  const transcriptSessions = await listTranscriptSessions(session.user.id)

  return (
    <AuthenticatedHomeShell
      activeHistorySessionId={null}
      initialSessions={transcriptSessions}
      userLabel={session.user.email || session.user.name || "Signed in"}
    >
      <LiveTranslationHome />
    </AuthenticatedHomeShell>
  )
}
