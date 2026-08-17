jest.mock("axios", () => ({
  get: jest.fn(),
  post: jest.fn(),
  put: jest.fn(),
  isAxiosError: jest.fn((err) => Boolean(err?.isAxiosError)),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

jest.mock("@config", () => ({
  FrappeConfig: undefined,
}))

import axios from "axios"
import { ErpNext } from "@services/frappe/ErpNext"
import { FeeDiscountQueryError } from "@services/frappe/errors"
import {
  BridgeTransferRequest,
  BridgeTransferRequestStatus,
  BridgeTransferRequestTransactionType,
  EMAIL_ATTRIBUTION_SOURCE_SYSTEM,
} from "@services/frappe/models/BridgeTransferRequest"

const mockedAxios = axios as unknown as {
  get: jest.Mock
  post: jest.Mock
  put: jest.Mock
}

const client = new ErpNext("https://erp.example", "erp.example", {
  apiKey: "key",
  apiSecret: "secret",
})

const request = new BridgeTransferRequest({
  requestId: "tr_123",
  transactionType: BridgeTransferRequestTransactionType.Topup,
  status: BridgeTransferRequestStatus.FiatReceived,
  amount: "10.00",
  currency: "usd",
})

describe("ErpNext.upsertBridgeTransferRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("creates a Bridge Transfer Request when request_id is absent", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })
    mockedAxios.post.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge Transfer Request",
      expect.objectContaining({ request_id: "tr_123" }),
      expect.any(Object),
    )
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("updates a Bridge Transfer Request when request_id already exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "BTR-1" }] } })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.post).not.toHaveBeenCalled()
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({ request_id: "tr_123" }),
      expect.any(Object),
    )
  })

  it("never downgrades a promoted Topup row's status", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: "bridge_deposit,ibex_crypto_receive",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("allows a Topup row's status to move forward", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.FiatReceived,
            source_systems_seen: "bridge_deposit",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const completedRequest = new BridgeTransferRequest({
      requestId: "tr_123",
      transactionType: BridgeTransferRequestTransactionType.Topup,
      status: BridgeTransferRequestStatus.Completed,
      amount: "10.00",
      currency: "usd",
      sourceSystemsSeen: ["bridge_deposit", "ibex_crypto_receive"],
    })
    const result = await client.upsertBridgeTransferRequest(completedRequest)

    expect(result).toBe(true)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("merges source_systems_seen instead of overwriting on update", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: "bridge_deposit,ibex_crypto_receive",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    await client.upsertBridgeTransferRequest(request)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("preserves a promoted status when losing the create race", async () => {
    mockedAxios.get.mockResolvedValueOnce({ data: { data: [] } }).mockResolvedValueOnce({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: "bridge_deposit,ibex_crypto_receive",
          },
        ],
      },
    })
    mockedAxios.post.mockRejectedValue({
      isAxiosError: true,
      response: { status: 409, data: { exception: "DuplicateEntryError" } },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.upsertBridgeTransferRequest(request)

    expect(result).toBe(true)
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  it("writes the incoming status when the existing row has none", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [{ name: "BTR-1" }] } })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    await client.upsertBridgeTransferRequest(request)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: BridgeTransferRequestStatus.FiatReceived }),
      expect.any(Object),
    )
  })

  it("normalizes whitespace and duplicates when merging source_systems_seen", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Completed,
            source_systems_seen: " bridge_deposit , ibex_crypto_receive ,bridge_deposit",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    await client.upsertBridgeTransferRequest(request)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
      }),
      expect.any(Object),
    )
  })

  describe("email_attribution marker", () => {
    // `fygaro:<tx>` rows carry the marker only while their account_id came from
    // the unverified payer email. It gates the daily-cap sum
    // (sumFygaroTopupGrossCentsSince skips marked rows), so unlike every other
    // member of source_systems_seen it must describe the CURRENT attribution
    // rather than accumulate forever.
    const emailAttributedExisting = {
      name: "BTR-FYG-1",
      status: BridgeTransferRequestStatus.Completed,
      source_systems_seen: `fygaro_webhook,${EMAIL_ATTRIBUTION_SOURCE_SYSTEM}`,
      account_id: "account-1",
    }

    const fygaroTopup = (sourceSystemsSeen: string[], accountId?: string) =>
      new BridgeTransferRequest({
        requestId: "fygaro:tx-1",
        transactionType: BridgeTransferRequestTransactionType.Topup,
        status: BridgeTransferRequestStatus.FiatReceived,
        provider: "Fygaro",
        amount: "100.00",
        currency: "USD",
        accountId,
        sourceSystemsSeen,
      })

    it("clears the marker when a customReference-attributed write lands on an email-attributed row", async () => {
      // Without this, a re-delivery that verified the account via
      // customReference would leave the sticky marker in place and the
      // already-credited $100 would stay invisible to the daily cap — the
      // account would read $0 spent and could auto-credit its full cap again.
      mockedAxios.get.mockResolvedValue({ data: { data: [emailAttributedExisting] } })
      mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-FYG-1" } } })

      await client.upsertBridgeTransferRequest(
        fygaroTopup(["fygaro_webhook"], "account-1"),
      )

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ source_systems_seen: "fygaro_webhook" }),
        expect.any(Object),
      )
    })

    it("keeps the marker when the incoming write is itself email-attributed", async () => {
      mockedAxios.get.mockResolvedValue({ data: { data: [emailAttributedExisting] } })
      mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-FYG-1" } } })

      await client.upsertBridgeTransferRequest(
        fygaroTopup(["fygaro_webhook", EMAIL_ATTRIBUTION_SOURCE_SYSTEM], "account-1"),
      )

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          source_systems_seen: `fygaro_webhook,${EMAIL_ATTRIBUTION_SOURCE_SYSTEM}`,
        }),
        expect.any(Object),
      )
    })

    it("keeps the marker when the incoming write names no account", async () => {
      // An unattributed re-delivery says nothing about how the row got its
      // account_id, so it must not clear another writer's claim.
      mockedAxios.get.mockResolvedValue({ data: { data: [emailAttributedExisting] } })
      mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-FYG-1" } } })

      await client.upsertBridgeTransferRequest(fygaroTopup(["fygaro_webhook"]))

      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          source_systems_seen: `fygaro_webhook,${EMAIL_ATTRIBUTION_SOURCE_SYSTEM}`,
        }),
        expect.any(Object),
      )
    })

    it("clears the marker on the create-race path too", async () => {
      mockedAxios.get
        .mockResolvedValueOnce({ data: { data: [] } })
        .mockResolvedValueOnce({ data: { data: [emailAttributedExisting] } })
      mockedAxios.post.mockRejectedValue({
        isAxiosError: true,
        response: { status: 409, data: { exception: "DuplicateEntryError" } },
      })
      mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-FYG-1" } } })

      const result = await client.upsertBridgeTransferRequest(
        fygaroTopup(["fygaro_webhook"], "account-1"),
      )

      expect(result).toBe(true)
      expect(mockedAxios.put).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ source_systems_seen: "fygaro_webhook" }),
        expect.any(Object),
      )
    })
  })

  it("keeps last-write-wins semantics for Cashout rows", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-2", status: BridgeTransferRequestStatus.Completed }],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-2" } } })

    const failedCashout = new BridgeTransferRequest({
      requestId: "tr_cashout",
      transactionType: BridgeTransferRequestTransactionType.Cashout,
      status: BridgeTransferRequestStatus.Failed,
      amount: "5.00",
      currency: "usdt",
    })
    await client.upsertBridgeTransferRequest(failedCashout)

    expect(mockedAxios.put).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ status: BridgeTransferRequestStatus.Failed }),
      expect.any(Object),
    )
  })
})

