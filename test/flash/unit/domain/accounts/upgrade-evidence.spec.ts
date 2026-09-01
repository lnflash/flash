import {
  AccountLevel,
  IdentitySource,
  UpgradeEvidenceType,
  applyBridgeKycFallback,
  identitySourceFor,
  legacyIdDocumentKey,
  normalizeEvidence,
  validateEvidence,
} from "@domain/accounts"
import { ValidationError } from "@domain/shared"

const username = "alice"
const own = (file: string) => `id_documents/${username}_${file}`
const SHA = "a".repeat(64)

describe("normalizeEvidence", () => {
  it("turns the legacy idDocument into one ID_FRONT row", () => {
    expect(normalizeEvidence({ idDocument: own("front.jpg") })).toEqual([
      { type: UpgradeEvidenceType.IdFront, fileKey: own("front.jpg"), legacy: true },
    ])
  })

  it("returns an empty list when nothing was supplied", () => {
    expect(normalizeEvidence({})).toEqual([])
    expect(normalizeEvidence({ evidence: null, idDocument: "" })).toEqual([])
    expect(normalizeEvidence({ idDocument: "   " })).toEqual([])
  })

  it("keeps structured rows and trims / canonicalizes their fields", () => {
    const rows = normalizeEvidence({
      evidence: [
        {
          type: UpgradeEvidenceType.Selfie,
          fileKey: ` ${own("selfie.jpg")} `,
          sha256: SHA.toUpperCase(),
          documentType: null,
          issuingCountry: "jm",
        },
      ],
    })
    expect(rows).toEqual([
      {
        type: UpgradeEvidenceType.Selfie,
        fileKey: own("selfie.jpg"),
        sha256: SHA,
        documentType: undefined,
        issuingCountry: "JM",
      },
    ])
  })

  it("does not duplicate the legacy key when evidence already carries it", () => {
    const rows = normalizeEvidence({
      evidence: [{ type: UpgradeEvidenceType.IdFront, fileKey: own("front.jpg") }],
      idDocument: own("front.jpg"),
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].legacy).toBeUndefined()
  })

  it("appends the legacy key as a second ID_FRONT when it differs", () => {
    const rows = normalizeEvidence({
      evidence: [{ type: UpgradeEvidenceType.Selfie, fileKey: own("selfie.jpg") }],
      idDocument: own("front.jpg"),
    })
    expect(rows.map((r) => r.type)).toEqual([
      UpgradeEvidenceType.Selfie,
      UpgradeEvidenceType.IdFront,
    ])
  })
})

describe("applyBridgeKycFallback", () => {
  it("adds a BRIDGE_KYC row when nothing was submitted and Bridge KYC is approved", () => {
    expect(applyBridgeKycFallback({ evidence: [], bridgeKycApproved: true })).toEqual([
      { type: UpgradeEvidenceType.BridgeKyc },
    ])
  })

  it("leaves an empty list alone when Bridge KYC is not approved", () => {
    expect(applyBridgeKycFallback({ evidence: [], bridgeKycApproved: false })).toEqual([])
  })

  it("leaves a non-empty list alone", () => {
    const evidence = [{ type: UpgradeEvidenceType.IdFront, fileKey: own("f.jpg") }]
    expect(applyBridgeKycFallback({ evidence, bridgeKycApproved: true })).toBe(evidence)
  })
})

describe("legacyIdDocumentKey / identitySourceFor", () => {
  it("picks the first ID_FRONT file key", () => {
    expect(
      legacyIdDocumentKey([
        { type: UpgradeEvidenceType.Selfie, fileKey: own("s.jpg") },
        { type: UpgradeEvidenceType.IdFront, fileKey: own("f1.jpg") },
        { type: UpgradeEvidenceType.IdFront, fileKey: own("f2.jpg") },
      ]),
    ).toBe(own("f1.jpg"))
    expect(legacyIdDocumentKey([{ type: UpgradeEvidenceType.BridgeKyc }])).toBe("")
  })

  it("is bridge_kyc only with an approved Bridge KYC and a BRIDGE_KYC row", () => {
    const bridge = [{ type: UpgradeEvidenceType.BridgeKyc }]
    expect(identitySourceFor({ evidence: bridge, bridgeKycApproved: true })).toBe(
      IdentitySource.BridgeKyc,
    )
    expect(identitySourceFor({ evidence: bridge, bridgeKycApproved: false })).toBe(
      IdentitySource.Capture,
    )
    expect(
      identitySourceFor({
        evidence: [{ type: UpgradeEvidenceType.IdFront, fileKey: own("f.jpg") }],
        bridgeKycApproved: true,
      }),
    ).toBe(IdentitySource.Capture)
  })
})

