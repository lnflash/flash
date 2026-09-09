// SSRF guard wiring for `lnurlPaymentSend`, the sibling of the LNURL-pay
// proxy's on-pay-ssrf.spec.ts. The `Lnurl` scalar validates the bech32 encoding
// and nothing about the URL it decodes to, so an authenticated caller picks
// the host this server fetches — the same hole the public proxy route has,
// reachable from the public schema. These cases fail on a bare
// `axios.get(decoded.decodedLnurl)`.
jest.mock("@services/logger", () => {
  const logger = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    child: jest.fn(() => logger),
  }
  return { baseLogger: logger }
})

// The blocked branches record on the span as well as in the log: a warn line
// is not a rate anyone can alert on, and https-only is a cutover on a live
// payments path. Mocked here (as in the sibling on-pay-ssrf spec) so the
// attributes the alert matches on are pinned by a test — otherwise deleting
// the call, or typoing the attribute key, keeps this suite green while the
// alert silently stops firing.
jest.mock("@services/tracing", () => ({
  ...jest.requireActual("@services/tracing"),
  recordExceptionInCurrentSpan: jest.fn(),
}))

// Spread the real module rather than replacing it: ENG-573 put `authorizeSend`
// in this resolver's import chain, which reaches the grpc price client, which
// constructs `dns.promises.Resolver`. A bare `{ promises: { lookup } }` stub
// drops it and the suite fails to load.
jest.mock("dns", () => {
  const actual = jest.requireActual("dns")
  return { ...actual, promises: { ...actual.promises, lookup: jest.fn() } }
})
jest.mock("axios", () => ({
  __esModule: true,
  default: { get: jest.fn() },
}))

const mockResolveCashWalletMutationWalletIdForAccount = jest.fn()
const mockUsdWalletAmountFromWalletId = jest.fn()
const mockDecodeLnurl = jest.fn()
const mockPayToLnurl = jest.fn()
const mockGetSatsFromCentsForImmediateSell = jest.fn()

jest.mock("@app/payments/idempotency", () => ({
  withPaymentIdempotency: async ({ execute }: { execute: () => Promise<unknown> }) =>
    execute(),
}))

jest.mock("@app/cash-wallet-cutover", () => ({
  resolveCashWalletMutationWalletIdForAccount: (
    ...args: Parameters<typeof mockResolveCashWalletMutationWalletIdForAccount>
  ) => mockResolveCashWalletMutationWalletIdForAccount(...args),
}))

jest.mock("@app/wallets", () => ({
  usdWalletAmountFromWalletId: (
    ...args: Parameters<typeof mockUsdWalletAmountFromWalletId>
  ) => mockUsdWalletAmountFromWalletId(...args),
}))

jest.mock("@services/dealer-price", () => ({
  DealerPriceService: jest.fn(() => ({
    getSatsFromCentsForImmediateSell: (
      ...args: Parameters<typeof mockGetSatsFromCentsForImmediateSell>
    ) => mockGetSatsFromCentsForImmediateSell(...args),
  })),
}))

jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: {
    decodeLnurl: (...args: Parameters<typeof mockDecodeLnurl>) =>
      mockDecodeLnurl(...args),
    payToLnurl: (...args: Parameters<typeof mockPayToLnurl>) => mockPayToLnurl(...args),
  },
}))

import dns from "dns"

import axios from "axios"

import { paymentAmountFromNumber, USDTAmount, WalletCurrency } from "@domain/shared"
import LnurlPaymentSendMutation from "@graphql/public/root/mutation/lnurl-payment-send"
import { recordExceptionInCurrentSpan } from "@services/tracing"
import { MAX_REDIRECT_HOPS, MAX_RESPONSE_BYTES, ssrfLookup } from "@utils/ssrf-guard"

import {
  clearDevUnsafeModeFlags,
  restoreDevUnsafeModeFlags,
} from "test/flash/helpers/dev-context-env"

const lookup = dns.promises.lookup as jest.Mock
const axiosGet = axios.get as jest.Mock
const recordException = recordExceptionInCurrentSpan as jest.Mock

const blockedStages = () =>
  recordException.mock.calls.map((c) => c[0].attributes?.["lnurlpay.blocked.stage"])

const PUBLIC_ADDR = [{ address: "93.184.216.34", family: 4 }]

const walletId = "11111111-1111-4111-8111-111111111111" as WalletId
const routedWalletId = "22222222-2222-4222-8222-222222222222" as WalletId
const domainAccount = { id: "account-id" } as Account

type MutationResult = {
  status: string
  errors: { message: string }[]
}

