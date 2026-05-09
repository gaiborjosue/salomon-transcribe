"use client"

import { balloons, textBalloons } from "balloons-js"
import Link from "next/link"
import { useRouter } from "next/navigation"
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
import { signUp } from "@/lib/auth-client"

function releaseSignupBalloons() {
  try {
    void balloons().catch(() => {})
    textBalloons([
      {
        text: "🎉🔥✨",
        fontSize: 120,
        color: "#000000",
      },
    ])
  } catch {
    // Signup should never fail because the celebration animation failed.
  }
}

export function SignUpForm() {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsPending(true)

    const formData = new FormData(event.currentTarget)
    const name = String(formData.get("name") || "").trim()
    const email = String(formData.get("email") || "").trim()
    const password = String(formData.get("password") || "")
    const confirmPassword = String(formData.get("confirmPassword") || "")

    if (password !== confirmPassword) {
      setIsPending(false)
      setError("Passwords do not match.")
      return
    }

    const result = await signUp.email({
      name,
      email,
      password,
      callbackURL: `${window.location.origin}/sign-in?verified=1&email=${encodeURIComponent(
        email
      )}`,
    })

    if (result.error) {
      setIsPending(false)
      setError(result.error.message || "Unable to create your account.")
      return
    }

    releaseSignupBalloons()
    window.setTimeout(() => {
      router.replace(`/verify-email?email=${encodeURIComponent(email)}`)
      router.refresh()
    }, 900)
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="name">Name</FieldLabel>
          <Input
            id="name"
            name="name"
            type="text"
            required
            autoComplete="name"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="Your name"
          />
        </Field>
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
        <Field>
          <FieldLabel htmlFor="password">Password</FieldLabel>
          <Input
            id="password"
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="Choose a password"
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="confirmPassword">Confirm password</FieldLabel>
          <Input
            id="confirmPassword"
            name="confirmPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="Repeat your password"
          />
        </Field>
      </FieldGroup>

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
        {isPending ? "Creating account..." : "Create account"}
      </Button>

      <FieldDescription className="text-center text-white/34">
        We&apos;ll send a verification link before you can sign in.
      </FieldDescription>

      <FieldDescription className="text-center text-white/40">
        Already have an account?{" "}
        <Link href="/sign-in" className="text-white/72 underline underline-offset-4">
          Sign in
        </Link>
      </FieldDescription>
    </form>
  )
}
