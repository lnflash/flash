import {
  AccountLevel,
  AccountStatusHeadline,
  deriveCapabilitiesForAccount,
  deriveLevelFromCapabilities,
  deriveStatusHeadline,
} from "@domain/accounts"

const caps = (overrides: Partial<AccountCapabilities>): AccountCapabilities => ({
  verified: false,
  bankPayout: false,
  business: false,
  usdAccount: false,
  ...overrides,
})

describe("deriveLevelFromCapabilities", () => {
  it("gives L0 when not verified, regardless of other flags", () => {
    expect(deriveLevelFromCapabilities(caps({}))).toEqual(AccountLevel.Zero)
    expect(
      deriveLevelFromCapabilities(caps({ bankPayout: true, business: true })),
    ).toEqual(AccountLevel.Zero)
  })

  it("gives L1 for verified only", () => {
    expect(deriveLevelFromCapabilities(caps({ verified: true }))).toEqual(
      AccountLevel.One,
    )
  })

  it("gives L2 for verified + bank payout without business (business-less Pro)", () => {
    expect(
      deriveLevelFromCapabilities(caps({ verified: true, bankPayout: true })),
    ).toEqual(AccountLevel.Two)
  })

  it("gives L3 for verified + business + bank payout", () => {
    expect(
      deriveLevelFromCapabilities(
        caps({ verified: true, bankPayout: true, business: true }),
      ),
    ).toEqual(AccountLevel.Three)
  })

  it("does not reach L3 for business without a bank account", () => {
    expect(deriveLevelFromCapabilities(caps({ verified: true, business: true }))).toEqual(
      AccountLevel.One,
    )
  })

  it("ignores usdAccount — Bridge is orthogonal to the level", () => {
    expect(
      deriveLevelFromCapabilities(caps({ verified: true, usdAccount: true })),
    ).toEqual(AccountLevel.One)
    expect(
      deriveLevelFromCapabilities(
        caps({ verified: true, bankPayout: true, usdAccount: true }),
      ),
    ).toEqual(AccountLevel.Two)
  })
})

describe("deriveStatusHeadline (light headline status)", () => {
  it("reads Trial when not verified", () => {
    expect(deriveStatusHeadline(caps({}))).toEqual(AccountStatusHeadline.Trial)
  })

  it("reads Verified for L1 and L2 — bank payout is a badge, not a tier", () => {
    expect(deriveStatusHeadline(caps({ verified: true }))).toEqual(
      AccountStatusHeadline.Verified,
    )
    expect(deriveStatusHeadline(caps({ verified: true, bankPayout: true }))).toEqual(
      AccountStatusHeadline.Verified,
    )
  })

  it("reads Business only for a complete business setup", () => {
    expect(
      deriveStatusHeadline(caps({ verified: true, bankPayout: true, business: true })),
    ).toEqual(AccountStatusHeadline.Business)
    expect(deriveStatusHeadline(caps({ verified: true, business: true }))).toEqual(
      AccountStatusHeadline.Verified,
    )
  })

  it("is unaffected by usdAccount", () => {
    expect(deriveStatusHeadline(caps({ verified: true, usdAccount: true }))).toEqual(
      AccountStatusHeadline.Verified,
    )
  })
})

describe("deriveCapabilitiesForAccount (read model)", () => {
  it("maps a fresh L0 account to no capabilities", () => {
    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.Zero,
        hasBankAccountOnFile: false,
      }),
    ).toEqual(caps({}))
  })

  it("maps stored levels to grandfathered flags", () => {
    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.One,
        hasBankAccountOnFile: false,
      }),
    ).toEqual(caps({ verified: true }))

    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.Two,
        hasBankAccountOnFile: false,
      }),
    ).toEqual(caps({ verified: true, bankPayout: true }))

    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.Three,
        hasBankAccountOnFile: true,
      }),
    ).toEqual(caps({ verified: true, bankPayout: true, business: true }))
  })

  it("flags bankPayout from an actual bank account on file at L1", () => {
    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.One,
        hasBankAccountOnFile: true,
      }),
    ).toEqual(caps({ verified: true, bankPayout: true }))
  })

  it("flags usdAccount only for approved Bridge KYC", () => {
    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.One,
        hasBankAccountOnFile: false,
        bridgeKycStatus: "approved",
      }),
    ).toEqual(caps({ verified: true, usdAccount: true }))

    expect(
      deriveCapabilitiesForAccount({
        level: AccountLevel.One,
        hasBankAccountOnFile: false,
        bridgeKycStatus: "under_review",
      }),
    ).toEqual(caps({ verified: true }))
  })

  it("round-trips: derived level matches stored level for consistent accounts", () => {
    for (const level of [
      AccountLevel.Zero,
      AccountLevel.One,
      AccountLevel.Two,
      AccountLevel.Three,
    ]) {
      const derived = deriveCapabilitiesForAccount({
        level,
        hasBankAccountOnFile: level >= AccountLevel.Two,
      })
      expect(deriveLevelFromCapabilities(derived)).toEqual(level)
    }
  })
})
