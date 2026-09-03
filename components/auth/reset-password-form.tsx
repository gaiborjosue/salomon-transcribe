"use client"

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
import { resetPassword } from "@/lib/auth-client"

export function ResetPasswordForm({ token }: { token: string }) {
  const router = useRouter()
  const [error, setError] = useState<string | null>(null)
  const [isPending, setIsPending] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setError(null)
    setIsPending(true)

    const formData = new FormData(event.currentTarget)
    const newPassword = String(formData.get("newPassword") || "")
    const confirmPassword = String(formData.get("confirmPassword") || "")

    if (newPassword !== confirmPassword) {
      setIsPending(false)
      setError("Passwords do not match.")
      return
    }

    const result = await resetPassword({
      token,
      newPassword,
    })

    setIsPending(false)

    if (result.error) {
      setError(result.error.message || "Unable to reset password.")
      return
    }

    router.replace("/sign-in?reset=1")
    router.refresh()
  }

  return (
    <form className="space-y-5" onSubmit={handleSubmit}>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor="newPassword">New password</FieldLabel>
          <Input
            id="newPassword"
            name="newPassword"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            className="h-11 border-white/10 bg-transparent text-white placeholder:text-white/28"
            placeholder="Choose a new password"
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
            placeholder="Repeat your new password"
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
        {isPending ? "Updating password..." : "Update password"}
      </Button>

      <FieldDescription className="text-center text-white/40">
        Need a new reset link?{" "}
        <Link href="/forgot-password" className="text-white/72 underline underline-offset-4">
          Request another one
        </Link>
      </FieldDescription>
    </form>
  )
}
