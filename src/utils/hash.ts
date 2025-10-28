import { createHash, randomBytes } from "crypto"

export const sha256 = (data: string): string => {
  return createHash("sha256").update(data).digest("hex")
}

export const generateSecureToken = (bytes: number = 20): string => {
  return randomBytes(bytes).toString("hex")
}

export const hashToken = (token: string): string => {
  return sha256(token)
}

export const generateInviteToken = (): { token: string; tokenHash: string } => {
  const token = generateSecureToken(20)
  const tokenHash = hashToken(token)
  return { token, tokenHash }
}