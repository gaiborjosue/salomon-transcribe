import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { ForgotPasswordForm } from "@/components/auth/forgot-password-form"
import { AuthShell } from "@/components/auth/auth-shell"
import { auth } from "@/lib/auth"

export default async function ForgotPasswordPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect("/")
  }

  return (
    <AuthShell
      title="Reset password"
      description="Enter your email and we’ll send you a secure reset link."
    >
      <ForgotPasswordForm />
    </AuthShell>
  )
}
