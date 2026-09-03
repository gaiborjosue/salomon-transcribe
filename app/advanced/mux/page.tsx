import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { MuxLivePage } from "@/components/mux-live-page"
import { auth } from "@/lib/auth"

export default async function AdvancedMuxPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    redirect("/sign-in")
  }

  return <MuxLivePage />
}
