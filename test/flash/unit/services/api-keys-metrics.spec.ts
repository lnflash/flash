import { register } from "prom-client"

import {
  API_KEY_MANAGEMENT_METRIC,
  API_KEY_RATE_LIMITED_METRIC,
  API_KEY_VERIFICATION_METRIC,
  incApiKeyManagement,
  incApiKeyRateLimited,
  incApiKeyVerification,
} from "@services/api-keys-metrics"

type LabelValues = Partial<Record<string, string | number>>

const counterValues = async (name: string) => {
  const metric = register.getSingleMetric(name)
  if (!metric) {
    throw new Error(`metric not registered: ${name}`)
  }
  return (await metric.get()).values as { value: number; labels: LabelValues }[]
}

const valueWithLabels = (
  values: { value: number; labels: LabelValues }[],
  labels: LabelValues,
) =>
  values.find((v) =>
    Object.entries(labels).every(([name, value]) => v.labels[name] === value),
  )?.value

describe("api key metrics", () => {
  beforeEach(() => {
    register.resetMetrics()
  })

  it("registers all three counters on the default registry", () => {
    expect(register.getSingleMetric(API_KEY_VERIFICATION_METRIC)).toBeDefined()
    expect(register.getSingleMetric(API_KEY_RATE_LIMITED_METRIC)).toBeDefined()
    expect(register.getSingleMetric(API_KEY_MANAGEMENT_METRIC)).toBeDefined()
  })

  it("counts verification successes with reason ok", async () => {
    incApiKeyVerification("success")
    incApiKeyVerification("success")

    const values = await counterValues(API_KEY_VERIFICATION_METRIC)
    expect(valueWithLabels(values, { result: "success", reason: "ok" })).toBe(2)
  })

  it("counts verification denials by error class name", async () => {
    incApiKeyVerification("denied", "ApiKeyExpiredError")
    incApiKeyVerification("denied", "ApiKeyIpNotAllowedError")
    incApiKeyVerification("denied", "ApiKeyIpNotAllowedError")

    const values = await counterValues(API_KEY_VERIFICATION_METRIC)
    expect(
      valueWithLabels(values, { result: "denied", reason: "ApiKeyExpiredError" }),
    ).toBe(1)
    expect(
      valueWithLabels(values, { result: "denied", reason: "ApiKeyIpNotAllowedError" }),
    ).toBe(2)
  })

  it("normalizes a denial without a reason to unknown", async () => {
    incApiKeyVerification("denied")

    const values = await counterValues(API_KEY_VERIFICATION_METRIC)
    expect(valueWithLabels(values, { result: "denied", reason: "unknown" })).toBe(1)
  })

  it("counts rate-limited requests", async () => {
    incApiKeyRateLimited()
    incApiKeyRateLimited()
    incApiKeyRateLimited()

    const values = await counterValues(API_KEY_RATE_LIMITED_METRIC)
    expect(values).toHaveLength(1)
    expect(values[0].value).toBe(3)
  })

  it("counts management operations by operation and result", async () => {
    incApiKeyManagement("create", "success")
    incApiKeyManagement("create", "failure")
    incApiKeyManagement("rotate", "success")
    incApiKeyManagement("list", "success")

    const values = await counterValues(API_KEY_MANAGEMENT_METRIC)
    expect(valueWithLabels(values, { operation: "create", result: "success" })).toBe(1)
    expect(valueWithLabels(values, { operation: "create", result: "failure" })).toBe(1)
    expect(valueWithLabels(values, { operation: "rotate", result: "success" })).toBe(1)
    expect(valueWithLabels(values, { operation: "list", result: "success" })).toBe(1)
    expect(
      valueWithLabels(values, { operation: "revoke", result: "success" }),
    ).toBeUndefined()
  })

  it("starts each series from zero after a registry reset", async () => {
    incApiKeyVerification("success")
    register.resetMetrics()

    const values = await counterValues(API_KEY_VERIFICATION_METRIC)
    expect(valueWithLabels(values, { result: "success", reason: "ok" })).toBeUndefined()
  })
})
