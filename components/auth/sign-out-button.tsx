"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"

import { Button } from "@/components/ui/button"
import { signOut } from "@/lib/auth-client"

export function SignOutButton() {
  const router = useRouter()
  const [isPending, setIsPending] = useState(false)

  async function handleSignOut() {
    setIsPending(true)
    await signOut()
    router.replace("/sign-in")
    router.refresh()
  }

  return (
    <Button
      type="button"
      variant="ghost"
      disabled={isPending}
      onClick={() => void handleSignOut()}
      className="h-8 rounded-full border border-white/10 px-3 text-white/72 hover:bg-white/8 hover:text-white"
    >
      {isPending ? "Signing out..." : "Sign out"}
    </Button>
  )
}
