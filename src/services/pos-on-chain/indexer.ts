import axios from "axios"
import type { Totals } from "@app/pos-on-chain/checkout"

type Stats = { funded_txo_sum: number; funded_txo_count: number }
export function addressTotals(data: {
  chain_stats: Stats
  mempool_stats: Stats
}): Totals {
  const chain = data.chain_stats,
    pool = data.mempool_stats
  const receivedSats = chain.funded_txo_sum + pool.funded_txo_sum
  const fundedOutputs = chain.funded_txo_count + pool.funded_txo_count
  if (
    ![
      chain.funded_txo_sum,
      chain.funded_txo_count,
      pool.funded_txo_sum,
      pool.funded_txo_count,
      receivedSats,
      fundedOutputs,
    ].every((n) => Number.isSafeInteger(n) && n >= 0)
  )
    throw new Error("Invalid address index response")
  // Spending a received output later does not reverse a sale. RBF and reorgs can change the funded sums.
  return { receivedSats, confirmedSats: chain.funded_txo_sum, fundedOutputs }
}

type IndexedTx = {
  txid: string
  status: { confirmed: boolean; block_hash?: string }
  vout: { scriptpubkey_address?: string; value: number }[]
}

// Some Electrum-backed explorer servers return transaction counts but zero
// funded-output statistics. Count actual incoming outputs on those servers.
export function historyTotals(
  address: string,
  txs: IndexedTx[],
  chainCount: number,
  poolCount: number,
): Totals {
  const seen = new Set<string>()
  let mined = 0,
    receivedSats = 0,
    confirmedSats = 0,
    fundedOutputs = 0
  for (const tx of txs) {
    if (
      !/^[a-f0-9]{64}$/.test(tx.txid) ||
      seen.has(tx.txid) ||
      typeof tx.status?.confirmed !== "boolean" ||
      !Array.isArray(tx.vout)
    )
      throw new Error("Invalid address transaction")
    seen.add(tx.txid)
    if (tx.status.confirmed) {
      if (!/^[a-f0-9]{64}$/.test(tx.status.block_hash || ""))
        throw new Error("Unverified block")
      mined++
    }
    for (const out of tx.vout) {
      if (out.scriptpubkey_address !== address) continue
      if (!Number.isSafeInteger(out.value) || out.value < 0)
        throw new Error("Invalid output value")
      receivedSats += out.value
      if (tx.status.confirmed) confirmedSats += out.value
      fundedOutputs++
    }
  }
  if (
    mined !== chainCount ||
    txs.length - mined !== poolCount ||
    !Number.isSafeInteger(receivedSats)
  )
    throw new Error("Incomplete address history")
  return { receivedSats, confirmedSats, fundedOutputs }
}

// A chain check that passed once holds for the process: flashCheckout() builds a
// new esploraTotals per request, and repeating it would add an indexer request
// to every status poll.
const verified = new Set<string>()

export function esploraTotals(origin: string, genesis: string) {
  const api = axios.create({
    baseURL: origin.replace(/\/$/, "") + "/",
    timeout: 6000,
    maxRedirects: 0,
    maxContentLength: 8 * 1024 * 1024,
  })
  return async (address: string) => {
    const chain = origin + "/" + genesis
    if (!verified.has(chain)) {
      // Hashes are plain text; never let axios try to parse one as JSON.
      const { data } = await api.get("block-height/0", { responseType: "text" })
      if (data !== genesis) throw new Error("Checkout index is on a different chain")
      verified.add(chain)
    }
    const tip = async () => {
      const { data } = await api.get("blocks/tip/hash", { responseType: "text" })
      if (typeof data !== "string" || !/^[a-f0-9]{64}$/.test(data))
        throw new Error("Invalid index tip")
      return data
    }
    const block = await tip()
    const path = "address/" + encodeURIComponent(address)
    const { data } = await api.get(path)
    if (data.address !== address) throw new Error("Unexpected address from index")
    let totals = addressTotals(data)
    const chainCount = data.chain_stats.tx_count
    const poolCount = data.mempool_stats.tx_count
    if (![chainCount, poolCount].every((n) => Number.isSafeInteger(n) && n >= 0))
      throw new Error("Invalid address counts")
    if (
      (chainCount && !data.chain_stats.funded_txo_count) ||
      (poolCount && !data.mempool_stats.funded_txo_count)
    ) {
      const { data: txs } = await api.get<IndexedTx[]>(path + "/txs")
      if (!Array.isArray(txs)) throw new Error("Invalid address history")
      totals = historyTotals(address, txs, chainCount, poolCount)
    }
    // All funded chain outputs, including the current tip, have at least one confirmation.
    if ((await tip()) !== block) throw new Error("Checkout index tip changed. Retry.")
    return totals
  }
}

export type TotalsReader = (address: string) => Promise<Totals>
export type NamedReader = { name: string; read: TotalsReader }

// How long an indexer that just failed is passed over. Without it every read
// during an outage waits out the first indexer's timeout before trying the next.
export const INDEXER_COOL_DOWN_MS = 30_000
const coolingUntil = new Map<string, number>()
export const __resetIndexerCoolDownForTest = () => coolingUntil.clear()

/**
 * Reads from the first indexer that answers.
 *
 * Each read uses ONE indexer from start to finish: an indexer's own tip check
 * brackets its answer, and mixing two indexers inside a read would defeat it.
 * An indexer that throws (unreachable, throttled, wrong chain, tip moved) is
 * passed over for `INDEXER_COOL_DOWN_MS` and the next one is asked. If every
 * indexer is cooling down they are all tried anyway, in order, so an outage of
 * all of them never turns into a refusal that outlives it. When all fail, the
 * last error is thrown and the checkout reports a temporary failure.
 *
 * An indexer that ANSWERS is believed, including when it says an address has
 * no history. Only list indexers you would trust on their own.
 */
export function firstAvailable(
  readers: NamedReader[],
  onFailure: (name: string, error: unknown) => void = () => undefined,
  now: () => number = Date.now,
): TotalsReader {
  return async (address) => {
    const ready = readers.filter((r) => (coolingUntil.get(r.name) ?? 0) <= now())
    let last: unknown = new Error("No checkout index is configured")
    for (const reader of ready.length ? ready : readers) {
      try {
        const totals = await reader.read(address)
        coolingUntil.delete(reader.name)
        return totals
      } catch (error) {
        last = error
        coolingUntil.set(reader.name, now() + INDEXER_COOL_DOWN_MS)
        onFailure(reader.name, error)
      }
    }
    throw last
  }
}
