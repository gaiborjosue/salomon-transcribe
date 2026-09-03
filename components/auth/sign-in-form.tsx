"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"
import { toast } from "sonner"

import { BloomGlow } from "@/components/auth/bloom-glow"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { signIn } from "@/lib/auth-client"

function isEmailNotVerifiedError(code: string, message: string) {
  return code === "EMAIL_NOT_VERIFIED" || message.toLowerCase().includes("verif")
}

const AUTH_TRANSITION_DELAY_MS = 1000

function waitForAuthTransition() {
  return new Promise<void>((resolve) => window.setTimeout(resolve, AUTH_TRANSITION_DELAY_MS))
}

export function SignInForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isTransitioning, setIsTransitioning] = useState(false)

  const verified = searchParams.get("verified") === "1"
  const reset = searchParams.get("reset") === "1"
  const defaultEmail = searchParams.get("email") ?? ""

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsPending(true)

    const formData = new FormData(event.currentTarget)
    const email = String(formData.get("email") || "").trim()
    const password = String(formData.get("password") || "")

    const result = await signIn.email({
      email,
      password,
      callbackURL: `${window.location.origin}/`,
    })

    setIsPending(false)

    if (result.error) {
      const code = String(result.error.code || "")
      const message = result.error.message || "Unable to sign in."

      if (isEmailNotVerifiedError(code, message)) {
        router.replace(`/verify-email?email=${encodeURIComponent(email)}`)
        return
      }

      setError(message)
      return
    }

    toast.success("Welcome back.")
    setIsTransitioning(true)
    await waitForAuthTransition()
    router.replace("/")
    router.refresh()
  }

  if (isTransitioning) {
    return (
      <div className="flex min-h-[292px] flex-col items-center justify-center gap-4 text-center">
        <BloomGlow />
        <div className="space-y-1">
          <p className="text-sm font-medium text-white/88">Loading Salomon</p>
          <p className="text-xs text-white/42">Preparing your workspace.</p>
        </div>
      </div>
    )
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="email">Email</FieldLabel>
          <Input
            id="email"
            name="email"
            type="email"
            required
            autoComplete="email"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="you@example.com"
            defaultValue={defaultEmail}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="Enter your password"
          />
        </Field>
      </FieldGroup>

      {verified ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>Your email is verified. You can sign in now.</AlertDescription>
        </Alert>
      ) : null}

      {reset ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>Password updated. Sign in with your new password.</AlertDescription>
        </Alert>
      ) : null}

      {error ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <Button
        type="submit"
        disabled={isPending}
        className="h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
      >
        {isPending ? "Signing in..." : "Sign in"}
      </Button>

      <FieldDescription className="text-center text-white/40">
        <Link href="/forgot-password" className="text-white/72 underline underline-offset-4">
          Forgot your password?
        </Link>
      </FieldDescription>

      <FieldDescription className="text-center text-white/40">
        Don&apos;t have an account?{" "}
        <Link href="/sign-up" className="text-white/72 underline underline-offset-4">
          Create one
        </Link>
      </FieldDescription>
    </form>
  )
}
