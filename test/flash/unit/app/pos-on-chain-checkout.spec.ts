import { payments, networks } from "bitcoinjs-lib"
import { checkoutService, Dependencies, Row } from "@app/pos-on-chain/checkout"
import { addressTotals, historyTotals } from "@services/pos-on-chain/indexer"

const address = payments.p2wpkh({
  hash: Buffer.alloc(20, 1),
  network: networks.testnet,
}).address!
const request = { recipientWalletId: "merchant", sats: 1000, requestId: "a".repeat(64) }
function setup() {
  const rows = new Map<string, Row>()
  const leases = new Map<string, string>()
  const deps: Dependencies = {
    network: "SIGNET",
    enabled: (id) => id === "merchant",
    newAddress: jest.fn(async () => address),
    totals: jest.fn(async () => ({
      receivedSats: 0,
      confirmedSats: 0,
      fundedOutputs: 0,
    })),
    limitNew: jest.fn(async () => undefined),
    store: {
      async read(k) {
        return rows.get(k) ?? null
      },
      async reserve(row) {
        if (!rows.has(row._id)) rows.set(row._id, row)
      },
      async claim(k, lease) {
        if (leases.has(k) || rows.get(k)?.address) return false
        leases.set(k, lease)
        return true
      },
      async publish(k, lease, a) {
        if (
          leases.get(k) !== lease ||
          [...rows.values()].some((row) => row.address === a)
        )
          return false
        rows.set(k, { ...rows.get(k)!, address: a })
        return true
      },
      async release(k, lease) {
        if (leases.get(k) === lease) leases.delete(k)
      },
    },
  }
  return { deps, rows, service: checkoutService(deps) }
}
it("recovers the same QR after a lost response, without allocating another receiving address", async () => {
  const { service, deps, rows } = setup()
  const result = await service.create(request)
  expect(await service.create(request)).toEqual(result)
  expect(await service.status(result.id)).toEqual(result)
  expect(deps.newAddress).toHaveBeenCalledTimes(1)
  expect(deps.newAddress).toHaveBeenCalledWith(request.recipientWalletId)
  expect(rows.has(result.id)).toBe(false)
  await expect(service.create({ ...request, sats: 1001 })).rejects.toThrow(
    /different payment/,
  )
  await expect(
    service.create({ ...request, recipientWalletId: "other" }),
  ).rejects.toThrow(/unavailable/)
})
it("publishes once across concurrent creates and rejects a reused provider address", async () => {
  const { service, deps } = setup()
  const results = await Promise.allSettled([
    service.create(request),
    service.create(request),
  ])
  expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1)
  expect(deps.newAddress).toHaveBeenCalledTimes(1)
  await expect(
    service.create({ ...request, requestId: "b".repeat(64) }),
  ).rejects.toThrow()
})
it("releases the reservation after an upstream outage and refuses previously funded or wrong-network addresses", async () => {
  const { service, deps } = setup()
  const allocate = deps.newAddress as jest.Mock
  allocate.mockRejectedValueOnce(new Error("offline"))
  await expect(service.create(request)).rejects.toThrow("offline")
  allocate.mockResolvedValueOnce(
    payments.p2wpkh({ hash: Buffer.alloc(20, 1), network: networks.bitcoin }).address,
  )
  await expect(service.create(request)).rejects.toThrow()
  ;(deps.totals as jest.Mock).mockResolvedValueOnce({
    receivedSats: 0,
    confirmedSats: 0,
    fundedOutputs: 1,
  })
  await expect(service.create(request)).rejects.toThrow(/fresh address/)
  expect((await service.create(request)).address).toBe(address)
})
it("reflects mempool replacement, partial payment, confirmation and reorg against one sale", async () => {
  const { service, deps } = setup()
  const sale = await service.create(request)
  for (const [receivedSats, confirmedSats, status] of [
    [1000, 0, "PENDING"],
    [0, 0, "AWAITING_PAYMENT"],
    [800, 800, "PENDING"],
    [1001, 1001, "CONFIRMED"],
    [1000, 0, "PENDING"],
  ] as const) {
    ;(deps.totals as jest.Mock).mockResolvedValueOnce({
      receivedSats,
      confirmedSats,
      fundedOutputs: 1,
    })
    expect((await service.status(sale.id)).status).toBe(status)
  }
})
it("requires a valid capability, an eligible amount and consistent indexer counts", async () => {
  const { service } = setup()
  await expect(service.status("bad")).rejects.toThrow(/Unknown/)
  await expect(service.create({ ...request, sats: 123.45 })).rejects.toThrow()
  await expect(service.create({ ...request, requestId: "guess" })).rejects.toThrow()
  expect(() =>
    addressTotals({
      chain_stats: { funded_txo_count: -1, funded_txo_sum: 100 },
      mempool_stats: { funded_txo_count: 0, funded_txo_sum: 0 },
    }),
  ).toThrow()
})

it("counts the tip block at one confirmation and keeps mempool outputs separate", () => {
  expect(
    addressTotals({
      chain_stats: { funded_txo_sum: 700, funded_txo_count: 1 },
      mempool_stats: { funded_txo_sum: 300, funded_txo_count: 1 },
    }),
  ).toEqual({ receivedSats: 1000, confirmedSats: 700, fundedOutputs: 2 })
})

it("counts actual outputs when an explorer omits funded sums and rejects a truncated history", () => {
  const mined = {
    txid: "a".repeat(64),
    status: { confirmed: true, block_hash: "b".repeat(64) },
    vout: [{ scriptpubkey_address: address, value: 800 }],
  }
  const pending = {
    txid: "c".repeat(64),
    status: { confirmed: false },
    vout: [{ scriptpubkey_address: address, value: 200 }],
  }
  expect(historyTotals(address, [pending, mined], 1, 1)).toEqual({
    receivedSats: 1000,
    confirmedSats: 800,
    fundedOutputs: 2,
  })
  expect(() => historyTotals(address, [mined], 1, 1)).toThrow(/Incomplete/)
  expect(() => historyTotals(address, [mined, mined], 2, 0)).toThrow(/Invalid/)
})
