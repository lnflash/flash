// Closed messaging codes from the installed Firebase Admin SDK's
// MessagingClientErrorCode table; quota-exceeded is retained for existing FCM
// v1 operator contracts. Unknown provider strings are never telemetry values.
const messagingCodes = new Set(
  [
    "invalid-argument",
    "invalid-recipient",
    "invalid-payload",
    "invalid-data-payload-key",
    "payload-size-limit-exceeded",
    "invalid-options",
    "invalid-registration-token",
    "registration-token-not-registered",
    "mismatched-credential",
    "invalid-package-name",
    "device-message-rate-exceeded",
    "topics-message-rate-exceeded",
    "message-rate-exceeded",
    "third-party-auth-error",
    "too-many-topics",
    "authentication-error",
    "server-unavailable",
    "internal-error",
    "unknown-error",
    "quota-exceeded",
  ].map((code) => `messaging/${code}`),
)

export const safeFirebaseMessagingCode = (error: unknown): string => {
  const code =
    typeof error === "object" && error !== null
      ? (error as { code?: unknown }).code
      : undefined
  return typeof code === "string" && messagingCodes.has(code)
    ? code
    : "messaging/unknown-error"
}

// Provider counts are telemetry only; malformed values must not become an
// alternate channel for arbitrary provider response text.
export const safeFirebaseCount = (count: unknown, maximum: number): number | undefined =>
  typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= maximum
    ? count
    : undefined
