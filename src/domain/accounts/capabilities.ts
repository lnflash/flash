import { AccountLevel } from "./primitives"

// ENG-516: account capability state machine.
//
// The account is modelled as a set of capability flags; the numeric backend
// level (L0–L3) is derived from them and is internal-only — it is never shown
// to the user as a tier they pick. User-facing nomenclature leads with a
// single headline status (Trial → Verified → Business, the "light headline
// status" product decision of 2026-07-14) with capability badges as
// supporting detail. "Pro" and "International" are retired as labels;
// "Merchant" is renamed "Business"; the USD account (Bridge) is an
// orthogonal capability, not a tier.

export const AccountStatusHeadline = {
  Trial: "TRIAL",
  Verified: "VERIFIED",
  Business: "BUSINESS",
} as const

// Capabilities a user can request through the upgrade flow. usdAccount is
// excluded: it is granted by the Bridge KYC flow, and verified is granted by
// the identity flow, not by an upgrade request.
export const RequestableCapability = {
  BankPayout: "bankPayout",
  Business: "business",
} as const

// Derive the internal account level from capability flags.
//
//   verified (phone + ID)                          → L1
//   + bankPayout (bank on file), individual        → L2 (business-less Pro, ENG-515)
//   + business (name + address) + bankPayout       → L3
//
// usdAccount (Bridge KYC) is orthogonal and does not affect the level.
// business without bankPayout is an incomplete business setup and does not
// reach L3 — the bank account is part of the L3 requirements.
export const deriveLevelFromCapabilities = (
  capabilities: AccountCapabilities,
): AccountLevel => {
  if (!capabilities.verified) return AccountLevel.Zero
  if (capabilities.business && capabilities.bankPayout) return AccountLevel.Three
  if (capabilities.bankPayout) return AccountLevel.Two
  return AccountLevel.One
}

// The single user-facing status word (light headline status). Levels 1 and 2
// both read "Verified" — bank payout shows as a capability badge, not a tier.
export const deriveStatusHeadline = (
  capabilities: AccountCapabilities,
): AccountStatusHeadline => {
  const level = deriveLevelFromCapabilities(capabilities)
  if (level >= AccountLevel.Three) return AccountStatusHeadline.Business
  if (level >= AccountLevel.One) return AccountStatusHeadline.Verified
  return AccountStatusHeadline.Trial
}

// Read-model derivation for existing accounts. The stored level is the
// current source of truth for verified/business (accounts were only ever
// levelled up through flows that satisfied those requirements), so legacy
// accounts are grandfathered:
//   verified  — stored level ≥ 1
//   business  — stored level ≥ 3
//   bankPayout — an approved bank account on file (ERPNext); legacy L2/L3
//                accounts imply one even if the lookup is unavailable
//   usdAccount — Bridge KYC approved
export const deriveCapabilitiesForAccount = ({
  level,
  hasBankAccountOnFile,
  bridgeKycStatus,
}: {
  level: AccountLevel
  hasBankAccountOnFile: boolean
  bridgeKycStatus?: string
}): AccountCapabilities => ({
  verified: level >= AccountLevel.One,
  bankPayout: hasBankAccountOnFile || level >= AccountLevel.Two,
  business: level >= AccountLevel.Three,
  usdAccount: bridgeKycStatus === "approved",
})
