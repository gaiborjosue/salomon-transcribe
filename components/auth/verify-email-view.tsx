"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useEffect, useMemo, useState } from "react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { sendVerificationEmail, verifyEmail } from "@/lib/auth-client"

type VerificationState = "idle" | "pending" | "success" | "error"

export function VerifyEmailView() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const token = searchParams.get("token")
  const initialEmail = searchParams.get("email") ?? ""
  const verified = searchParams.get("verified") === "1"

  const [email, setEmail] = useState(initialEmail)
  const [error, setError] = useState<string | null>(null)
  const [isResending, setIsResending] = useState(false)
  const [state, setState] = useState<VerificationState>(
    verified ? "success" : token ? "pending" : "idle"
  )

  const title = useMemo(() => {
    if (state === "pending") return "Verifying your email"
    if (state === "success") return "Email verified"
    if (state === "error") return "Verification link expired"
    return "Check your inbox"
  }, [state])

  useEffect(() => {
    if (!token) {
      return
    }

    const tokenValue = token
    let cancelled = false

    async function run() {
      const result = await verifyEmail({
        query: {
          token: tokenValue,
        },
      })

      if (cancelled) {
        return
      }

      if (result.error) {
        setState("error")
        setError(result.error.message || "Unable to verify email.")
        return
      }

      setState("success")
      router.replace(
        `/verify-email?verified=1${email ? `&email=${encodeURIComponent(email)}` : ""}`
      )
      router.refresh()
    }

    void run()

    return () => {
      cancelled = true
    }
  }, [email, router, token, verifyEmail])

  async function handleResend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsResending(true)

    const result = await sendVerificationEmail({
      email,
      callbackURL: `${window.location.origin}/verify-email?verified=1&email=${encodeURIComponent(
        email
      )}`,
    })

    setIsResending(false)

    if (result.error) {
      const message = result.error.message || "Unable to send verification email."
      setError(message)
      toast.error(message)
      return
    }

    setState("idle")
    toast.success("Verification email sent. Check your inbox.")
  }

  if (state === "pending") {
    return (
      <div className="space-y-4">
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>We&apos;re confirming your email now.</AlertDescription>
        </Alert>
        <FieldDescription className="text-center text-white/40">
          This should only take a moment.
        </FieldDescription>
      </div>
    )
  }

  if (state === "success") {
    return (
      <div className="space-y-5">
        <div className="space-y-2">
          <h2 className="text-xl font-semibold tracking-tight text-white/92">
            Email verified
          </h2>
          <p className="text-sm leading-6 text-white/45">
            Your email is confirmed. Sign in to start using Salomon.
          </p>
        </div>

        <Button
          asChild
          className="h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
        >
          <Link
            href={`/sign-in?verified=1${
              email ? `&email=${encodeURIComponent(email)}` : ""
            }`}
          >
            Continue to sign in
          </Link>
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <h2 className="text-xl font-semibold tracking-tight text-white/92">{title}</h2>
        <p className="text-sm leading-6 text-white/45">
          {state === "error"
            ? "Request a fresh verification link and we’ll send it right away."
            : "We sent a verification link to your inbox. Open it to finish setting up your account."}
        </p>
      </div>

      {error ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      <form className="space-y-5" onSubmit={handleResend}>
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="verify-email">Email</FieldLabel>
            <Input
              id="verify-email"
              name="email"
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              autoComplete="email"
              className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
              placeholder="you@example.com"
            />
          </Field>
        </FieldGroup>

        <Button
          type="submit"
          disabled={isResending || !email}
          className="h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
        >
          {isResending ? "Sending link..." : "Send verification email"}
        </Button>
      </form>

      <FieldDescription className="text-center text-white/40">
        Already verified?{" "}
        <Link href="/sign-in" className="text-white/72 underline underline-offset-4">
          Sign in
        </Link>
      </FieldDescription>
    </div>
  )
}