describe("ErpNext.findBridgeTransferRequest", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("returns the doc with status and account attribution when the row exists", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.Settled,
            account_id: "acct_123",
            wallet_id: "wallet_123",
          },
        ],
      },
    })

    const result = await client.findBridgeTransferRequest("ibex:tx_123")

    expect(result).toEqual(
      expect.objectContaining({
        name: "BTR-1",
        status: BridgeTransferRequestStatus.Settled,
        account_id: "acct_123",
        wallet_id: "wallet_123",
      }),
    )
    const getParams = mockedAxios.get.mock.calls[0][1].params
    expect(JSON.parse(getParams.fields)).toEqual(
      expect.arrayContaining(["name", "status", "account_id", "wallet_id"]),
    )
  })

  it("returns undefined when no row exists", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    await expect(client.findBridgeTransferRequest("ibex:tx_123")).resolves.toBeUndefined()
  })

  it("returns an error when the lookup fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("network down"))

    const result = await client.findBridgeTransferRequest("ibex:tx_123")
    expect(result).toBeInstanceOf(Error)
  })
})

describe("ErpNext.completeBridgeTopupByTxHash", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("promotes the matching deposit row to Completed with account attribution", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            name: "BTR-1",
            status: BridgeTransferRequestStatus.FiatReceived,
            source_systems_seen: "bridge_deposit",
          },
        ],
      },
    })
    mockedAxios.put.mockResolvedValue({ data: { data: { name: "BTR-1" } } })

    const result = await client.completeBridgeTopupByTxHash({
      txHash: "tx_123",
      accountId: "acct_123",
      walletId: "wallet_123",
    })

    expect(result).toBe("completed")
    const getParams = mockedAxios.get.mock.calls[0][1].params
    expect(JSON.parse(getParams.filters)).toEqual([
      ["Bridge Transfer Request", "ibex_tx_hash", "=", "tx_123"],
      ["Bridge Transfer Request", "transaction_type", "=", "Topup"],
      ["Bridge Transfer Request", "request_id", "not like", "ibex:%"],
    ])
    expect(mockedAxios.put).toHaveBeenCalledWith(
      "https://erp.example/api/resource/Bridge%20Transfer%20Request/BTR-1",
      expect.objectContaining({
        status: BridgeTransferRequestStatus.Completed,
        account_id: "acct_123",
        wallet_id: "wallet_123",
        source_systems_seen: "bridge_deposit,ibex_crypto_receive",
        last_seen_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
      }),
      expect.any(Object),
    )
  })

  it("returns not_found when no deposit row carries the tx hash", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBe("not_found")
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("is idempotent when the deposit row is already Completed", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-1", status: BridgeTransferRequestStatus.Completed }],
      },
    })

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBe("already_completed")
    expect(mockedAxios.put).not.toHaveBeenCalled()
  })

  it("returns an error when the promotion write fails", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [{ name: "BTR-1", status: BridgeTransferRequestStatus.FiatReceived }],
      },
    })
    mockedAxios.put.mockRejectedValue(new Error("erpnext down"))

    const result = await client.completeBridgeTopupByTxHash({ txHash: "tx_123" })

    expect(result).toBeInstanceOf(Error)
  })
})

