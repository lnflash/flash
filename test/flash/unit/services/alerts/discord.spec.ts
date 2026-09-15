const mockPost = jest.fn()
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...a: unknown[]) => mockPost(...a) },
  isAxiosError: (error: unknown) =>
    Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
}))

const mockAlertDiscordUrl = {
  value: "https://discord.test/webhook" as string | undefined,
}
// Both clusters run NETWORK=mainnet; only the IBEX environment differs. The
// mock exposes both so the tests can pin that NETWORK is ignored.
const mockEnv = { ibex: "sandbox" as string | undefined, network: "mainnet" }
jest.mock("@config", () => ({
  get ALERT_DISCORD_WEBHOOK_URL() {
    return mockAlertDiscordUrl.value
  },
  get IbexConfig() {
    return { environment: mockEnv.ibex }
  },
  get NETWORK() {
    return mockEnv.network
  },
}))

jest.mock("@services/tracing", () => ({ recordExceptionInCurrentSpan: jest.fn() }))

import { sendDiscord } from "@services/alerts/discord"
import { BridgeAlert } from "@services/alerts/index.types"

const baseAlert: BridgeAlert = {
  dedupKey: "fygaro:not-credited:tx1",
  source: "fygaro-webhook",
  severity: "warning",
  title: "Fygaro auto-credit disabled in settings — payment recorded, not auto-credited",
  detail: "reason=auto-credit-disabled currency=USD gross=1.97",
  context: {
    transaction_id: "d994e6b2-6848",
    amount: "1.97",
    reason: "auto-credit-disabled",
  },
}

const lastEmbed = () => mockPost.mock.calls.at(-1)?.[1]?.embeds?.[0]

beforeEach(() => {
  jest.clearAllMocks()
  mockAlertDiscordUrl.value = "https://discord.test/webhook"
  mockEnv.ibex = "sandbox"
  mockEnv.network = "mainnet"
})

