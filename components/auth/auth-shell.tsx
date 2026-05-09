import Link from "next/link"

import { RippleShader } from "@/components/ripple-shader"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { cn } from "@/lib/utils"

export function AuthShell({
  children,
  className,
  description,
  eyebrow = "Salomon",
  title,
}: {
  children: React.ReactNode
  className?: string
  description: string
  eyebrow?: string
  title: string
}) {
  return (
    <main className="relative min-h-screen overflow-hidden bg-black text-white">
      <div className="absolute inset-0 z-0">
        <RippleShader
          pixelSize={0.5}
          speed={1.2}
          waveFrequency={2}
          threshold={0.9}
          grainAmount={0.2}
          gridOpacity={0.4}
          cursorRadius={1}
          cursorPush={0.8}
          color="#ffffff"
          className="absolute inset-0 h-full w-full"
        />
        <div className="absolute inset-0 bg-black/82" />
      </div>

      <div className="relative z-10 mx-auto flex min-h-screen w-full max-w-md items-center justify-center px-5 py-10">
        <Card
          className={cn(
            "w-full border-white/10 bg-black/30 text-white shadow-none backdrop-blur-sm",
            className
          )}
        >
          <CardHeader className="gap-3">
            <Link
              href="/"
              className="w-fit rounded-full border border-white/10 px-3 py-1 text-[11px] font-medium tracking-[0.2em] uppercase text-white/45 transition hover:border-white/15 hover:text-white/72"
            >
              {eyebrow}
            </Link>
            <div className="space-y-2">
              <CardTitle className="text-2xl font-semibold tracking-tight text-white/92">
                {title}
              </CardTitle>
              <CardDescription className="text-sm text-white/45">
                {description}
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent>{children}</CardContent>
        </Card>
      </div>
    </main>
  )
}
