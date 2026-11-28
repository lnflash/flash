import { createHash, randomUUID } from "crypto"

/**
 * Public POS checkout paid in Ethereum USDT, received on the merchant's own
 * IBEX USDT cash wallet.
 *
 * Every sale gets its own IBEX receive info (its own id and its own address).
 * A payment is tied to a sale only by the receive info id that IBEX Hub's
 * signed "Transactions" event names, never by its amount, its address, a
 * receive-info balance or the wallet balance. A sale is PAID only once the
 * credits read back from IBEX as posted, on the sale's wallet, add up to at
 * least its price, in exact USDT micro-units.
 *
 * Nothing here moves money: IBEX has already credited the merchant.
 */

export const USDT_NETWORK = "ETHEREUM" as const
export type UsdtNetwork = typeof USDT_NETWORK
export type UsdtCheckoutStatus = "AWAITING_PAYMENT" | "DETECTED" | "PAID"

// IBEX's crypto receive transaction type (same constant as the Bridge matcher).
export const CRYPTO_RECEIVE_TYPE_ID = 9
// IBEX's USDT currency id (USDTAmount.currencyId). USDT has 6 decimals.
export const USDT_CURRENCY_ID = 29
export const MICRO_PER_CENT = 10_000n
export const DEFAULT_MAX_AMOUNT_MINOR = 1_000_000 // US$10,000.00

export type Allocation = { receiveInfoId: string; address: string }

export type FailReason = "AMBIGUOUS" | "COLLISION" | "INVALID"

export type Row = {
  // sha256 of the receipt capability; the capability itself is never stored.
  _id: string
  recipientWalletId: string
  // Frozen at allocation. The register can present the merchant’s legacy USD wallet.
  settlementWalletId?: string
  amountMinor: number
  network: UsdtNetwork
  // Set together, once, when the destination is published to the caller.
  receiveInfoId?: string
  address?: string
  // A valid receive info IBEX issued, not yet shown to anyone.
  candidate?: Allocation
  // Set just before IBEX is asked for a receive info, cleared when the answer
  // is staged or IBEX definitely refused. Found set by a later attempt, it
  // means a call whose outcome is unknown: that sale never asks again.
  attempt?: string
  // The sale can never get a destination.
  failed?: FailReason
}

export type CreditState = "DETECTED" | "POSTED"

export type Credit = {
  // IBEX transaction id: one credit per IBEX transaction, ever.
  _id: string
  checkoutKey: string
  receiveInfoId: string
  walletId: string
  txid: string
  // Exact micro-USDT as a decimal string.
  amountMicro: string
  state: CreditState
  // When a status read-back last claimed this credit (Store.touch); unset if never.
  checkedAt?: Date
}

export type Store = {
  read(key: string): Promise<Row | null>
  // Published checkouts only.
  findByReceiveInfo(receiveInfoId: string): Promise<Row | null>
  reserve(row: Row): Promise<void>
  claim(key: string, lease: string): Promise<boolean>
  begin(key: string, lease: string, attempt: string): Promise<boolean>
  abandon(key: string, lease: string, attempt: string): Promise<void>
  stage(
    key: string,
    lease: string,
    attempt: string,
    allocation: Allocation,
  ): Promise<boolean>
  fail(key: string, reason: FailReason): Promise<void>
  // Throws CollisionError when another checkout holds the receive info or address.
  publish(key: string, lease: string, allocation: Allocation): Promise<boolean>
  release(key: string, lease: string): Promise<void>
  credits(key: string): Promise<Credit[]>
  // Insert if absent; returns the stored credit (the existing one on a repeat).
  addCredit(credit: Credit): Promise<Credit>
  // DETECTED -> POSTED, only for the exact stored fields. Never the other way.
  post(
    transactionId: string,
    expected: Pick<Credit, "checkoutKey" | "amountMicro" | "txid" | "walletId">,
  ): Promise<void>
  // Claims a read-back of a DETECTED credit; false while another one is recent.
  touch(transactionId: string): Promise<boolean>
}

