jest.mock("axios", () => ({ __esModule: true, default: { request: jest.fn() } }))
jest.mock("@config", () => ({ PROXY_CHECK_APIKEY: "fixture-private-proxy-key" }))
jest.mock("@services/tracing", () => ({
  addAttributesToCurrentSpan: jest.fn(),
  recordExceptionInCurrentSpan: jest.fn(),
}))

import axios from "axios"
import { UnknownIpFetcherServiceError, IpFetcherServiceError } from "@domain/ipfetcher"
import { IpFetcher } from "@services/ipfetcher"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

const privateIp = "198.51.100.43" as IpAddress
const request = jest.mocked(axios.request)

beforeEach(() => {
  jest.clearAllMocks()
})

it("sends the exact IP and key to the provider while tracing only closed booleans", async () => {
  const privateCarrier = "PRIVATE_PROVIDER_META"
  request.mockResolvedValue({
    data: {
      status: "ok",
      [privateIp]: {
        proxy: "yes",
        isocode: privateCarrier,
        country: "JM",
        provider: privateCarrier,
      },
    },
  })

  const result = await IpFetcher().fetchIPInfo(privateIp)

  expect(request).toHaveBeenCalledWith({
    url: `https://proxycheck.io/v2/${privateIp}`,
    params: {
      vpn: "1",
      asn: "1",
      time: "1",
      risk: "1",
      key: "fixture-private-proxy-key",
    },
    timeout: 500,
  })
  expect(result).toEqual({
    proxy: true,
    isoCode: privateCarrier,
    isocode: privateCarrier,
    country: "JM",
    provider: privateCarrier,
    status: "ok",
  })
  expect(addAttributesToCurrentSpan).toHaveBeenCalledWith({
    proxy: true,
    keyIsPresent: true,
  })
  expect(
    JSON.stringify(jest.mocked(addAttributesToCurrentSpan).mock.calls),
  ).not.toContain(privateIp)
  expect(
    JSON.stringify(jest.mocked(addAttributesToCurrentSpan).mock.calls),
  ).not.toContain(privateCarrier)
})

it("returns a service-class failure and records no URL, key, IP or provider body", async () => {
  const privateProviderBody = "PRIVATE_PROVIDER_BODY"
  request.mockRejectedValue(
    Object.assign(
      new Error(`https://proxycheck.io/v2/${privateIp}?key=fixture-private-proxy-key`),
      { response: { data: privateProviderBody } },
    ),
  )

  const result = await IpFetcher().fetchIPInfo(privateIp)

  expect(result).toBeInstanceOf(UnknownIpFetcherServiceError)
  expect(result).toBeInstanceOf(IpFetcherServiceError)
  expect((result as Error).message).toBe("IP metadata lookup failed")
  expect(recordExceptionInCurrentSpan).toHaveBeenCalledWith({
    error: result,
    attributes: { keyIsPresent: true },
  })
  const diagnostics = JSON.stringify({
    result,
    spans: jest.mocked(addAttributesToCurrentSpan).mock.calls,
    exceptions: jest.mocked(recordExceptionInCurrentSpan).mock.calls,
  })
  for (const secret of [privateIp, "fixture-private-proxy-key", privateProviderBody]) {
    expect(diagnostics).not.toContain(secret)
  }
})
