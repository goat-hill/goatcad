export interface SearchItem {
  name: string
  category?: string
  library?: string
  extraSearchTerms?: string[]
}

export interface TextSegment {
  text: string
  isMatch: boolean
}

/**
 * Checks if a component matches the query.
 * The query is split by whitespace into keywords, and EVERY keyword must match
 * at least one of the component's search fields (case-insensitively).
 */
export function matchComponent(query: string, item: SearchItem): boolean {
  const cleanQuery = query.trim().toLowerCase()
  if (!cleanQuery) return true

  const keywords = cleanQuery.split(/\s+/).filter(Boolean)
  if (keywords.length === 0) return true

  const searchTexts: string[] = []

  if (item.library) {
    searchTexts.push(item.library)
    searchTexts.push(item.library.replace(/_/g, ' '))
  }

  if (item.category) {
    searchTexts.push(item.category)
    searchTexts.push(item.category.replace(/_/g, ' '))
  }

  searchTexts.push(item.name)
  searchTexts.push(item.name.replace(/_/g, ' ').replace('.kicad_mod', ''))

  if (item.extraSearchTerms) {
    for (const term of item.extraSearchTerms) {
      if (term) {
        searchTexts.push(term)
        searchTexts.push(term.replace(/_/g, ' '))
      }
    }
  }

  const combined = searchTexts.map((s) => s.toLowerCase()).join(' ')

  return keywords.every((keyword) => combined.includes(keyword))
}

/**
 * Splits a text into matching and non-matching segments based on keywords from a query string.
 * This is used for precise character-level search highlighting.
 */
export function highlightText(text: string, query: string): TextSegment[] {
  if (!text) return []
  const cleanQuery = query.trim().toLowerCase()
  if (!cleanQuery) {
    return [{ text, isMatch: false }]
  }

  const keywords = cleanQuery.split(/\s+/).filter(Boolean)
  if (keywords.length === 0) {
    return [{ text, isMatch: false }]
  }

  const lowerText = text.toLowerCase()
  const intervals: { start: number; end: number }[] = []

  // Find all intervals where any keyword matches
  for (const keyword of keywords) {
    let index = lowerText.indexOf(keyword)
    while (index !== -1) {
      intervals.push({ start: index, end: index + keyword.length })
      index = lowerText.indexOf(keyword, index + 1)
    }
  }

  if (intervals.length === 0) {
    return [{ text, isMatch: false }]
  }

  // Sort intervals by start index, then by end index descending
  intervals.sort((a, b) => a.start - b.start || b.end - a.end)

  // Merge overlapping or adjacent intervals
  const mergedIntervals: { start: number; end: number }[] = []
  let current = intervals[0]

  for (let i = 1; i < intervals.length; i++) {
    const next = intervals[i]
    if (next.start <= current.end) {
      // Overlapping or adjacent, merge
      current.end = Math.max(current.end, next.end)
    } else {
      mergedIntervals.push(current)
      current = next
    }
  }
  mergedIntervals.push(current)

  // Build segments
  const segments: TextSegment[] = []
  let lastIdx = 0

  for (const interval of mergedIntervals) {
    if (interval.start > lastIdx) {
      segments.push({
        text: text.substring(lastIdx, interval.start),
        isMatch: false
      })
    }
    segments.push({
      text: text.substring(interval.start, interval.end),
      isMatch: true
    })
    lastIdx = interval.end
  }

  if (lastIdx < text.length) {
    segments.push({
      text: text.substring(lastIdx),
      isMatch: false
    })
  }

  return segments
}
