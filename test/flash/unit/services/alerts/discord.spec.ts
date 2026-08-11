const mockPost = jest.fn()
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...a: unknown[]) => mockPost(...a) },
}))

const mockAlertDiscordUrl = {
  value: "https://discord.test/webhook" as string | undefined,
}
jest.mock("@config", () => ({
  get ALERT_DISCORD_WEBHOOK_URL() {
    return mockAlertDiscordUrl.value
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
    expect(lastEmbed().author.name).toBe("Fygaro")

    await sendDiscord({ ...baseAlert, source: "bridge-webhook" })
    expect(lastEmbed().author.name).toBe("Bridge")
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
})
