export const checkValidNpub = (npub: string): boolean => {
  return npub.startsWith("npub1") && npub.length === 63
}