describe("ErpNext.sumFygaroTopupGrossCentsSince", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  const params = {
    accountId: "account-1",
    since: new Date("2026-08-13T07:00:00Z"),
    excludeRequestId: "fygaro:tx-current",
  }

  it("sums row amounts in integer cents", async () => {
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { request_id: "fygaro:tx-1", amount: "25.00" },
          { request_id: "fygaro:tx-2", amount: "10.50" },
          // ERPNext may return numerics for Currency fields
          { request_id: "fygaro:tx-3", amount: 0.1 },
        ],
      },
    })

    const result = await client.sumFygaroTopupGrossCentsSince(params)

    expect(result).toBe(3560)
  })

  it("scopes the query to this account's captured Fygaro top-ups in the window, excluding the current delivery", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    await client.sumFygaroTopupGrossCentsSince(params)

    const [url, config] = mockedAxios.get.mock.calls[0]
    expect(url).toBe("https://erp.example/api/resource/Bridge%20Transfer%20Request")
    const filters = JSON.parse(config.params.filters)
    expect(filters).toEqual([
      ["Bridge Transfer Request", "provider", "=", "Fygaro"],
      ["Bridge Transfer Request", "transaction_type", "=", "Topup"],
      ["Bridge Transfer Request", "account_id", "=", "account-1"],
      // USD only: a non-USD row carries the raw foreign-currency amount, so a
      // 5,000 JMD payment counted at face value would read as $5,000 of prior
      // gross and wrongly lock the account out for a day.
      ["Bridge Transfer Request", "currency", "=", "USD"],
      ["Bridge Transfer Request", "status", "in", ["Fiat Received", "Completed"]],
      // NOTE: email-attributed rows are excluded in code, not here — a Frappe
      // `not like` filter would evaluate NULL for rows with an empty
      // source_systems_seen and silently drop them from the window.
      // The window must filter on last_seen_at (written in UTC by this code),
      // NOT Frappe's `creation`, which is stored naive in the ERP site's
      // configured time zone — comparing that against a UTC cutoff would
      // silently shrink the 24h window by the site's UTC offset.
      ["Bridge Transfer Request", "last_seen_at", ">=", "2026-08-13 07:00:00"],
      ["Bridge Transfer Request", "request_id", "!=", "fygaro:tx-current"],
    ])
    // limit_page_length 0 = no pagination cap; a truncated window would
    // under-count and quietly defeat the daily cap.
    expect(config.params.limit_page_length).toBe(0)
    // source_systems_seen must be fetched — it is what marks a row as
    // email-attributed, and the exclusion below cannot work without it.
    expect(JSON.parse(config.params.fields)).toEqual([
      "request_id",
      "amount",
      "source_systems_seen",
    ])
  })

  it("drops the request_id filter entirely when no exclusion is given", async () => {
    // The pre-charge allowance check has no row of its own yet. Sending a
    // sentinel request_id instead would make the query's correctness depend on
    // that string never colliding with a real one.
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    await client.sumFygaroTopupGrossCentsSince({
      accountId: params.accountId,
      since: params.since,
    })

    const filters = JSON.parse(mockedAxios.get.mock.calls[0][1].params.filters)
    expect(filters.some((f: unknown[]) => f[1] === "request_id")).toBe(false)
    // Every other filter is untouched — the window must not widen.
    expect(filters).toHaveLength(6)
  })

  it("returns 0 for an empty window", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    expect(await client.sumFygaroTopupGrossCentsSince(params)).toBe(0)
  })

  it("fails closed (error, not zero) when the response has no data array", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} })

    const result = await client.sumFygaroTopupGrossCentsSince(params)

    expect(result).toBeInstanceOf(Error)
  })

  it("fails closed on a non-numeric row amount", async () => {
    mockedAxios.get.mockResolvedValue({
      data: { data: [{ request_id: "fygaro:tx-1", amount: "N/A" }] },
    })

    const result = await client.sumFygaroTopupGrossCentsSince(params)

    expect(result).toBeInstanceOf(Error)
  })

  it("fails closed on a null row amount instead of counting it as zero", async () => {
    // Frappe's list API returns null for unset fields and Number(null) is 0 —
    // a null amount must be an error, not a silent zero contribution.
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { request_id: "fygaro:tx-1", amount: "25.00" },
          { request_id: "fygaro:tx-2", amount: null },
        ],
      },
    })

    const result = await client.sumFygaroTopupGrossCentsSince(params)

    expect(result).toBeInstanceOf(Error)
  })

  it("returns an error when the read fails", async () => {
    mockedAxios.get.mockRejectedValue(new Error("erpnext down"))

    const result = await client.sumFygaroTopupGrossCentsSince(params)

    expect(result).toBeInstanceOf(Error)
  })

  it("excludes email-attributed rows — an unverified payer email must not burn the account's cap", async () => {
    // A relative pays $125 for someone else's top-up with a blank
    // customReference and their own email at checkout. The row is stamped onto
    // the matched account for DISPLAY only; counting it here would consume the
    // whole level-1 $125 daily allowance and bounce that account's own top-up
    // hours later. Adversarially, anyone who knows a victim's email could lock
    // them out of auto-credit for 24h with a single card payment.
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            request_id: "fygaro:tx-stranger",
            amount: "125.00",
            source_systems_seen: "fygaro_webhook,email_attribution",
          },
          {
            request_id: "fygaro:tx-mine",
            amount: "10.00",
            source_systems_seen: "fygaro_webhook",
          },
        ],
      },
    })

    expect(await client.sumFygaroTopupGrossCentsSince(params)).toBe(1000)
  })

  it("still counts rows with no source_systems_seen (absent marker is not an exemption)", async () => {
    // Fails CLOSED: an unset/legacy source_systems_seen means "not
    // email-attributed", so the row counts. The SQL-side alternative
    // (`not like`) would have dropped exactly these rows and under-counted.
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          { request_id: "fygaro:tx-1", amount: "25.00", source_systems_seen: null },
          { request_id: "fygaro:tx-2", amount: "10.00" },
        ],
      },
    })

    expect(await client.sumFygaroTopupGrossCentsSince(params)).toBe(3500)
  })

  it("does not treat a lookalike source system as email attribution", async () => {
    // Matched on comma-separated members, not substrings, so a future
    // "email_attribution_reviewed" marker cannot silently exempt a row.
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            request_id: "fygaro:tx-1",
            amount: "25.00",
            source_systems_seen: "fygaro_webhook,email_attribution_reviewed",
          },
        ],
      },
    })

    expect(await client.sumFygaroTopupGrossCentsSince(params)).toBe(2500)
  })

  it("skips an email-attributed row without failing on its amount", async () => {
    // The exclusion runs before the fail-closed amount checks: an excluded row
    // contributes nothing by design, so its amount is irrelevant and must not
    // error the whole window.
    mockedAxios.get.mockResolvedValue({
      data: {
        data: [
          {
            request_id: "fygaro:tx-stranger",
            amount: null,
            source_systems_seen: "fygaro_webhook,email_attribution",
          },
          {
            request_id: "fygaro:tx-mine",
            amount: "10.00",
            source_systems_seen: "fygaro_webhook",
          },
        ],
      },
    })

    expect(await client.sumFygaroTopupGrossCentsSince(params)).toBe(1000)
  })
})

