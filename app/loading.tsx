import { BloomGlow } from "@/components/auth/bloom-glow"

export default function Loading() {
  return (
    <main className="min-h-screen bg-[#1f1f1f] text-white">
      <div className="mx-auto flex min-h-screen w-full max-w-4xl items-center justify-center px-6 py-10">
        <div className="w-full max-w-md rounded-[28px] border border-white/10 bg-black/30 p-8 text-center backdrop-blur-sm">
          <div className="mb-4 flex justify-center">
            <BloomGlow />
          </div>
          <h1 className="text-lg font-medium text-white/88">Loading Salomon</h1>
          <p className="mt-2 text-sm text-white/45">
            Preparing your live translation workspace.
          </p>
        </div>
      </div>
    </main>
  )
}
