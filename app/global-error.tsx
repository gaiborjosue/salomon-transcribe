"use client"

import { useEffect } from "react"

import { Button } from "@/components/ui/button"

export default function GlobalError({
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
    <html lang="en">
      <body className="bg-[#1f1f1f] text-white">
        <main className="min-h-screen">
          <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-10">
            <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-black/30 p-8 text-center backdrop-blur-sm">
              <div className="mx-auto mb-4 w-fit rounded-full border border-red-400/20 px-3 py-1 text-[11px] tracking-[0.2em] uppercase text-red-300/70">
                Application Error
              </div>
              <h1 className="text-2xl font-semibold tracking-tight text-white/92">
                Salomon needs a refresh
              </h1>
              <p className="mt-3 text-sm leading-6 text-white/45">
                A root-level error interrupted the app shell.
              </p>
              <div className="mt-8">
                <Button onClick={() => reset()} className="h-11 rounded-full bg-white text-black hover:bg-white/90">
                  Reload app
                </Button>
              </div>
            </div>
          </div>
        </main>
      </body>
    </html>
  )
}
