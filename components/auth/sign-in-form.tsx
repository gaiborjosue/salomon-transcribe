"use client"

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useState } from "react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { sendVerificationEmail, signIn } from "@/lib/auth-client"

export function SignInForm() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [isResending, setIsResending] = useState(false)
  const [verificationEmail, setVerificationEmail] = useState<string | null>(
    searchParams.get("email")
  )
  const [verificationNotice, setVerificationNotice] = useState<string | null>(null)

  const verified = searchParams.get("verified") === "1"
  const reset = searchParams.get("reset") === "1"
  const defaultEmail = searchParams.get("email") ?? ""

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setVerificationNotice(null)
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

      if (code === "EMAIL_NOT_VERIFIED" || message.toLowerCase().includes("verify")) {
        setVerificationEmail(email)
      }

      setError(message)
      return
    }

    router.replace("/")
    router.refresh()
  }

  async function handleResendVerification() {
    if (!verificationEmail) {
      return
    }

    setIsResending(true)
    setError(null)

    const result = await sendVerificationEmail({
      email: verificationEmail,
      callbackURL: `${window.location.origin}/sign-in?verified=1&email=${encodeURIComponent(
        verificationEmail
      )}`,
    })

    setIsResending(false)

    if (result.error) {
      setError(result.error.message || "Unable to sign in.")
      return
    }

    setVerificationNotice("Verification email sent. Check your inbox.")
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

      {verificationNotice ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>{verificationNotice}</AlertDescription>
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

      {verificationEmail ? (
        <Button
          type="button"
          variant="ghost"
          disabled={isResending}
          onClick={() => void handleResendVerification()}
          className="h-10 w-full rounded-full border border-white/10 text-white/76 hover:bg-white/8 hover:text-white"
        >
          {isResending ? "Sending verification..." : "Resend verification email"}
        </Button>
      ) : null}

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
