import { randomUUID } from "node:crypto"

export function nextQwenEventId() {
  return `event_${randomUUID().replace(/-/gu, "")}`
}

export function extractQwenResponseDoneText(event: Record<string, unknown>) {
  const response =
    event.response && typeof event.response === "object"
      ? (event.response as Record<string, unknown>)
      : null
  const output = Array.isArray(response?.output) ? response.output : []

  for (const outputItem of output) {
    if (!outputItem || typeof outputItem !== "object") {
      continue
    }

    const content = Array.isArray((outputItem as Record<string, unknown>).content)
      ? ((outputItem as Record<string, unknown>).content as unknown[])
      : []

    for (const contentItem of content) {
      if (!contentItem || typeof contentItem !== "object") {
        continue
      }

      const contentRecord = contentItem as Record<string, unknown>
      const textValue =
        typeof contentRecord.text === "string"
          ? contentRecord.text
          : typeof contentRecord.transcript === "string"
            ? contentRecord.transcript
            : ""

      const trimmed = textValue.trim()
      if (trimmed) {
        return trimmed
      }
    }
  }

  return ""
}
