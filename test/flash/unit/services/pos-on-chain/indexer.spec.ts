import { create as createAxios } from "axios"

import { esploraTotals } from "@services/pos-on-chain/indexer"

jest.mock("axios", () => ({ create: jest.fn() }))

const genesis = "00000008819873e925422c1ff0f99f7cc9bbb232af63a077a480a3633bee1ef6"
const tipA = "a".repeat(64)
const tipB = "b".repeat(64)
const address = "tb1qexample"
const stats = (tx_count: number, funded_txo_count: number, funded_txo_sum: number) => ({
  tx_count,
  funded_txo_count,
  funded_txo_sum,
})
let origin = 0
const nextOrigin = () => `https://esplora-${++origin}.example`

function indexer(routes: Record<string, unknown | (() => unknown)>) {
  const get = jest.fn<Promise<{ data: unknown }>, [string, unknown?]>(async (path) => {
    if (!(path in routes)) throw new Error("unexpected " + path)
    const route = routes[path]
    return { data: typeof route === "function" ? route() : route }
  })
  ;(createAxios as jest.Mock).mockReturnValue({ get })
  return get
}
const addressInfo = {
  address,
  chain_stats: stats(1, 1, 700),
  mempool_stats: stats(0, 0, 0),
}

it("reads the totals and checks the chain once per process", async () => {
  const get = indexer({
    "block-height/0": genesis,
    "blocks/tip/hash": tipA,
    [`address/${address}`]: addressInfo,
  })
  const totals = esploraTotals(nextOrigin(), genesis)
  const expected = { receivedSats: 700, confirmedSats: 700, fundedOutputs: 1 }
  expect(await totals(address)).toEqual(expected)
  expect(await totals(address)).toEqual(expected)
  expect(get.mock.calls.filter(([path]) => path === "block-height/0")).toHaveLength(1)
  // Hashes are plain text, never parsed as JSON.
  const hashReads = get.mock.calls.filter(
    ([path]) => path === "block-height/0" || path === "blocks/tip/hash",
  )
  expect(hashReads.map(([, config]) => config)).toEqual(
    hashReads.map(() => ({ responseType: "text" })),
  )
})

it("refuses an index on a different chain, and checks again next time", async () => {
  const get = indexer({ "block-height/0": "c".repeat(64) })
  const totals = esploraTotals(nextOrigin(), genesis)
  await expect(totals(address)).rejects.toThrow(/different chain/)
  await expect(totals(address)).rejects.toThrow(/different chain/)
  expect(get).toHaveBeenCalledTimes(2)
})

it("refuses totals read across a tip change", async () => {
  const tips = [tipA, tipB]
  indexer({
    "block-height/0": genesis,
    "blocks/tip/hash": () => tips.shift(),
    [`address/${address}`]: addressInfo,
  })
  await expect(esploraTotals(nextOrigin(), genesis)(address)).rejects.toThrow(
    /tip changed/,
  )
})

it("refuses an answer for a different address", async () => {
  indexer({
    "block-height/0": genesis,
    "blocks/tip/hash": tipA,
    [`address/${address}`]: { ...addressInfo, address: "tb1qother" },
  })
  await expect(esploraTotals(nextOrigin(), genesis)(address)).rejects.toThrow(
    /Unexpected address/,
  )
})

it("counts the history when an explorer reports transactions but no funded outputs", async () => {
  const get = indexer({
    "block-height/0": genesis,
    "blocks/tip/hash": tipA,
    [`address/${address}`]: {
      address,
      chain_stats: stats(1, 0, 0),
      mempool_stats: stats(0, 0, 0),
    },
    [`address/${address}/txs`]: [
      {
        txid: "d".repeat(64),
        status: { confirmed: true, block_hash: tipA },
        vout: [{ scriptpubkey_address: address, value: 900 }],
      },
    ],
  })
  expect(await esploraTotals(nextOrigin(), genesis)(address)).toEqual({
    receivedSats: 900,
    confirmedSats: 900,
    fundedOutputs: 1,
  })
  expect(get).toHaveBeenCalledWith(`address/${address}/txs`)
})