const resolveMutation = () =>
  LnurlPaymentSendMutation.resolve?.(
    null,
    {
      input: {
        walletId,
        lnurl: "LNURL1DP68GURN8GHJ7MRWW4EXCTN" as Lnurl,
        amount: 19446 as FractionalCentAmount,
        memo: "memo" as Memo,
      },
    },
    {
      domainAccount,
      cashWalletClientCapabilities: {
        cashWalletPresentation: "usdt",
        hasUsdtCashWalletSupport: true,
      },
    } as GraphQLPublicContextAuth,
    {} as never,
  ) as Promise<MutationResult>

const METADATA_BODY = {
  data: {
    callback: "https://lnurl.example/callback",
    minSendable: 1_000,
    maxSendable: 2_000_000,
    metadata: '[["text/plain","alice"]]',
    tag: "payRequest",
  },
}

describe("lnurlPaymentSend — SSRF guard wiring", () => {
  const savedNetwork = process.env.NETWORK

  beforeEach(() => {
    jest.clearAllMocks()
    // A deployed environment: mainnet AND no unsafe-dev-mode opt-in. The repo's
    // .env (which `make unit-in-ci` sources) sets FLASH_DEV_UNSAFE_MODE, which
    // is half the guard's dev-context predicate — leaving it set here would
    // test the escape hatch instead of the guard.
    process.env.NETWORK = "mainnet"
    clearDevUnsafeModeFlags()
    lookup.mockResolvedValue(PUBLIC_ADDR)
    mockResolveCashWalletMutationWalletIdForAccount.mockResolvedValue(routedWalletId)
    mockUsdWalletAmountFromWalletId.mockResolvedValue(
      USDTAmount.usdCents("19446") as USDTAmount,
    )
    mockGetSatsFromCentsForImmediateSell.mockResolvedValue(
      paymentAmountFromNumber({ amount: 1234, currency: WalletCurrency.Btc }),
    )
    mockPayToLnurl.mockResolvedValue({
      transaction: { payment: { status: { id: 2 } } },
    })
  })

  afterAll(() => {
    if (savedNetwork === undefined) delete process.env.NETWORK
    else process.env.NETWORK = savedNetwork
    restoreDevUnsafeModeFlags()
  })

  it("blocks a caller-supplied lnurl that decodes to cloud metadata — axios is never called", async () => {
    mockDecodeLnurl.mockResolvedValue({
      decodedLnurl: "http://169.254.169.254/latest/meta-data",
    })

    const result = await resolveMutation()

    expect(axiosGet).not.toHaveBeenCalled()
    expect(result.status).toBe("failed")
    expect(result.errors.length).toBeGreaterThan(0)
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  it("blocks a caller-supplied lnurl that decodes to an internal RFC1918 address", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://10.0.0.4/internal" })

    const result = await resolveMutation()

    expect(axiosGet).not.toHaveBeenCalled()
    expect(result.status).toBe("failed")
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  it("blocks a public-looking host that resolves into the cluster", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    lookup.mockResolvedValueOnce([{ address: "10.0.0.5", family: 4 }])

    const result = await resolveMutation()

    expect(axiosGet).not.toHaveBeenCalled()
    expect(result.status).toBe("failed")
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  it("does not follow a redirect into the internal network", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: "http://169.254.169.254/latest" },
      data: {},
    })

    const result = await resolveMutation()

    expect(axiosGet).toHaveBeenCalledTimes(1) // first hop only
    expect(result.status).toBe("failed")
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  it("caps the body, bounds the fetch and disables axios's own redirect following", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValueOnce({ status: 200, headers: {}, ...METADATA_BODY })

    await resolveMutation()

    const [url, config] = axiosGet.mock.calls[0]
    expect(url).toBe("https://pay.example.com/lnurl")
    // Without these an attacker-chosen host OOMs the pod with an unbounded
    // body, or pins an api worker for as long as it cares to trickle bytes.
    expect(config.maxContentLength).toBe(MAX_RESPONSE_BYTES)
    expect(config.maxBodyLength).toBe(MAX_RESPONSE_BYTES)
    expect(config.timeout).toBeGreaterThan(0)
    expect(config.maxRedirects).toBe(0)
    // Connect-time DNS re-validation — the TOCTOU half of the guard.
    expect(config.httpAgent.options.lookup).toBe(ssrfLookup)
    expect(config.httpsAgent.options.lookup).toBe(ssrfLookup)
  })

  it("fails the payload — not with a bare GraphQL error — when the redirect chain is too long", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValue({
      status: 302,
      headers: { location: "https://cdn.example.com/next" },
      data: {},
    })

    const result = await resolveMutation()

    expect(axiosGet).toHaveBeenCalledTimes(MAX_REDIRECT_HOPS + 1)
    expect(result.status).toBe("failed")
    expect(mockPayToLnurl).not.toHaveBeenCalled()
  })

  // Both blocked branches collapse to InvalidLnurlError and nothing downstream
  // logs — the error map reads only message/path/code, and CustomApolloError
  // binds logger.warn without calling it. Unlogged, an authenticated user
  // sweeping in-cluster hosts through this mutation leaves nothing to alert on
  // or attribute, and support cannot tell scheme from DNS from a blocked hop.
  it("logs the account and the reason when it blocks an unsafe lnurl target", async () => {
    const { baseLogger } = jest.requireMock("@services/logger")
    baseLogger.warn.mockClear()
    mockDecodeLnurl.mockResolvedValue({
      decodedLnurl: "http://169.254.169.254/latest/meta-data",
    })

    await resolveMutation()

    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
    const [context, message] = baseLogger.warn.mock.calls[0]
    expect(context).toMatchObject({ accountId: "account-id" })
    expect((context as { err: unknown }).err).toBeInstanceOf(Error)
    expect(String(message)).toContain("lnurlPaymentSend")
    // The span is the half you can alert on, so it is asserted, not assumed.
    expect(recordException).toHaveBeenCalledTimes(1)
    const recorded = recordException.mock.calls[0][0]
    expect(recorded.attributes["lnurlpay.blocked"]).toBe(true)
    expect(recorded.attributes["lnurlpay.blocked.stage"]).toBe("send-metadata-url")
    // The reason has to survive onto the span, or the alert cannot tell the
    // http:// scheme cutover from a genuine SSRF attempt.
    expect(recorded.error.message).toMatch(/scheme http: not allowed/)
  })

  it("logs the account and the reason when the metadata fetch is rejected mid-chain", async () => {
    const { baseLogger } = jest.requireMock("@services/logger")
    baseLogger.warn.mockClear()
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockRejectedValueOnce(new Error("socket hang up"))

    await resolveMutation()

    expect(baseLogger.warn).toHaveBeenCalledTimes(1)
    expect(baseLogger.warn.mock.calls[0][0]).toMatchObject({ accountId: "account-id" })
    expect(blockedStages()).toEqual(["send-metadata-fetch"])
    // A socket hang up is the upstream breaking, not a target being refused.
    // `lnurlpay.blocked` is the blocked-target alert signal; filing upstream
    // faults under it would fire that alert on every flaky wallet host and
    // contradict the invariant ssrf-guard.ts establishes deliberately.
    expect(recordException.mock.calls[0][0].attributes["lnurlpay.blocked"]).toBe(false)
  })

  // The guard's other two limits — the per-hop inactivity timeout and the 64KB
  // body cap — reach the caller as SsrfBlockedUrlError like every other
  // refusal, so this branch reports them on the same span as a blocked
  // redirect rather than losing them.
  it.each([
    [
      "a hop that accepts and then goes silent",
      "ECONNABORTED",
      "timeout of 800ms exceeded",
    ],
    [
      "a body past the cap",
      "ERR_BAD_RESPONSE",
      "maxContentLength size of 65536 exceeded",
    ],
  ])(
    "records the block when the metadata fetch hits %s",
    async (_case, code, message) => {
      mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
      axiosGet.mockRejectedValueOnce(
        Object.assign(new Error(message), { isAxiosError: true, code }),
      )

      const result = await resolveMutation()

      expect(result.status).toBe("failed")
      expect(mockPayToLnurl).not.toHaveBeenCalled()
      expect(blockedStages()).toEqual(["send-metadata-fetch"])
      expect(recordException.mock.calls[0][0].error.message).toContain(message)
    },
  )

  it("files a genuinely refused redirect target under the blocked-target signal", async () => {
    const { recordExceptionInCurrentSpan } = jest.requireMock("@services/tracing")
    recordExceptionInCurrentSpan.mockClear()
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValueOnce({
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
      data: "",
    })

    await resolveMutation()

    expect(recordExceptionInCurrentSpan).toHaveBeenCalledTimes(1)
    expect(
      recordExceptionInCurrentSpan.mock.calls[0][0].attributes["lnurlpay.blocked"],
    ).toBe(true)
  })

  it("still pays when the decoded lnurl is a public https host", async () => {
    mockDecodeLnurl.mockResolvedValue({ decodedLnurl: "https://pay.example.com/lnurl" })
    axiosGet.mockResolvedValueOnce({ status: 200, headers: {}, ...METADATA_BODY })

    const result = await resolveMutation()

    expect(result).toEqual({ errors: [], status: "success" })
    expect(mockPayToLnurl).toHaveBeenCalledTimes(1)
    // A clean payment must not report a block, or the alert is unusable.
    expect(recordException).not.toHaveBeenCalled()
  })
})
