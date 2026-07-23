let mockWebhookUrl: string | undefined = "https://discord.test/api/webhooks/ops"

jest.mock("@config", () => ({
  get OPS_DISCORD_WEBHOOK_URL() {
    return mockWebhookUrl
  },
  NETWORK: "regtest",
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("axios", () => ({
  post: jest.fn(),
  isAxiosError: (error: unknown) =>
    Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
}))

import axios from "axios"

import { USDAmount, USDTAmount } from "@domain/shared"

import {
  buildEmbed,
  maskEmail,
  maskPhone,
  notifyOpsEvent,
  opsEventsSettled,
  toDisplayAmount,
  truncateId,
  OpsEvent,
} from "@services/alerts/ops-events"

const sendAndSettle = async (event: OpsEvent) => {
  notifyOpsEvent(event)
  await opsEventsSettled()
}

const mockPost = axios.post as jest.Mock

const baseEvent: OpsEvent = {
  flow: "verification",
  phase: "otp-sent",
  status: "pending",
}

const rateLimit429 = (retryAfterSecs: number) => ({
  isAxiosError: true,
  response: { status: 429, data: { retry_after: retryAfterSecs }, headers: {} },
})

describe("maskPhone", () => {
  it("keeps leading +, first 4 digits and last 2", () => {
    expect(maskPhone("+18765550100")).toBe("+1876…00")
  })

  it("works without a leading +", () => {
    expect(maskPhone("18765550100")).toBe("1876…00")
  })

  it("strips formatting characters before masking", () => {
    expect(maskPhone("+1 (876) 555-0100")).toBe("+1876…00")
  })

  it("does not reconstruct short numbers", () => {
    expect(maskPhone("+123456")).toBe("+12…")
    expect(maskPhone("12")).toBe("12…")
  })

  it("handles empty/garbage input", () => {
    expect(maskPhone("")).toBe("…")
    expect(maskPhone("+")).toBe("+…")
  })
})

describe("maskEmail", () => {
  it("keeps first char and full domain", () => {
    expect(maskEmail("jabari@gmail.com")).toBe("j***@gmail.com")
  })

  it("handles single-char local part", () => {
    expect(maskEmail("j@x.io")).toBe("j***@x.io")
  })

  it("masks fully when not an email", () => {
    expect(maskEmail("not-an-email")).toBe("***")
    expect(maskEmail("@no-local-part.com")).toBe("***")
  })
})

describe("truncateId", () => {
  it("truncates long ids to first 8 chars plus ellipsis", () => {
    expect(truncateId("64df1a2b3c4d5e6f78901234")).toBe("64df1a2b…")
  })

  it("keeps short ids as-is", () => {
    expect(truncateId("tr_12345")).toBe("tr_12345")
    expect(truncateId("123456789012")).toBe("123456789012")
  })
})

describe("toDisplayAmount", () => {
  it("renders USD cents as dollars", () => {
    const amount = USDAmount.cents("9540")
    if (amount instanceof Error) throw amount
    expect(toDisplayAmount(amount)).toEqual({ value: "95.40", currency: "USD" })
  })

  it("renders USDT micros as major units", () => {
    const amount = USDTAmount.usdCents("9540")
    if (amount instanceof Error) throw amount
    expect(toDisplayAmount(amount)).toEqual({ value: "95.40", currency: "USDT" })
  })
})

describe("buildEmbed", () => {
  it("titles the embed from flow and phase, uppercasing OTP", () => {
    const embed = buildEmbed({ ...baseEvent, phase: "otp-verified" })
    expect(embed.title).toBe("📲 Verification — OTP verified")
  })

  it.each([
    ["success" as const, 0x2ecc71],
    ["pending" as const, 0xf39c12],
    ["failed" as const, 0xe74c3c],
  ])("colors %s embeds correctly", (status, color) => {
    expect(buildEmbed({ ...baseEvent, status }).color).toBe(color)
  })

  it("masks identity fields and truncates ids", () => {
    const embed = buildEmbed({
      flow: "cashout",
      phase: "failed",
      status: "failed",
      accountId: "64df1a2b3c4d5e6f78901234",
      phone: "+18765550100",
      email: "jabari@gmail.com",
      step: "payInvoice",
      error: "IbexError",
      meta: { offerId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
    })

    expect(embed.title).toBe("💸 Cashout — failed")
    const byName = Object.fromEntries(embed.fields.map((f) => [f.name, f.value]))
    expect(byName.account).toBe("64df1a2b…")
    expect(byName.phone).toBe("+1876…00")
    expect(byName.email).toBe("j***@gmail.com")
    expect(byName.step).toBe("payInvoice")
    expect(byName.error).toBe("IbexError")
    expect(byName.offerId).toBe("aaaaaaaa…")
    expect(byName.env).toBe("regtest")
    expect(embed.timestamp).toEqual(expect.any(String))

    const rendered = JSON.stringify(embed)
    expect(rendered).not.toContain("18765550100")
    expect(rendered).not.toContain("jabari@")
  })

  it("renders amounts with currency", () => {
    const embed = buildEmbed({
      ...baseEvent,
      amount: { value: 500n, currency: "USD" },
    })
    const amount = embed.fields.find((f) => f.name === "amount")
    expect(amount?.value).toBe("500 USD")
  })
})

describe("notifyOpsEvent", () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockWebhookUrl = "https://discord.test/api/webhooks/ops"
    mockPost.mockResolvedValue({ status: 204 })
  })

  it("no-ops when OPS_DISCORD_WEBHOOK_URL is unset", async () => {
    mockWebhookUrl = undefined
    await sendAndSettle(baseEvent)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("posts a single embed to the webhook", async () => {
    await sendAndSettle(baseEvent)

    expect(mockPost).toHaveBeenCalledTimes(1)
    const [url, body, opts] = mockPost.mock.calls[0]
    expect(url).toBe("https://discord.test/api/webhooks/ops")
    expect(body.embeds).toHaveLength(1)
    expect(body.embeds[0].title).toBe("📲 Verification — OTP sent")
    expect(opts.timeout).toBe(3000)
  })

  it("never throws or rejects even when the post fails", async () => {
    mockPost.mockRejectedValue(new Error("boom"))
    expect(() => notifyOpsEvent(baseEvent)).not.toThrow()
    await expect(opsEventsSettled()).resolves.toBeUndefined()
  })

  it("sends events sequentially in FIFO order", async () => {
    notifyOpsEvent({ ...baseEvent, phase: "first" })
    notifyOpsEvent({ ...baseEvent, phase: "second" })
    await opsEventsSettled()

    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(mockPost.mock.calls[0][1].embeds[0].title).toContain("first")
    expect(mockPost.mock.calls[1][1].embeds[0].title).toContain("second")
  })

  it("retries once after a 429, honoring retry_after", async () => {
    mockPost
      .mockRejectedValueOnce(rateLimit429(0.01))
      .mockResolvedValueOnce({ status: 204 })

    const started = Date.now()
    await sendAndSettle(baseEvent)

    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9)
    expect(mockPost.mock.calls[1][1]).toEqual(mockPost.mock.calls[0][1])
  })

  it("gives up after the 429 retry also fails", async () => {
    mockPost
      .mockRejectedValueOnce(rateLimit429(0.01))
      .mockRejectedValueOnce(rateLimit429(0.01))
    await sendAndSettle(baseEvent)
    expect(mockPost).toHaveBeenCalledTimes(2)
  })

  it("does not retry non-429 failures", async () => {
    mockPost.mockRejectedValue(new Error("boom"))
    await sendAndSettle(baseEvent)
    expect(mockPost).toHaveBeenCalledTimes(1)
  })

  it("drops oldest events past the queue cap and emits one drop summary", async () => {
    let releaseFirst: (() => void) | undefined
    mockPost.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          releaseFirst = resolve
        }),
    )
    mockPost.mockResolvedValue({ status: 204 })

    const total = 60
    for (let i = 0; i < total; i++) {
      notifyOpsEvent({ ...baseEvent, phase: `event-${i}` })
    }
    // First post is in flight; 59 queued behind it; 9 oldest dropped past the cap.
    releaseFirst?.()
    await opsEventsSettled()

    // 1 in-flight + 50 queued survivors + 1 summary embed
    expect(mockPost).toHaveBeenCalledTimes(52)
    const lastBody = mockPost.mock.calls[51][1]
    expect(lastBody.embeds[0].title).toContain("9 events dropped")
    // Oldest queued events were the ones dropped
    const sentTitles = mockPost.mock.calls
      .slice(0, 51)
      .map((call) => call[1].embeds[0].title)
    expect(sentTitles[0]).toContain("event 0")
    expect(sentTitles[1]).toContain("event 10")
    expect(sentTitles[50]).toContain("event 59")
  })
})
