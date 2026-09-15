// Both clusters run NETWORK=mainnet; only the IBEX environment differs.
const mockEnv = { ibex: "sandbox" as string | undefined, network: "mainnet" }
const mockSlackUrl = { value: "https://slack.test/webhook" as string | undefined }
jest.mock("@config", () => ({
  get ALERT_SLACK_WEBHOOK_URL() {
    return mockSlackUrl.value
  },
  get IbexConfig() {
    return { environment: mockEnv.ibex }
  },
  get NETWORK() {
    return mockEnv.network
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
  mockEnv.ibex = "sandbox"
  mockEnv.network = "mainnet"
})

describe("sendSlack", () => {
  it("no-ops when the webhook URL is unset", async () => {
    mockSlackUrl.value = undefined
    await sendSlack(baseAlert)
    expect(mockPost).not.toHaveBeenCalled()
  })

  // Regression: the TEST cluster is NETWORK=mainnet + ibex sandbox. A
  // NETWORK-derived tag rendered it as PROD.
  it("stamps TEST in the headline and the env line on ibex sandbox, even with NETWORK=mainnet", async () => {
    mockEnv.network = "mainnet"
    mockEnv.ibex = "sandbox"
    await sendSlack(baseAlert)
    const [headline, meta] = lastText().split("\n")
    expect(headline).toBe(`:warning: *[TEST] Bridge alert* - ${baseAlert.title}`)
    expect(meta).toBe(
      "*env:* `TEST (ibex:sandbox)`  *source:* `fygaro-webhook`  *severity:* `warning`",
    )
    expect(lastText()).not.toContain("PROD")
  })

  it("stamps PROD on ibex production and uses the siren for critical", async () => {
    mockEnv.ibex = "production"
    await sendSlack({ ...baseAlert, severity: "critical" })
    const [headline, meta] = lastText().split("\n")
    expect(headline.startsWith(":rotating_light: *[PROD] Bridge alert*")).toBe(true)
    expect(meta.startsWith("*env:* `PROD (ibex:production)`")).toBe(true)
  })

  it("stamps UNKNOWN when the ibex environment is unset", async () => {
    mockEnv.ibex = undefined
    await sendSlack(baseAlert)
    const [headline, meta] = lastText().split("\n")
    expect(headline.startsWith(":warning: *[UNKNOWN] Bridge alert*")).toBe(true)
    expect(meta.startsWith("*env:* `UNKNOWN (ibex:unset)`")).toBe(true)
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
