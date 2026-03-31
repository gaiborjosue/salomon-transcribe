"use client"

import Link from "next/link"
import { useState } from "react"

import LiveTranslationHome from "@/components/live-translation-home"
import { SignOutButton } from "@/components/auth/sign-out-button"

export function AuthenticatedHomeShell({
  userLabel,
}: {
  userLabel: string
}) {
  const [showAccountChip, setShowAccountChip] = useState(true)

  return (
    <main className="relative">
      {showAccountChip ? (
        <div className="pointer-events-none absolute inset-x-0 top-0 z-50 flex justify-center px-4 pt-4 sm:px-6">
          <div className="pointer-events-auto flex w-full max-w-4xl justify-end">
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-black/35 px-3 py-2 text-xs text-white/72 shadow-sm backdrop-blur-sm">
              <Link
                href="/advanced/rtmp"
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] tracking-[0.14em] uppercase text-white/48 transition-colors hover:border-white/16 hover:text-white/76"
              >
                RTMP
              </Link>
              <Link
                href="/advanced/mux"
                className="rounded-full border border-white/10 px-2.5 py-1 text-[11px] tracking-[0.14em] uppercase text-white/48 transition-colors hover:border-white/16 hover:text-white/76"
              >
                Mux
              </Link>
              <span className="max-w-[42vw] truncate px-2 text-white/55 sm:max-w-none">
                {userLabel}
              </span>
              <SignOutButton />
            </div>
          </div>
        </div>
      ) : null}

      <LiveTranslationHome onAccountChromeVisibleChange={setShowAccountChip} />
    </main>
  )
}
