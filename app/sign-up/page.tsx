import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth/auth-shell"
import { SignUpForm } from "@/components/auth/sign-up-form"
import { auth } from "@/lib/auth"

export default async function SignUpPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect("/")
  }

  return (
    <AuthShell
      title="Create account"
      description="Set up your account to start translating services in real time."
    >
      <SignUpForm />
    </AuthShell>
  )
}
