const mockNetwork = { value: "signet" as string | undefined }
const mockSlackUrl = { value: "https://slack.test/webhook" as string | undefined }
jest.mock("@config", () => ({
  get ALERT_SLACK_WEBHOOK_URL() {
    return mockSlackUrl.value
  },
  get NETWORK() {
    return mockNetwork.value
  },
}))

jest.mock("@services/tracing", () => ({ recordExceptionInCurrentSpan: jest.fn() }))

const mockPost = jest.fn()
jest.mock("axios", () => ({
  __esModule: true,
  default: { post: (...a: unknown[]) => mockPost(...a) },
}))

import { sendSlack } from "@services/alerts/slack"
import { BridgeAlert } from "@services/alerts/index.types"
import { recordExceptionInCurrentSpan } from "@services/tracing"

const baseAlert: BridgeAlert = {
  dedupKey: "fygaro:signature-failure",
  source: "fygaro-webhook",
  severity: "warning",
  title: "Fygaro webhook signature verification failing — check the webhook secret",
  detail: "HMAC signature mismatch — secret likely rotated or wrong",
  context: { key_id: "x" },
}

const lastText = (): string => mockPost.mock.calls.at(-1)?.[1]?.text

beforeEach(() => {
  jest.clearAllMocks()
  mockPost.mockResolvedValue({ status: 200 })
  mockSlackUrl.value = "https://slack.test/webhook"
  mockNetwork.value = "signet"
})

describe("sendSlack", () => {
  it("no-ops when the webhook URL is unset", async () => {
    mockSlackUrl.value = undefined
    await sendSlack(baseAlert)
    expect(mockPost).not.toHaveBeenCalled()
  })

  it("stamps TEST in the headline and the env line on a non-mainnet network", async () => {
    await sendSlack(baseAlert)
    const [headline, meta] = lastText().split("\n")
    expect(headline).toBe(`:warning: *[TEST] Bridge alert* - ${baseAlert.title}`)
    expect(meta).toBe(
      "*env:* `TEST (signet)`  *source:* `fygaro-webhook`  *severity:* `warning`",
    )
  })

  it("stamps PROD on mainnet and uses the siren for critical", async () => {
    mockNetwork.value = "mainnet"
    await sendSlack({ ...baseAlert, severity: "critical" })
    const [headline, meta] = lastText().split("\n")
    expect(headline.startsWith(":rotating_light: *[PROD] Bridge alert*")).toBe(true)
    expect(meta.startsWith("*env:* `PROD (mainnet)`")).toBe(true)
  })

  it("keeps detail and context in the body", async () => {
    await sendSlack(baseAlert)
    const text = lastText()
    expect(text).toContain(baseAlert.detail)
    expect(text).toContain('"key_id": "x"')
  })

  it("swallows delivery failures as a Warn", async () => {
    mockPost.mockRejectedValueOnce(new Error("boom"))
    await expect(sendSlack(baseAlert)).resolves.toBeUndefined()
    expect(recordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
  })
})
