import { headers } from "next/headers"
import { redirect } from "next/navigation"

import { AuthShell } from "@/components/auth/auth-shell"
import { SignInForm } from "@/components/auth/sign-in-form"
import { auth } from "@/lib/auth"

export default async function SignInPage() {
  const session = await auth.api.getSession({
    headers: await headers(),
  })

  if (session) {
    redirect("/")
  }

  return (
    <AuthShell
      title="Sign in"
      description="Access live church translation with your email and password."
    >
      <SignInForm />
    </AuthShell>
  )
}
