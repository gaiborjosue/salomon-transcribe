import { betterAuth } from "better-auth"
import { prismaAdapter } from "better-auth/adapters/prisma"
import { nextCookies } from "better-auth/next-js"

import {
  sendPasswordResetEmail,
  sendVerificationEmail,
} from "@/lib/auth-email"
import prisma from "@/lib/prisma"

const authBaseUrl = process.env.BETTER_AUTH_URL ?? "http://localhost:3000"
const authSecret =
  process.env.BETTER_AUTH_SECRET ??
  "replace-this-dev-secret-before-production-use"

export const auth = betterAuth({
  appName: "Salomon",
  baseURL: authBaseUrl,
  secret: authSecret,
  database: prismaAdapter(prisma, {
    provider: "postgresql",
  }),
  emailAndPassword: {
    enabled: true,
    autoSignIn: false,
    requireEmailVerification: true,
    minPasswordLength: 8,
    resetPasswordTokenExpiresIn: 60 * 30,
    revokeSessionsOnPasswordReset: true,
    async sendResetPassword({ user, url, token }) {
      await sendPasswordResetEmail({
        email: user.email,
        name: user.name,
        url,
        token,
      })
    },
  },
  emailVerification: {
    expiresIn: 60 * 60 * 24,
    sendOnSignIn: true,
    sendOnSignUp: true,
    autoSignInAfterVerification: false,
    async sendVerificationEmail({ user, url, token }) {
      await sendVerificationEmail({
        email: user.email,
        name: user.name,
        url,
        token,
      })
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 7,
    updateAge: 60 * 60 * 24,
  },
  rateLimit: {
    enabled: true,
    storage: "memory",
    window: 60,
    max: 10,
  },
  advanced: {
    useSecureCookies: process.env.NODE_ENV === "production",
  },
  trustedOrigins: [authBaseUrl],
  plugins: [nextCookies()],
})

export type Session = typeof auth.$Infer.Session
