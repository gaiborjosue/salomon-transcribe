import { createHmac, timingSafeEqual } from "node:crypto"

interface QwenLiveTokenPayload {
  exp: number
  sourceLanguage: string
  targetLanguage: string
  userId: string
}

const DEFAULT_TTL_SECONDS = 60 * 10

function getSigningSecret() {
  return (
    process.env.QWEN_LIVE_SESSION_SECRET?.trim() ||
    process.env.BETTER_AUTH_SECRET?.trim() ||
    "replace-this-dev-secret-before-production-use"
  )
}

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/gu, "-")
    .replace(/\//gu, "_")
    .replace(/=+$/u, "")
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/gu, "+").replace(/_/gu, "/")
  const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4))
  return Buffer.from(`${padded}${padding}`, "base64")
}

function signPayload(payloadBase64Url: string) {
  return toBase64Url(
    createHmac("sha256", getSigningSecret()).update(payloadBase64Url).digest()
  )
}

export function createQwenLiveToken(input: {
  expiresInSeconds?: number
  sourceLanguage: string
  targetLanguage: string
  userId: string
}) {
  const payload: QwenLiveTokenPayload = {
    exp:
      Math.floor(Date.now() / 1000) +
      Math.max(30, input.expiresInSeconds ?? DEFAULT_TTL_SECONDS),
    sourceLanguage: input.sourceLanguage,
    targetLanguage: input.targetLanguage,
    userId: input.userId,
  }

  const payloadBase64Url = toBase64Url(JSON.stringify(payload))
  const signature = signPayload(payloadBase64Url)
  return `${payloadBase64Url}.${signature}`
}

export function verifyQwenLiveToken(token: string) {
  const [payloadPart, signaturePart] = token.split(".")
  if (!payloadPart || !signaturePart) {
    return null
  }

  const expectedSignature = signPayload(payloadPart)
  const provided = Buffer.from(signaturePart, "utf8")
  const expected = Buffer.from(expectedSignature, "utf8")

  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null
  }

  try {
    const payload = JSON.parse(
      fromBase64Url(payloadPart).toString("utf8")
    ) as QwenLiveTokenPayload

    if (
      !payload.userId ||
      !payload.sourceLanguage ||
      !payload.targetLanguage ||
      typeof payload.exp !== "number"
    ) {
      return null
    }

    if (payload.exp < Math.floor(Date.now() / 1000)) {
      return null
    }

    return payload
  } catch {
    return null
  }
}

export function getQwenLiveWorkerWebSocketUrl() {
  const explicit = process.env.QWEN_LIVE_WORKER_WS_URL?.trim()
  if (explicit) {
    const value = explicit.replace(/\/+$/u, "")

    if (value.startsWith("https://")) {
      return `wss://${value.slice("https://".length)}`
    }

    if (value.startsWith("http://")) {
      return `ws://${value.slice("http://".length)}`
    }

    return value
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("QWEN_LIVE_WORKER_WS_URL is not configured.")
  }

  return "ws://127.0.0.1:4100"
}
