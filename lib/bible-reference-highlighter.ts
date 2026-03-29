import { bcv_parser } from "bible-passage-reference-parser/esm/bcv_parser.js"
import * as lang from "bible-passage-reference-parser/esm/lang/en.js"

export interface BibleReferenceFragment {
  book?: string
  chapter?: number
  endVerse?: number
  highlighted: boolean
  osis?: string
  query?: string
  startVerse?: number
  text: string
}

const parser = new bcv_parser(lang)

parser.set_options({
  passage_existence_strategy: "none",
  book_alone_strategy: "ignore",
  book_range_strategy: "ignore",
  osis_compaction_strategy: "bcv",
})

const BOOK_NAMES = [
  "Song of Solomon",
  "Song of Songs",
  "1 Thessalonians",
  "2 Thessalonians",
  "1 Corinthians",
  "2 Corinthians",
  "1 Chronicles",
  "2 Chronicles",
  "1 Timothy",
  "2 Timothy",
  "1 Samuel",
  "2 Samuel",
  "1 Kings",
  "2 Kings",
  "1 Peter",
  "2 Peter",
  "1 John",
  "2 John",
  "3 John",
  "Genesis",
  "Exodus",
  "Leviticus",
  "Numbers",
  "Deuteronomy",
  "Joshua",
  "Judges",
  "Ruth",
  "Ezra",
  "Nehemiah",
  "Esther",
  "Job",
  "Psalms",
  "Psalm",
  "Proverbs",
  "Ecclesiastes",
  "Isaiah",
  "Jeremiah",
  "Lamentations",
  "Ezekiel",
  "Daniel",
  "Hosea",
  "Joel",
  "Amos",
  "Obadiah",
  "Jonah",
  "Micah",
  "Nahum",
  "Habakkuk",
  "Zephaniah",
  "Haggai",
  "Zechariah",
  "Malachi",
  "Matthew",
  "Mark",
  "Luke",
  "John",
  "Acts",
  "Romans",
  "Galatians",
  "Ephesians",
  "Philippians",
  "Colossians",
  "Titus",
  "Philemon",
  "Hebrews",
  "James",
  "Jude",
  "Revelation",
]

const escapedBooks = BOOK_NAMES.sort((left, right) => right.length - left.length)
  .map((book) => book.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|")

const CANDIDATE_REFERENCE_PATTERN = new RegExp(
  `\\b(?:${escapedBooks})\\s+\\d{1,3}(?:\\s*[:.]\\s*\\d{1,3}(?:\\s*(?:-|–|—|to|through)\\s*\\d{1,3})?)?`,
  "gi"
)

function normalizeReferenceCandidate(candidate: string): string {
  return candidate
    .replace(/\bPsalms\b/gi, "Psalm")
    .replace(/\bSong of Songs\b/gi, "Song of Solomon")
    .replace(/(\d)\s*\.\s*(\d)/g, "$1:$2")
    .replace(/\bto\b/gi, "-")
    .replace(/\bthrough\b/gi, "-")
    .replace(/\s+/g, " ")
    .trim()
}

function parseOsisBounds(osis: string): {
  book?: string
  chapter?: number
  startVerse?: number
  endVerse?: number
} {
  const [start, end = start] = osis.split("-")
  const startParts = start.split(".")
  const endParts = end.split(".")
  const startChapter = Number(startParts[1])
  const startVerse = Number(startParts[2])
  const endVerse = Number(endParts[2] ?? startParts[2])

  return {
    book: startParts[0],
    chapter: Number.isFinite(startChapter) ? startChapter : undefined,
    startVerse: Number.isFinite(startVerse) ? startVerse : undefined,
    endVerse: Number.isFinite(endVerse) ? endVerse : undefined,
  }
}

export function getBibleReferenceFragments(
  transcript: string
): BibleReferenceFragment[] {
  if (!transcript) {
    return []
  }

  const fragments: BibleReferenceFragment[] = []
  let cursor = 0

  for (const match of transcript.matchAll(CANDIDATE_REFERENCE_PATTERN)) {
    const rawMatch = match[0]
    const startIndex = match.index ?? 0
    const endIndex = startIndex + rawMatch.length
    const normalizedCandidate = normalizeReferenceCandidate(rawMatch)
    const [parsedReference] = parser.parse(normalizedCandidate).osis_and_indices()

    if (!parsedReference?.osis) {
      continue
    }

    if (startIndex > cursor) {
      fragments.push({
        highlighted: false,
        text: transcript.slice(cursor, startIndex),
      })
    }

    fragments.push({
      ...parseOsisBounds(parsedReference.osis),
      highlighted: true,
      osis: parsedReference.osis,
      query: normalizedCandidate,
      text: transcript.slice(startIndex, endIndex),
    })
    cursor = endIndex
  }

  if (cursor < transcript.length) {
    fragments.push({
      highlighted: false,
      text: transcript.slice(cursor),
    })
  }

  return fragments
}