describe("sendDiscord", () => {
  it("posts a single rich embed, not a raw content dump", async () => {
    await sendDiscord(baseAlert)

    expect(mockPost).toHaveBeenCalledTimes(1)
    const body = mockPost.mock.calls[0][1]
    expect(body.content).toBeUndefined()
    expect(Array.isArray(body.embeds)).toBe(true)
    expect(body.embeds).toHaveLength(1)
  })

  it("uses a friendly author label per source, not a hardcoded 'Bridge alert'", async () => {
    await sendDiscord(baseAlert)
    expect(lastEmbed().author.name).toBe("Fygaro · TEST")

    await sendDiscord({ ...baseAlert, source: "bridge-webhook" })
    expect(lastEmbed().author.name).toBe("Bridge · TEST")
  })

  describe("environment stamp", () => {
    // A test-cluster probe and a prod outage used to render identically; the
    // env must be visible in the author line, the title, AND a field so it
    // survives whichever part of the embed the reader (or Discord) trims.
    // Regression: the TEST cluster is NETWORK=mainnet + ibex sandbox (chart
    // default, not overridden). A NETWORK-derived tag rendered every TEST
    // alert as PROD — the exact curl probe this PR was opened for.
    it("stamps TEST on ibex sandbox even though NETWORK is mainnet (the real TEST cluster)", async () => {
      mockEnv.network = "mainnet"
      mockEnv.ibex = "sandbox"
      await sendDiscord(baseAlert)
      const embed = lastEmbed()
      expect(embed.author.name).toBe("Fygaro · TEST")
      expect(embed.title).toBe(`[TEST] ${baseAlert.title}`)
      expect(embed.fields[0]).toEqual({
        name: "Env",
        value: "TEST (ibex:sandbox)",
        inline: true,
      })
      expect(JSON.stringify(embed)).not.toContain("PROD")
    })

    it("stamps PROD only on ibex production", async () => {
      mockEnv.ibex = "production"
      await sendDiscord(baseAlert)
      const embed = lastEmbed()
      expect(embed.author.name).toBe("Fygaro · PROD")
      expect(embed.title).toBe(`[PROD] ${baseAlert.title}`)
      expect(embed.fields[0]).toEqual({
        name: "Env",
        value: "PROD (ibex:production)",
        inline: true,
      })
    })

    it.each(["mainnet", "signet", "testnet", "regtest"])(
      "ignores NETWORK=%s — the tag follows the ibex environment only",
      async (network) => {
        mockEnv.network = network
        mockEnv.ibex = "sandbox"
        await sendDiscord(baseAlert)
        expect(lastEmbed().author.name).toBe("Fygaro · TEST")
        mockEnv.ibex = "production"
        await sendDiscord(baseAlert)
        expect(lastEmbed().author.name).toBe("Fygaro · PROD")
      },
    )

    it("never claims PROD or TEST when the ibex environment is unset", async () => {
      mockEnv.ibex = undefined
      await sendDiscord(baseAlert)
      const embed = lastEmbed()
      expect(embed.author.name).toBe("Fygaro · UNKNOWN")
      expect(embed.title.startsWith("[UNKNOWN] ")).toBe(true)
      expect(embed.fields[0].value).toBe("UNKNOWN (ibex:unset)")
    })

    it("keeps the env field ahead of Source/Severity/context so budget trimming drops it last", async () => {
      await sendDiscord(baseAlert)
      const names = lastEmbed().fields.map((f: { name: string }) => f.name)
      expect(names.slice(0, 3)).toEqual(["Env", "Source", "Severity"])
    })

    it("still caps the prefixed title at Discord's limit", async () => {
      await sendDiscord({ ...baseAlert, title: "x".repeat(300) })
      const title = lastEmbed().title
      expect(title.length).toBeLessThanOrEqual(256)
      expect(title.startsWith("[TEST] ")).toBe(true)
    })
  })

  it("colors critical red and warning amber", async () => {
    await sendDiscord({ ...baseAlert, severity: "critical" })
    expect(lastEmbed().color).toBe(0xe01e5a)

    await sendDiscord({ ...baseAlert, severity: "warning" })
    expect(lastEmbed().color).toBe(0xf2c744)
  })

  it("renders each context entry as its own Title-Cased field, no JSON blob", async () => {
    await sendDiscord(baseAlert)
    const embed = lastEmbed()
    const names = embed.fields.map((f: { name: string }) => f.name)
    expect(names).toEqual(
      expect.arrayContaining([
        "Source",
        "Severity",
        "Transaction Id",
        "Amount",
        "Reason",
      ]),
    )
    expect(JSON.stringify(embed)).not.toContain("```")
  })

  it("skips null/undefined/empty context values (Discord rejects empty field values)", async () => {
    await sendDiscord({
      ...baseAlert,
      context: { good: "x", empty: "", missing: undefined, none: null },
    })
    const values = lastEmbed().fields.map((f: { value: string }) => f.value)
    expect(values).not.toContain("")
    expect(lastEmbed().fields.some((f: { name: string }) => f.name === "Good")).toBe(true)
    expect(
      lastEmbed().fields.some((f: { name: string }) => /Empty|Missing|None/.test(f.name)),
    ).toBe(false)
  })

  it("caps fields at Discord's 25-field limit", async () => {
    const context: Record<string, string> = {}
    for (let i = 0; i < 40; i++) context[`k${i}`] = `v${i}`
    await sendDiscord({ ...baseAlert, context })
    expect(lastEmbed().fields.length).toBeLessThanOrEqual(25)
  })

  it("no-ops when the alert Discord webhook url is unset", async () => {
    mockAlertDiscordUrl.value = undefined
    await sendDiscord(baseAlert)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("caps an over-long title at exactly 256 chars ending with an ellipsis", async () => {
    await sendDiscord({ ...baseAlert, title: "T".repeat(300) })
    const { title } = lastEmbed()
    expect(title.length).toBe(256)
    expect(title.endsWith("…")).toBe(true)
  })

  it("caps an over-long field value at exactly 1024 chars ending with an ellipsis", async () => {
    await sendDiscord({ ...baseAlert, context: { note: "v".repeat(2000) } })
    const note = lastEmbed().fields.find((f: { name: string }) => f.name === "Note")
    expect(note.value.length).toBe(1024)
    expect(note.value.endsWith("…")).toBe(true)
  })

  it("Title-Cases a camelCase context key: balanceUsd -> Balance Usd", async () => {
    await sendDiscord({ ...baseAlert, context: { balanceUsd: "5.00" } })
    const names = lastEmbed().fields.map((f: { name: string }) => f.name)
    expect(names).toContain("Balance Usd")
  })

  it("falls back to the raw source string for an unmapped author label", async () => {
    const alert = { ...baseAlert, source: "unmapped-source" } as unknown as BridgeAlert
    await sendDiscord(alert)
    expect(lastEmbed().author.name).toBe("unmapped-source · TEST")
  })

  it("keeps the embed under Discord's 6000-char aggregate limit, dropping trailing fields", async () => {
    const context: Record<string, string> = {}
    // Ten fields whose values each hit the 1024 per-field cap sum to > 6000
    // even after per-field truncation; the aggregate clamp must intervene.
    for (let i = 0; i < 10; i++) context[`field_${i}`] = "x".repeat(1024)

    await sendDiscord({ ...baseAlert, context })

    const embed = lastEmbed()
    const total =
      (embed.author?.name.length ?? 0) +
      embed.title.length +
      (embed.description?.length ?? 0) +
      embed.fields.reduce(
        (sum: number, f: { name: string; value: string }) =>
          sum + f.name.length + f.value.length,
        0,
      )
    expect(total).toBeLessThanOrEqual(6000)
    // Some fields had to be dropped: Source + Severity + 10 context = 12 built.
    expect(embed.fields.length).toBeLessThan(12)
  })

  it("retries once honoring retry_after on a 429 instead of dropping the alert", async () => {
    mockPost
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 429, data: { retry_after: 0.01 }, headers: {} },
      })
      .mockResolvedValueOnce({ status: 204 })

    const started = Date.now()
    await sendDiscord({ ...baseAlert, severity: "critical" })

    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9)
    // The retry posts the same embed body — the alert is delivered, not dropped.
    expect(mockPost.mock.calls[1][1]).toEqual(mockPost.mock.calls[0][1])
  })
})
