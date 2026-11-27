import { createHash, randomUUID } from "crypto"

import { address as bitcoinAddress, networks } from "bitcoinjs-lib"

export type Network = "MAINNET" | "TESTNET" | "SIGNET" | "REGTEST"
type Request = { recipientWalletId: string; sats: number; requestId: string }
export type Row = {
  _id: string
  recipientWalletId: string
  sats: number
  network: Network
  address?: string
  // An allocated, valid address not yet shown to anyone. A retry after a failed
  // freshness check reuses it instead of spending another allocation.
  candidate?: string
}
export type Totals = {
  receivedSats: number
  confirmedSats: number
  fundedOutputs: number
}
export type Store = {
  read(key: string): Promise<Row | null>
  reserve(row: Row): Promise<void>
  claim(key: string, lease: string): Promise<boolean>
  stage(key: string, lease: string, address: string): Promise<boolean>
  discard(key: string, lease: string): Promise<void>
  // Throws ReusedAddressError when another checkout already holds the address.
  publish(key: string, lease: string, address: string): Promise<boolean>
  release(key: string, lease: string): Promise<void>
}
export type Dependencies = {
  network: Network
  // Asked on every create, retries included, so a merchant who stops being
  // eligible stops getting addresses at once.
  enabled(walletId: string): boolean | Promise<boolean>
  store: Store
  limitNew(walletId: string, ip: string): Promise<void>
  newAddress(walletId: string): Promise<string>
  totals(address: string): Promise<Totals>
}
const hash = (v: string) => createHash("sha256").update(v).digest("hex")
const capability = /^[0-9a-f]{64}$/
const maximumSats = 21000000 * 100000000
export class CheckoutError extends Error {}
export class ReusedAddressError extends CheckoutError {
  constructor() {
    super("The provider reused a receiving address. Start a new sale or contact support.")
  }
}
const working = () =>
  new CheckoutError("Preparing the address. Retry this same sale in a moment.")

export function classify(sats: number, receivedSats: number, confirmedSats: number) {
  if (
    ![sats, receivedSats, confirmedSats].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= maximumSats,
    ) ||
    !sats ||
    confirmedSats > receivedSats
  )
    throw new CheckoutError("Invalid payment observation.")
  if (confirmedSats >= sats) return "CONFIRMED"
  return receivedSats > 0 ? "PENDING" : "AWAITING_PAYMENT"
}

export function checkoutService(d: Dependencies) {
  const net =
    d.network === "MAINNET"
      ? networks.bitcoin
      : d.network === "REGTEST"
        ? networks.regtest
        : networks.testnet
  function valid(allocated: string) {
    const address = /^(bc1|tb1|bcrt1)/i.test(allocated)
      ? allocated.toLowerCase()
      : allocated
    if (address !== allocated && allocated !== allocated.toUpperCase())
      throw new CheckoutError("Invalid receiving address.")
    bitcoinAddress.toOutputScript(address, net)
    return address
  }

  async function receipt(id: string, row: Row, totals?: Totals) {
    if (!row.address || row.network !== d.network) throw working()
    const observed = totals ?? (await d.totals(row.address))
    const { receivedSats, confirmedSats } = observed
    return {
      id,
      recipientWalletId: row.recipientWalletId,
      address: row.address,
      network: row.network,
      sats: row.sats,
      status: classify(row.sats, receivedSats, confirmedSats),
      receivedSats,
      confirmedSats,
    }
  }

  return {
    supports: async (walletId?: string) => (walletId ? d.enabled(walletId) : false),
    async create(input: Request, ip: string) {
      const { recipientWalletId, requestId, sats } = input
      if (
        !capability.test(requestId) ||
        !Number.isSafeInteger(sats) ||
        sats < 546 ||
        sats > maximumSats
      )
        throw new CheckoutError("Enter at least 546 sats and a valid sale reference.")
      if (!(await d.enabled(recipientWalletId)))
        throw new CheckoutError("On-chain checkout is unavailable for this wallet.")
      // The opaque receipt capability is reproducible after a lost response. Mongo stores only its digest.
      const id = hash("flash-pos-chain-v1/" + recipientWalletId + "/" + requestId)
      const key = hash(id)
      let row = await d.store.read(key)
      const newRecord = !row
      if (!row) {
        await d.limitNew(recipientWalletId, ip)
        await d.store.reserve({ _id: key, recipientWalletId, sats, network: d.network })
        row = await d.store.read(key)
      }
      if (
        !row ||
        row.sats !== sats ||
        row.network !== d.network ||
        row.recipientWalletId !== recipientWalletId
      )
        throw new CheckoutError(
          "This sale reference already has different payment details.",
        )
      if (row.address) return receipt(id, row)
      const lease = randomUUID()
      if (!(await d.store.claim(key, lease))) throw working()
      try {
        // Re-read under the lease: a previous attempt may have staged an address.
        let address = (await d.store.read(key))?.candidate
        if (!address) {
          if (!newRecord) await d.limitNew(recipientWalletId, ip)
          address = valid(await d.newAddress(recipientWalletId))
          // Persist before the indexer is asked, so an indexer outage costs a
          // retry, not another allocation.
          if (!(await d.store.stage(key, lease, address))) throw working()
        }
        const totals = await d.totals(address)
        if (totals.fundedOutputs || totals.receivedSats || totals.confirmedSats) {
          // Never shown to anyone, so it is safe to drop; the next retry allocates.
          await d.store.discard(key, lease)
          throw new CheckoutError(
            "The provider did not issue a fresh address. Retry this sale.",
          )
        }
        // Once a QR has been returned, all retries must resolve to this same destination.
        try {
          if (!(await d.store.publish(key, lease, address))) throw working()
        } catch (err) {
          if (err instanceof ReusedAddressError) await d.store.discard(key, lease)
          throw err
        }
        return receipt(id, { ...row, address }, totals)
      } finally {
        await d.store.release(key, lease)
      }
    },
    async status(id: string) {
      if (!capability.test(id)) throw new CheckoutError("Unknown checkout.")
      const row = await d.store.read(hash(id))
      if (!row || !row.address || row.network !== d.network)
        throw new CheckoutError("Unknown checkout.")
      return receipt(id, row)
    },
  }
}
