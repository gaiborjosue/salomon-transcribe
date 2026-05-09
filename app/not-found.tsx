import Link from "next/link"

import { Button } from "@/components/ui/button"

export default function NotFound() {
  return (
    <main className="min-h-screen bg-[#1f1f1f] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-10">
        <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-black/30 p-8 text-center backdrop-blur-sm">
          <div className="mx-auto mb-4 w-fit rounded-full border border-white/10 px-3 py-1 text-[11px] tracking-[0.2em] uppercase text-white/45">
            Not Found
          </div>
          <h1 className="text-2xl font-semibold tracking-tight text-white/92">
            We couldn&apos;t find that page
          </h1>
          <p className="mt-3 text-sm leading-6 text-white/45">
            The session or route you requested no longer exists, or the URL is invalid.
          </p>
          <div className="mt-8">
            <Button asChild className="h-11 rounded-full bg-white text-black hover:bg-white/90">
              <Link href="/">Back to home</Link>
            </Button>
          </div>
        </div>
      </div>
    </main>
  )
}