describe("validateEvidence", () => {
  const base = { username, level: AccountLevel.Two, bridgeKycApproved: false }

  describe("non-strict (current mobile app)", () => {
    it("accepts an empty list for level 2", () => {
      expect(validateEvidence({ ...base, evidence: [], strict: false })).toBe(true)
    })

    it("accepts the legacy idDocument row whatever its key looks like", () => {
      const evidence = normalizeEvidence({ idDocument: "doc-1" })
      expect(validateEvidence({ ...base, evidence, strict: false })).toBe(true)
    })

    it("still holds structured rows to the id_documents/<username>_ prefix", () => {
      const foreign = [
        { type: UpgradeEvidenceType.IdFront, fileKey: "id_documents/bob_f.jpg" },
      ]
      expect(
        validateEvidence({ ...base, evidence: foreign, strict: false }),
      ).toBeInstanceOf(ValidationError)
      const outside = [
        { type: UpgradeEvidenceType.IdFront, fileKey: "other/alice_f.jpg" },
      ]
      expect(
        validateEvidence({ ...base, evidence: outside, strict: false }),
      ).toBeInstanceOf(ValidationError)
    })

    it("requires a file key on structured capture rows", () => {
      const evidence = [{ type: UpgradeEvidenceType.Selfie }]
      expect(validateEvidence({ ...base, evidence, strict: false })).toBeInstanceOf(
        ValidationError,
      )
    })

    it("rejects a BRIDGE_KYC row when the account's Bridge KYC is not approved", () => {
      const evidence = [{ type: UpgradeEvidenceType.BridgeKyc }]
      expect(validateEvidence({ ...base, evidence, strict: false })).toBeInstanceOf(
        ValidationError,
      )
      expect(
        validateEvidence({ ...base, evidence, bridgeKycApproved: true, strict: false }),
      ).toBe(true)
    })

    it("rejects a malformed sha256", () => {
      const evidence = [
        { type: UpgradeEvidenceType.IdFront, fileKey: own("f.jpg"), sha256: "not-hex" },
      ]
      expect(validateEvidence({ ...base, evidence, strict: false })).toBeInstanceOf(
        ValidationError,
      )
    })

    it("rejects an unknown evidence type", () => {
      const evidence = [
        { type: "passport" as UpgradeEvidenceType, fileKey: own("f.jpg") },
      ]
      expect(validateEvidence({ ...base, evidence, strict: false })).toBeInstanceOf(
        ValidationError,
      )
    })
  })

  describe("strict", () => {
    const front = { type: UpgradeEvidenceType.IdFront, fileKey: own("front.jpg") }
    const selfie = { type: UpgradeEvidenceType.Selfie, fileKey: own("selfie.jpg") }

    it("level 2 needs ID_FRONT + SELFIE", () => {
      expect(validateEvidence({ ...base, evidence: [front, selfie], strict: true })).toBe(
        true,
      )
      expect(
        validateEvidence({ ...base, evidence: [front], strict: true }),
      ).toBeInstanceOf(ValidationError)
      expect(validateEvidence({ ...base, evidence: [], strict: true })).toBeInstanceOf(
        ValidationError,
      )
    })

    it("level 3 has the same identity requirement", () => {
      expect(
        validateEvidence({
          ...base,
          level: AccountLevel.Three,
          evidence: [front, selfie],
          strict: true,
        }),
      ).toBe(true)
      expect(
        validateEvidence({
          ...base,
          level: AccountLevel.Three,
          evidence: [selfie],
          strict: true,
        }),
      ).toBeInstanceOf(ValidationError)
    })

    it("an approved BRIDGE_KYC row satisfies the identity requirement", () => {
      const evidence = [{ type: UpgradeEvidenceType.BridgeKyc }]
      expect(
        validateEvidence({ ...base, evidence, bridgeKycApproved: true, strict: true }),
      ).toBe(true)
      expect(
        validateEvidence({ ...base, evidence, bridgeKycApproved: false, strict: true }),
      ).toBeInstanceOf(ValidationError)
    })

    it("the legacy idDocument row must then also point at the account's own upload", () => {
      const legacyForeign = normalizeEvidence({
        evidence: [selfie],
        idDocument: "id_documents/bob_front.jpg",
      })
      expect(
        validateEvidence({ ...base, evidence: legacyForeign, strict: true }),
      ).toBeInstanceOf(ValidationError)

      const legacyOwn = normalizeEvidence({
        evidence: [selfie],
        idDocument: own("front.jpg"),
      })
      expect(validateEvidence({ ...base, evidence: legacyOwn, strict: true })).toBe(true)
    })

    it("level 1 does not require identity evidence", () => {
      expect(
        validateEvidence({
          ...base,
          level: AccountLevel.One,
          evidence: [],
          strict: true,
        }),
      ).toBe(true)
    })
  })
})
