import { AuthShell } from "@/components/auth/auth-shell"
import { ResetPasswordForm } from "@/components/auth/reset-password-form"

export default async function ResetPasswordPage({
  params,
}: {
  params: Promise<{ token: string }>
}) {
  const { token } = await params

  return (
    <AuthShell
      title="Choose a new password"
      description="Use a strong password you haven’t used elsewhere."
    >
      <ResetPasswordForm token={token} />
    </AuthShell>
  )
}
