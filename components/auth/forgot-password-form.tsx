"use client"

import Link from "next/link"
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
import { requestPasswordReset } from "@/lib/auth-client"

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)
  const [submittedEmail, setSubmittedEmail] = useState<string | null>(null)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsPending(true)

    const formData = new FormData(event.currentTarget)
    const email = String(formData.get("email") || "").trim()

    const result = await requestPasswordReset({
      email,
      redirectTo: `${window.location.origin}/reset-password`,
    })

    setIsPending(false)

    if (result.error) {
      setError(result.error.message || "Unable to send reset email.")
      return
    }

    setSubmittedEmail(email)
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
          />
        </Field>
      </FieldGroup>

      {submittedEmail ? (
        <Alert className="border-white/10 bg-white/5 text-white/85">
          <AlertDescription>
            If an account exists for {submittedEmail}, a reset link is on its way.
          </AlertDescription>
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
        {isPending ? "Sending reset link..." : "Send reset link"}
      </Button>

      <FieldDescription className="text-center text-white/40">
        Remembered it?{" "}
        <Link href="/sign-in" className="text-white/72 underline underline-offset-4">
          Back to sign in
        </Link>
      </FieldDescription>
    </form>
  )
}
