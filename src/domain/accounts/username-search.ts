import { UsernameRegex } from "./index"

export const USERNAME_SEARCH_LIMIT = 5
export const USERNAME_SEARCH_SCAN_LIMIT = 100
const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789_"

/** A literal search hint, never a regular expression or a wildcard from a caller. */
export const normalizeUsernameSearch = (input: string): string | undefined => {
  if (input.length > 80) return undefined
  const name = input
    .trim()
    .replace(/^@/, "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\s+/g, "")
  return UsernameRegex.test(name) ? name : undefined
}

/** Indexed equality probes recover one-character mistakes even at the start of a name. */
export const usernameSearchVariants = (name: string): string[] => {
  const letters = [...name]
  const variants = new Set([name])
  const add = (value: string) => {
    if (UsernameRegex.test(value)) variants.add(value)
  }
  for (let i = 0; i <= letters.length; i++) {
    const before = letters.slice(0, i).join("")
    const after = letters.slice(i).join("")
    for (const letter of ALPHABET) {
      add(before + letter + after)
      if (i < letters.length) add(before + letter + letters.slice(i + 1).join(""))
    }
    if (i < letters.length) add(before + letters.slice(i + 1).join(""))
    if (i + 1 < letters.length)
      add(before + letters[i + 1] + letters[i] + letters.slice(i + 2).join(""))
  }
  return [...variants] // At most 3,837 literal keys for a 50-character hint.
}

const distance = (a: string, b: string): number => {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 0; i < a.length; i++) {
    const row = [i + 1]
    for (let j = 0; j < b.length; j++)
      row.push(
        Math.min(row[j] + 1, previous[j + 1] + 1, previous[j] + (a[i] === b[j] ? 0 : 1)),
      )
    previous = row
  }
  return previous[b.length]
}

export const rankUsernameSearch = (
  query: string,
  candidates: readonly string[],
): string[] => {
  const folded = (name: string) => name.toLowerCase().replace(/_/g, "")
  const hint = folded(query)
  return [...new Set(candidates)]
    .filter((name) => UsernameRegex.test(name))
    .map((name) => {
      const value = folded(name)
      return {
        name,
        prefix: value.startsWith(hint),
        score: distance(hint, value) / Math.max(hint.length, value.length),
      }
    })
    .filter((row) => row.prefix || row.score <= 0.45)
    .sort(
      (a, b) =>
        Number(b.prefix) - Number(a.prefix) ||
        a.score - b.score ||
        a.name.localeCompare(b.name),
    )
    .slice(0, USERNAME_SEARCH_LIMIT)
    .map((row) => row.name)
}
