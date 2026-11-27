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
