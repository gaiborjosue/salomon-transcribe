import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { RtmpIngestPage } from "@/components/rtmp-ingest-page"
import { auth } from "@/lib/auth"

export default async function AdvancedRtmpPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (!session) {
    redirect("/sign-in")
  }

  return <RtmpIngestPage />
}
