import {
  INDEXER_COOL_DOWN_MS,
  NamedReader,
  __resetIndexerCoolDownForTest,
  firstAvailable,
} from "@services/pos-on-chain/indexer"

jest.mock("axios", () => ({ create: jest.fn() }))

const address = "bc1qexample"
const answer = (n: number) => ({ receivedSats: n, confirmedSats: n, fundedOutputs: 1 })
const up = (name: string, n: number): NamedReader & { read: jest.Mock } => ({
  name,
  read: jest.fn(async () => answer(n)),
})
type Answer = ReturnType<typeof answer>
const down = (name: string, message = name + " is down") => ({
  name,
  read: jest.fn(async (): Promise<Answer> => {
    throw new Error(message)
  }),
})

let clock = 1_000_000
const now = () => clock

beforeEach(() => {
  __resetIndexerCoolDownForTest()
  clock = 1_000_000
})

describe("firstAvailable", () => {
  it("uses the first indexer and never touches the second while the first answers", async () => {
    const first = up("first", 1)
    const second = up("second", 2)
    const read = firstAvailable([first, second], undefined, now)

    expect(await read(address)).toEqual(answer(1))
    expect(await read(address)).toEqual(answer(1))
    expect(second.read).not.toHaveBeenCalled()
  })

  it("falls back to the second when the first throws, and reports the failure", async () => {
    const first = down("first", "429 Too Many Requests")
    const second = up("second", 2)
    const failures: [string, string][] = []
    const read = firstAvailable(
      [first, second],
      (name, error) => failures.push([name, (error as Error).message]),
      now,
    )

    expect(await read(address)).toEqual(answer(2))
    expect(failures).toEqual([["first", "429 Too Many Requests"]])
  })

  it("believes an indexer that answers with no history: an empty answer is not a failure", async () => {
    const first = up("first", 0)
    const second = up("second", 700)
    const read = firstAvailable([first, second], undefined, now)

    expect(await read(address)).toEqual(answer(0))
    expect(second.read).not.toHaveBeenCalled()
  })

  it("passes over a failed indexer for the cool-down, then tries it again", async () => {
    const first = down("first")
    const second = up("second", 2)
    const read = firstAvailable([first, second], undefined, now)

    await read(address)
    expect(first.read).toHaveBeenCalledTimes(1)

    clock += INDEXER_COOL_DOWN_MS - 1
    await read(address)
    expect(first.read).toHaveBeenCalledTimes(1)

    clock += 2
    first.read.mockImplementation(async () => answer(1))
    expect(await read(address)).toEqual(answer(1))
    expect(first.read).toHaveBeenCalledTimes(2)
  })

  it("returns to the first indexer for good once it answers again", async () => {
    const first = down("first")
    const second = up("second", 2)
    const read = firstAvailable([first, second], undefined, now)

    await read(address)
    clock += INDEXER_COOL_DOWN_MS + 1
    first.read.mockImplementation(async () => answer(1))
    await read(address)
    second.read.mockClear()

    expect(await read(address)).toEqual(answer(1))
    expect(second.read).not.toHaveBeenCalled()
  })

  it("throws the last error when every indexer fails", async () => {
    const read = firstAvailable([down("first"), down("second")], undefined, now)

    await expect(read(address)).rejects.toThrow("second is down")
  })

  it("still tries every indexer when all of them are cooling down", async () => {
    const first = down("first")
    const second = down("second")
    const read = firstAvailable([first, second], undefined, now)

    await expect(read(address)).rejects.toThrow()
    second.read.mockImplementation(async () => answer(2))

    expect(await read(address)).toEqual(answer(2))
    expect(first.read).toHaveBeenCalledTimes(2)
  })

  it("with a single indexer, behaves as before: its error is the caller's error", async () => {
    const read = firstAvailable([down("only", "Checkout index tip changed. Retry.")])

    await expect(read(address)).rejects.toThrow("Checkout index tip changed. Retry.")
    await expect(read(address)).rejects.toThrow("Checkout index tip changed. Retry.")
  })

  it("keeps the cool-down per indexer, shared by readers built for later requests", async () => {
    const first = down("first")
    const second = up("second", 2)

    await firstAvailable([first, second], undefined, now)(address)
    await firstAvailable([first, second], undefined, now)(address)

    expect(first.read).toHaveBeenCalledTimes(1)
  })
})
