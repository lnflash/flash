import { claimInformSlot, resetInformDedup } from "@services/alerts/inform-dedup"

describe("claimInformSlot", () => {
  beforeEach(() => {
    resetInformDedup()
  })

  it("allows the first inform for a dedup key", () => {
    expect(claimInformSlot("erpnext-audit:deposit:tr_1", 1_000)).toBe(true)
  })

  it("suppresses duplicate informs within the TTL", () => {
    const key = "bridge-api:5xx"
    const start = 10_000

    expect(claimInformSlot(key, start)).toBe(true)
    expect(claimInformSlot(key, start + 1_000)).toBe(false)
    expect(claimInformSlot(key, start + 29 * 60 * 1000)).toBe(false)
  })

  it("allows a new inform after the TTL expires", () => {
    const key = "bridge-api:5xx"
    const start = 10_000

    expect(claimInformSlot(key, start)).toBe(true)
    expect(claimInformSlot(key, start + 30 * 60 * 1000)).toBe(true)
  })

  it("tracks different dedup keys independently", () => {
    expect(claimInformSlot("erpnext-audit:deposit:tr_a", 1_000)).toBe(true)
    expect(claimInformSlot("erpnext-audit:deposit:tr_b", 1_000)).toBe(true)
    expect(claimInformSlot("erpnext-audit:deposit:tr_a", 2_000)).toBe(false)
  })
})
