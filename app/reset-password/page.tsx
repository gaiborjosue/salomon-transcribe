import Link from "next/link"

import { AuthShell } from "@/components/auth/auth-shell"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"
import { Button } from "@/components/ui/button"

type ResetPasswordPageProps = {
  searchParams: Promise<{
    error?: string | string[]
    token?: string | string[]
  }>
}

export default async function ResetPasswordPage({
  searchParams,
}: ResetPasswordPageProps) {
  const { error, token } = await searchParams
  const resetToken = typeof token === "string" ? token : null
  const hasInvalidToken = error === "INVALID_TOKEN" || !resetToken

  if (hasInvalidToken) {
    return (
      <AuthShell
        title="Reset link expired"
        description="This password reset link is invalid or has expired. Request a new one to continue."
      >
        <Button
          asChild
          className="h-11 w-full rounded-full bg-white text-black hover:bg-white/90"
        >
          <Link href="/forgot-password">Request a new reset link</Link>
        </Button>
      </AuthShell>
    )
  }

  return (
    <AuthShell
      title="Choose a new password"
      description="Use a strong password you haven’t used elsewhere."
    >
      <ResetPasswordForm token={resetToken} />
    </AuthShell>
  )
}
