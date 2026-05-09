import type { TranscriptEntry } from "@/components/transcriber-ui"
import {
  mergeTranscriptEntry,
  shouldMergeIntoPrevious,
} from "@/lib/transcript-text-utils"

export function appendMergedTranscriptEntry(
  entries: TranscriptEntry[],
  entry: TranscriptEntry,
  transcriptionMode: "conversation" | "sermon"
) {
  const previousEntry = entries[entries.length - 1]

  if (!shouldMergeIntoPrevious(previousEntry, entry.text, transcriptionMode)) {
    return [...entries, entry]
  }

  const mergedEntry = mergeTranscriptEntry(previousEntry, entry.text)
  return [
    ...entries.slice(0, -1),
    {
      ...mergedEntry,
      lowConfidence: Boolean(previousEntry.lowConfidence) || Boolean(entry.lowConfidence),
    },
  ]
}