// The IBEX transaction as read back from IBEX, unvalidated.
export type PostedReadback = {
  accountId?: unknown
  amount?: unknown
  transactionTypeId?: unknown
  status?: unknown
  currencyId?: unknown
  txid?: unknown
}

export type Dependencies = {
  store: Store
  maxAmountMinor?: number
  // Check eligibility before issuing an address. Existing receipt holders
  // can still follow a payment after the merchant stops taking new sales.
  enabled(walletId: string): boolean | string | Promise<boolean | string>
  limitNew(walletId: string, ip: string): Promise<void>
  // Throws ProviderRejectedError when IBEX certainly created nothing; any
  // other throw is treated as "may have created one".
  newReceiveInfo(walletId: string, name: string): Promise<unknown>
  // Addresses a sale must never be given, e.g. the account's Bridge deposit address.
  reservedAddresses(walletId: string): Promise<string[]>
  // null when IBEX cannot be read right now.
  readPosted(transactionId: string): Promise<PostedReadback | null>
  report(event: string, detail: Record<string, unknown>): void
}

export class UsdtCheckoutError extends Error {}
export class CollisionError extends UsdtCheckoutError {
  constructor() {
    super("The provider reused a receiving address. Start a new sale or contact support.")
  }
}
// Thrown by newReceiveInfo when the provider certainly issued nothing.
export class ProviderRejectedError extends Error {}

const hash = (v: string) => createHash("sha256").update(v).digest("hex")
const capability = /^[0-9a-f]{64}$/
const providerId = /^[A-Za-z0-9_-]{1,128}$/
const ethAddress = /^0x[0-9a-fA-F]{40}$/
const ethTxid = /^0x[0-9a-fA-F]{64}$/
const working = () =>
  new UsdtCheckoutError("Preparing the address. Retry this same sale in a moment.")
const unknownCheckout = () => new UsdtCheckoutError("Unknown checkout.")

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

/**
 * Exact micro-USDT from an IBEX amount in USDT (a JSON number or a decimal
 * string). No floating point: anything that is not a plain non-negative
 * decimal with at most 6 places (exponents included) is refused.
 */
export function parseMicroUsdt(value: unknown): bigint | undefined {
  let text: string
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined
    text = String(value)
  } else if (typeof value === "string") {
    text = value.trim()
  } else return undefined
  const match = /^(\d{1,15})(?:\.(\d{1,6}))?$/.exec(text)
  if (!match) return undefined
  return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"))
}

export type HubSignal = {
  transactionId: string
  receiveInfoId: string
  walletId: string
  txid: string
  amountMicro: bigint
}

export type ParsedHubEvent =
  | { kind: "signal"; signal: HubSignal }
  | { kind: "ignore"; reason: string }
  | { kind: "reject"; reason: string }

/**
 * Reads IBEX Hub's signed "Transactions" event for a crypto receive. Only the
 * fields this checkout relies on are read; one with a type or value this code
 * does not support refuses the event (it is reported, never guessed at).
 *
 *   transaction.id, .transactionTypeId (9), .accountId, .amount (account
 *   currency, USDT here), .currencyId (optional, must be USDT)
 *   receiveInfo.id, .network ("ethereum"), .txid
 *
 * The receive info may sit at the top level or inside `transaction`; the tx
 * hash may also be given as crypto.networkTransactionId. When given twice they
 * must agree. An event without a receive info is not a POS event: there is no
 * fallback to the address.
 */