describe("ErpNext.getFeeDiscounts", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("requests only ACTIVE rows, with every field the validator reads", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    await client.getFeeDiscounts()

    const [url, config] = mockedAxios.get.mock.calls[0]
    expect(url).toBe("https://erp.example/api/resource/Fee%20Discount")
    // The active=1 filter is what stops a promo the operator ended from
    // continuing to discount Flash's fee. (validateFeeDiscountDoc re-checks
    // `active` too — belt and braces, since this reader fails OPEN and a lost
    // filter would never alarm.)
    expect(JSON.parse(config.params.filters)).toEqual([["active", "=", 1]])
    expect(JSON.parse(config.params.fields)).toEqual([
      "username",
      "discount_percent",
      "applies_to_topup",
      "applies_to_cashout",
      "active",
    ])
    // No pagination cap: a truncated page would silently drop whitelisted
    // users off the discount.
    expect(config.params.limit_page_length).toBe(0)
  })

  it("returns the rows as-is for the validator to coerce", async () => {
    const rows = [
      {
        username: "civilizedbarbarian",
        discount_percent: "25",
        applies_to_topup: 1,
        applies_to_cashout: 0,
        active: 1,
      },
    ]
    mockedAxios.get.mockResolvedValue({ data: { data: rows } })

    expect(await client.getFeeDiscounts()).toEqual(rows)
  })

  it("returns an empty list when no rows are active", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: [] } })

    expect(await client.getFeeDiscounts()).toEqual([])
  })

  it("returns an error (not a silent empty list) when the response is not an array", async () => {
    mockedAxios.get.mockResolvedValue({ data: { data: { username: "x" } } })

    expect(await client.getFeeDiscounts()).toBeInstanceOf(FeeDiscountQueryError)
  })

  it("returns an error when the response has no data", async () => {
    mockedAxios.get.mockResolvedValue({ data: {} })

    expect(await client.getFeeDiscounts()).toBeInstanceOf(FeeDiscountQueryError)
  })

  it("returns the error rather than throwing when the request rejects", async () => {
    mockedAxios.get.mockRejectedValue(new Error("erpnext down"))

    expect(await client.getFeeDiscounts()).toBeInstanceOf(FeeDiscountQueryError)
  })
})
