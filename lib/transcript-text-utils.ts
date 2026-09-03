export interface MergeableTranscriptEntry {
  text: string
}

const MIN_WORD_OVERLAP = 2
const MAX_WORD_OVERLAP = 12

export function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function normalizeWord(word: string): string {
  return word
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/gi, "")
}

export function dedupeBoundaryText(previousText: string, nextText: string): string {
  const trimmedNextText = normalizeWhitespace(nextText)

  if (!previousText || !trimmedNextText) {
    return trimmedNextText
  }

  const previousWords = normalizeWhitespace(previousText).split(" ")
  const nextWords = trimmedNextText.split(" ")
  const comparablePrevious = previousWords.map(normalizeWord)
  const comparableNext = nextWords.map(normalizeWord)

  const maxOverlap = Math.min(
    MAX_WORD_OVERLAP,
    comparablePrevious.length,
    comparableNext.length
  )

  for (let overlap = maxOverlap; overlap >= MIN_WORD_OVERLAP; overlap--) {
    const previousSlice = comparablePrevious.slice(-overlap)
    const nextSlice = comparableNext.slice(0, overlap)

    if (
      previousSlice.every(
        (word, index) => word.length > 0 && word === nextSlice[index]
      )
    ) {
      return normalizeWhitespace(nextWords.slice(overlap).join(" "))
    }
  }

  return trimmedNextText
}

function looksLikeContinuation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  if (trimmed.length <= 18) return true
  if (/^(and|or|but|so|because|that|when|where|which|who|then|to)\b/i.test(trimmed)) {
    return true
  }
  if (/^(verse|verses|chapter)\b/i.test(trimmed)) {
    return true
  }
  if (/^\d+[.:,-]?$/.test(trimmed)) {
    return true
  }
  if (/^(to|through)\s+\d+/i.test(trimmed)) {
    return true
  }
  if (/^[a-z(]/.test(trimmed)) {
    return true
  }

  return false
}

function endsLikeContinuation(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  if (/[,;:–—-]$/.test(trimmed)) return true
  if (/\b(of|to|and|or|that|when|where|with|through|from|was|were|is|are)$/i.test(trimmed)) {
    return true
  }

  return false
}

export function mergeTranscriptEntry<T extends MergeableTranscriptEntry>(
  previous: T,
  nextText: string
): T {
  const left = previous.text.trim()
  const right = nextText.trim()
  const joiner =
    left.endsWith("-") || /^[,.;:!?)]/.test(right) ? "" : " "

  return {
    ...previous,
    text: `${left}${joiner}${right}`.replace(/\s+/g, " ").trim(),
  }
}

export function shouldMergeIntoPrevious(
  previous: MergeableTranscriptEntry | undefined,
  nextText: string,
  mode: "conversation" | "sermon"
): boolean {
  if (!previous) return false

  const trimmed = nextText.trim()
  if (!trimmed) return false

  if (mode === "sermon") {
    return looksLikeContinuation(trimmed) || endsLikeContinuation(previous.text)
  }

  return (
    (trimmed.length <= 10 && looksLikeContinuation(trimmed)) ||
    (endsLikeContinuation(previous.text) && trimmed.length <= 24)
  )
}