export function parseHubEvent(body: unknown): ParsedHubEvent {
  if (!isRecord(body) || body.event !== "Transactions")
    return { kind: "ignore", reason: "not_transactions" }
  const tx = body.transaction
  if (!isRecord(tx) || tx.transactionTypeId !== CRYPTO_RECEIVE_TYPE_ID)
    return { kind: "ignore", reason: "not_crypto_receive" }

  const given = [body.receiveInfo, tx.receiveInfo].filter((v) => v !== undefined)
  if (!given.length) return { kind: "ignore", reason: "no_receive_info" }
  const infos = given.filter(isRecord)
  if (infos.length !== given.length)
    return { kind: "reject", reason: "receive_info_shape" }
  const ids = new Set(infos.map((i) => i.id))
  const [receiveInfoId] = [...ids]
  if (
    ids.size !== 1 ||
    typeof receiveInfoId !== "string" ||
    !providerId.test(receiveInfoId)
  )
    return { kind: "reject", reason: "receive_info_id" }

  const crypto = isRecord(body.crypto) ? body.crypto : undefined
  if (body.crypto !== undefined && !crypto)
    return { kind: "reject", reason: "crypto_shape" }
  const networks = [...infos.map((i) => i.network), crypto?.network].filter(
    (v) => v !== undefined,
  )
  if (
    !networks.length ||
    !networks.every((n) => typeof n === "string" && n.trim().toLowerCase() === "ethereum")
  )
    return { kind: "reject", reason: "unsupported_network" }

  const txids = [...infos.map((i) => i.txid), crypto?.networkTransactionId].filter(
    (v) => v !== undefined,
  )
  if (!txids.length || !txids.every((t) => typeof t === "string" && ethTxid.test(t)))
    return { kind: "reject", reason: "txid" }
  const normalized = new Set(txids.map((t) => (t as string).toLowerCase()))
  if (normalized.size !== 1) return { kind: "reject", reason: "txid_conflict" }
  const [txid] = [...normalized]

  const transactionId = tx.id
  if (typeof transactionId !== "string" || !providerId.test(transactionId))
    return { kind: "reject", reason: "transaction_id" }
  const walletId = tx.accountId
  if (typeof walletId !== "string" || !walletId)
    return { kind: "reject", reason: "account" }
  if (tx.currencyId !== undefined && tx.currencyId !== USDT_CURRENCY_ID)
    return { kind: "reject", reason: "currency" }
  const amountMicro = parseMicroUsdt(tx.amount)
  if (amountMicro === undefined || amountMicro <= 0n)
    return { kind: "reject", reason: "amount" }

  return {
    kind: "signal",
    signal: { transactionId, receiveInfoId, walletId, txid, amountMicro },
  }
}

export function classify(amountMinor: number, credits: Credit[]): UsdtCheckoutStatus {
  const expected = BigInt(amountMinor) * MICRO_PER_CENT
  let posted = 0n
  for (const c of credits) if (c.state === "POSTED") posted += BigInt(c.amountMicro)
  if (posted >= expected) return "PAID"
  return credits.length ? "DETECTED" : "AWAITING_PAYMENT"
}

export type IngestResult =
  | "ignored"
  | "rejected"
  | "not_pos"
  | "mismatch"
  | "conflict"
  | "detected"
  | "unverified"
  | "posted"
  | "already_posted"

/**
 * The outcome of recording one Hub delivery, before any IBEX read. Once this
 * resolves, the credit is durably stored (or the event is known not to need
 * storing). `readBack`, when present, confirms the stored DETECTED credit
 * against IBEX; skipping it is safe, as a status poll reads it back too.
 */
export type RecordedSignal = {
  result: IngestResult
  readBack?: () => Promise<IngestResult>
}

// At most this many pending credits are read back from IBEX per status poll.
const VERIFY_PER_STATUS = 3
const lastChecked = (c: Credit) => c.checkedAt?.getTime() ?? 0

