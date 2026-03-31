import Link from "next/link"
import { headers } from "next/headers"

import { AuthenticatedHomeShell } from "@/components/auth/authenticated-home-shell"
import { Button } from "@/components/ui/button"
import { auth } from "@/lib/auth"

export default async function HomePage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    return (
      <main className="min-h-screen bg-[#1f1f1f] text-white">
        <div className="mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-5 py-10">
          <div className="w-full rounded-[28px] border border-white/10 bg-black/30 p-8 text-center shadow-none backdrop-blur-sm">
            <div className="space-y-4">
              <div className="mx-auto w-fit rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium tracking-[0.2em] uppercase text-white/45">
                Salomon
              </div>
              <div className="space-y-2">
                <h1 className="text-3xl font-semibold tracking-tight text-white/92">
                  Live translation for church services
                </h1>
                <p className="text-sm leading-6 text-white/45">
                  Sign in to run live microphone or livestream translation with shared
                  sessions, scripture highlights, and sermon-first tuning.
                </p>
              </div>
            </div>

            <div className="mt-8 flex flex-col gap-3">
              <Button asChild className="h-11 rounded-full bg-white text-black hover:bg-white/90">
                <Link href="/sign-in">Sign in</Link>
              </Button>
              <Button
                asChild
                variant="ghost"
                className="h-11 rounded-full border border-white/10 text-white/78 hover:bg-white/8 hover:text-white"
              >
                <Link href="/sign-up">Create account</Link>
              </Button>
            </div>
          </div>
        </div>
      </main>
    )
  }

  return (
    <AuthenticatedHomeShell
      userLabel={session.user.email || session.user.name || "Signed in"}
    />
  )
}
