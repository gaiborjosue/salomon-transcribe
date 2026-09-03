"use server"

export interface ScribeTokenResult {
  token?: string
  error?: string
}

export async function getScribeToken(): Promise<ScribeTokenResult> {
  try {
    const apiKey = process.env.ELEVENLABS_API_KEY

    if (!apiKey) {
      console.log("[v0] ELEVENLABS_API_KEY is not set")
      return { error: "ELEVENLABS_API_KEY not configured. Please add it in Settings > Vars." }
    }

    console.log("[v0] Fetching Scribe token...")
    const response = await fetch(
      "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe",
      {
        method: "POST",
        headers: {
          "xi-api-key": apiKey,
          "Content-Type": "application/json",
        },
      }
    )

    if (!response.ok) {
      const errorText = await response.text()
      console.error("[v0] Failed to get Scribe token:", response.status, errorText)
      return { error: `Failed to get token: ${response.status} - ${errorText}` }
    }

    const data = await response.json()
    console.log("[v0] Token response received:", data.token ? "token present" : "no token")

    if (!data.token) {
      return { error: "Invalid token response - no token in response" }
    }

    return { token: data.token }
  } catch (error) {
    console.error("Error getting Scribe token:", error)
    return {
      error: error instanceof Error ? error.message : "Failed to get token",
    }
  }
}