export function usdtCheckoutService(d: Dependencies) {
  const settlement = (row: Row) => row.settlementWalletId ?? row.recipientWalletId
  const maxAmountMinor = d.maxAmountMinor ?? DEFAULT_MAX_AMOUNT_MINOR

  function parseAllocation(raw: unknown, walletId: string): Allocation | undefined {
    if (!isRecord(raw)) return undefined
    const { id, data, network, wallet_id, accountId, currencyId, currency } = raw
    if (typeof id !== "string" || !providerId.test(id)) return undefined
    const address = isRecord(data) ? data.address : undefined
    if (typeof address !== "string" || !ethAddress.test(address)) return undefined
    if (
      network !== undefined &&
      (typeof network !== "string" || network.toLowerCase() !== "ethereum")
    )
      return undefined
    for (const owner of [wallet_id, accountId])
      if (owner !== undefined && owner !== walletId) return undefined
    if (currencyId !== undefined && currencyId !== USDT_CURRENCY_ID) return undefined
    if (
      currency !== undefined &&
      (typeof currency !== "string" || currency.toUpperCase() !== "USDT")
    )
      return undefined
    return { receiveInfoId: id, address: address.toLowerCase() }
  }

  async function verify(row: Row, credit: Credit): Promise<IngestResult> {
    let back: PostedReadback | null
    try {
      back = await d.readPosted(credit._id)
    } catch {
      back = null
    }
    if (!back) return "unverified"
    if (typeof back.status !== "string" || back.status.toLowerCase() !== "completed")
      return "unverified"
    const problems: string[] = []
    if (back.transactionTypeId !== CRYPTO_RECEIVE_TYPE_ID) problems.push("type")
    if (back.accountId !== settlement(row) || back.accountId !== credit.walletId)
      problems.push("account")
    if (back.currencyId !== undefined && back.currencyId !== USDT_CURRENCY_ID)
      problems.push("currency")
    const amount = parseMicroUsdt(back.amount)
    if (amount === undefined || amount.toString() !== credit.amountMicro)
      problems.push("amount")
    if (typeof back.txid !== "string" || back.txid.toLowerCase() !== credit.txid)
      problems.push("txid")
    if (problems.length) {
      d.report("readback_mismatch", { transactionId: credit._id, problems })
      return "unverified"
    }
    await d.store.post(credit._id, {
      checkoutKey: row._id,
      amountMicro: credit.amountMicro,
      txid: credit.txid,
      walletId: settlement(row),
    })
    return "posted"
  }

  async function confirmedCredits(key: string, row: Row) {
    let credits = await d.store.credits(key)
    // Never checked first, then the longest ago, so a sale with many pending
    // credits works through all of them instead of the same first few.
    const pending = credits
      .filter((c) => c.state === "DETECTED")
      .sort((a, b) => lastChecked(a) - lastChecked(b))
    if (pending.length && classify(row.amountMinor, credits) !== "PAID") {
      // A lost or queued completion event: read the credit back from IBEX.
      let checked = 0
      for (const credit of pending) {
        if (checked >= VERIFY_PER_STATUS) break
        // In this order, one checked too recently means the rest were too
        // (or another poll is checking them right now).
        if (!(await d.store.touch(credit._id))) break
        checked++
        await verify(row, credit)
      }
      credits = await d.store.credits(key)
    }
    return credits
  }

  function receipt(id: string, row: Row, credits: Credit[]) {
    if (!row.address || !row.receiveInfoId || row.network !== USDT_NETWORK)
      throw working()
    return {
      id,
      recipientWalletId: row.recipientWalletId,
      address: row.address,
      network: row.network,
      status: classify(row.amountMinor, credits),
      amountMinor: row.amountMinor,
    }
  }

  async function allocate(key: string, lease: string, row: Row): Promise<Allocation> {
    // Read before IBEX is asked, so a failure here cannot strand a receive info.
    const reserved = (await d.reservedAddresses(row.recipientWalletId)).map((a) =>
      a.toLowerCase(),
    )
    const attempt = randomUUID()
    if (!(await d.store.begin(key, lease, attempt))) {
      // An earlier attempt's provider call never resolved here: it may have
      // created a receive info. Asking again could leave an orphan.
      const now = await d.store.read(key)
      if (now?.attempt && !now.candidate) {
        await d.store.fail(key, "AMBIGUOUS")
        d.report("ambiguous_allocation", { checkoutKey: key })
        throw new UsdtCheckoutError(
          "This sale's receiving address could not be confirmed. Start a new sale.",
        )
      }
      throw working()
    }
    let raw: unknown
    try {
      // A name derived from the digest: it never carries the capability.
      raw = await d.newReceiveInfo(settlement(row), `Flash POS ${key.slice(0, 16)}`)
    } catch (err) {
      if (err instanceof ProviderRejectedError) {
        await d.store.abandon(key, lease, attempt)
        throw new UsdtCheckoutError(
          "Flash could not issue a receiving address. Retry this sale later.",
        )
      }
      await d.store.fail(key, "AMBIGUOUS")
      d.report("ambiguous_allocation", { checkoutKey: key })
      throw new UsdtCheckoutError(
        "This sale's receiving address could not be confirmed. Start a new sale.",
      )
    }
    const allocation = parseAllocation(raw, settlement(row))
    if (!allocation) {
      await d.store.fail(key, "INVALID")
      d.report("invalid_allocation", { checkoutKey: key })
      throw new UsdtCheckoutError(
        "The provider returned an unusable receiving address. Start a new sale.",
      )
    }
    if (reserved.includes(allocation.address)) {
      await d.store.fail(key, "COLLISION")
      d.report("reserved_address_collision", { checkoutKey: key })
      throw new CollisionError()
    }
    if (!(await d.store.stage(key, lease, attempt, allocation))) {
      // The lease ran out during the call. The marker stays, so the next
      // attempt fails closed instead of asking for a second receive info.
      d.report("lost_lease_after_allocation", { checkoutKey: key })
      throw working()
    }
    return allocation
  }

  /**
   * Stores the credit one signed Hub delivery reports, without reading IBEX.
   * A credit is stored once per IBEX transaction and only ever moves from
   * DETECTED to POSTED. Throws only when storage could not be read or
   * written: the delivery must then be retried.
   */
  async function record(body: unknown): Promise<RecordedSignal> {
    const parsed = parseHubEvent(body)
    if (parsed.kind === "ignore") return { result: "ignored" }
    if (parsed.kind === "reject") {
      const tx: Record<string, unknown> =
        isRecord(body) && isRecord(body.transaction) ? body.transaction : {}
      const transactionId = tx.id
      d.report("unsupported_event", {
        reason: parsed.reason,
        transactionId:
          typeof transactionId === "string" ? transactionId.slice(0, 128) : undefined,
      })
      return { result: "rejected" }
    }
    const { signal } = parsed
    const row = await d.store.findByReceiveInfo(signal.receiveInfoId)
    if (!row) return { result: "not_pos" }
    if (
      row.network !== USDT_NETWORK ||
      row.receiveInfoId !== signal.receiveInfoId ||
      signal.walletId !== settlement(row)
    ) {
      d.report("credit_mismatch", {
        transactionId: signal.transactionId,
        checkoutKey: row._id,
      })
      return { result: "mismatch" }
    }
    const wanted: Credit = {
      _id: signal.transactionId,
      checkoutKey: row._id,
      receiveInfoId: signal.receiveInfoId,
      walletId: signal.walletId,
      txid: signal.txid,
      amountMicro: signal.amountMicro.toString(),
      state: "DETECTED",
    }
    const stored = await d.store.addCredit(wanted)
    if (
      stored.checkoutKey !== wanted.checkoutKey ||
      stored.receiveInfoId !== wanted.receiveInfoId ||
      stored.walletId !== wanted.walletId ||
      stored.txid !== wanted.txid ||
      stored.amountMicro !== wanted.amountMicro
    ) {
      d.report("credit_conflict", { transactionId: signal.transactionId })
      return { result: "conflict" }
    }
    if (stored.state === "POSTED") return { result: "already_posted" }
    return { result: "detected", readBack: () => verify(row, stored) }
  }

  return {
    async supports(walletId?: string) {
      return walletId ? Boolean(await d.enabled(walletId)) : false
    },

    async create(
      input: { recipientWalletId: string; requestId: string; amountMinor: number },
      ip: string,
    ) {
      const { recipientWalletId, requestId, amountMinor } = input
      if (
        typeof requestId !== "string" ||
        !capability.test(requestId) ||
        !Number.isSafeInteger(amountMinor) ||
        amountMinor < 1 ||
        amountMinor > maxAmountMinor
      )
        throw new UsdtCheckoutError("Enter a valid amount and a valid sale reference.")
      const eligible = await d.enabled(recipientWalletId)
      if (!eligible)
        throw new UsdtCheckoutError("USDT checkout is unavailable for this wallet.")

      const settlementWalletId =
        typeof eligible === "string" ? eligible : recipientWalletId

      // Reproducible after a lost response; Mongo stores only its digest.
      const id = hash("flash-pos-usdt-v1/" + recipientWalletId + "/" + requestId)
      const key = hash(id)
      let row = await d.store.read(key)
      const newRecord = !row
      if (!row) {
        await d.limitNew(recipientWalletId, ip)
        await d.store.reserve({
          _id: key,
          recipientWalletId,
          settlementWalletId,
          amountMinor,
          network: USDT_NETWORK,
        })
        row = await d.store.read(key)
      }
      if (
        !row ||
        row.amountMinor !== amountMinor ||
        settlement(row) !== settlementWalletId ||
        row.network !== USDT_NETWORK ||
        row.recipientWalletId !== recipientWalletId
      )
        throw new UsdtCheckoutError(
          "This sale reference already has different payment details.",
        )
      if (row.address) return receipt(id, row, await d.store.credits(key))
      if (row.failed)
        throw new UsdtCheckoutError(
          "This sale cannot receive a payment. Start a new sale.",
        )

      const lease = randomUUID()
      if (!(await d.store.claim(key, lease))) throw working()
      try {
        const current = await d.store.read(key)
        if (!current || current.failed) throw working()
        let allocation = current.candidate
        if (!allocation) {
          if (!newRecord) await d.limitNew(recipientWalletId, ip)
          allocation = await allocate(key, lease, current)
        }
        try {
          if (!(await d.store.publish(key, lease, allocation))) throw working()
        } catch (err) {
          if (err instanceof CollisionError) {
            await d.store.fail(key, "COLLISION")
            d.report("provider_collision", { checkoutKey: key })
          }
          throw err
        }
        return receipt(id, { ...current, ...allocation }, [])
      } finally {
        await d.store.release(key, lease)
      }
    },

    // An enrolled Live Activity is keyed by a one-way digest. A locked
    // phone can miss IBEX's second notification just like an open register.
    async followedStatus(key: string) {
      if (!capability.test(key)) return null
      const row = await d.store.read(key)
      if (!row?.address || !row.receiveInfoId || row.network !== USDT_NETWORK) return null
      return classify(row.amountMinor, await confirmedCredits(key, row))
    },

    async status(id: string) {
      if (typeof id !== "string" || !capability.test(id)) throw unknownCheckout()
      const key = hash(id)
      const row = await d.store.read(key)
      if (!row || !row.address || row.network !== USDT_NETWORK) throw unknownCheckout()
      const credits = await confirmedCredits(key, row)
      return receipt(id, row, credits)
    },

    /**
     * One IBEX Hub delivery that already passed the signature check: recorded
     * and then read back from IBEX. Safe to repeat, and in any order.
     */
    async ingest(body: unknown): Promise<IngestResult> {
      const recorded = await record(body)
      return recorded.readBack ? recorded.readBack() : recorded.result
    },

    record,
  }
}
