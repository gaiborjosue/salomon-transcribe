"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <main className="min-h-screen bg-[#1f1f1f] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-10">
        <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-black/30 p-8 text-center backdrop-blur-sm">
          <div className="mx-auto mb-4 w-fit rounded-full border border-red-400/20 px-3 py-1 text-[11px] tracking-[0.2em] uppercase text-red-300/70">
            Unexpected Error
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white/92">
            Something went wrong
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/45">
            Salomon hit an unexpected error while rendering this route.
          </p>
          <div className="mt-8">
            <Button onClick={() => reset()} className="h-11 rounded-full bg-white text-black hover:bg-white/90">
              Try again
            </Button>
          </div>
        </div>
      </div>
    </main>
  )
}
