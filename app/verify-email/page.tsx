import { AuthShell } from "@/components/auth/auth-shell"
import { VerifyEmailView } from "@/components/auth/verify-email-view"

export default function VerifyEmailPage() {
  return (
    <AuthShell
      title="Verify email"
      description="Confirm your address to activate sign-in and password recovery."
    >
      <VerifyEmailView />
    </AuthShell>
  )
}
