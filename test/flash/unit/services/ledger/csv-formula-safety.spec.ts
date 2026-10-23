jest.mock("@services/ibex/client", () => ({
  __esModule: true,
  default: { getAccountTransactions: jest.fn() },
}))
jest.mock("@services/logger", () => ({
  baseLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

import { CsvWalletsExport } from "@services/ledger/csv-wallet-export"

const row = (changes: Record<string, unknown> = {}): LedgerTransaction<WalletCurrency> =>
  ({
    id: "transaction-id",
    walletId: "wallet-id",
    type: "lightning",
    direction: "SEND",
    amount: -9007199254740993n,
    displayAmount: "-9007199254740993.001",
    fee: 0,
    displayFee: "-2.50",
    currency: "USDT",
    timestamp: "2026-10-23T01:00:00Z",
    status: "SUCCESS",
    memo: "ordinary memo",
    ...changes,
  }) as unknown as LedgerTransaction<WalletCurrency>

const exportRows = (...entries: LedgerTransaction<WalletCurrency>[]): string => {
  const csv = new CsvWalletsExport()
  csv.entries = entries
  return Buffer.from(csv.getBase64(), "base64").toString("utf8")
}

it("prefixes a formula before CSV quoting while retaining commas, quotes and embedded newlines", () => {
  const text = `  =HYPERLINK("https://example.invalid/a,b","open")\nsecond line`
  const output = exportRows(row({ memo: text }))

  expect(output).toContain(
    `"'  =HYPERLINK(""https://example.invalid/a,b"",""open"")\nsecond line"`,
  )
  expect(output).toContain("-9007199254740993.001")
  expect(output).toContain("-2.50")
  expect(output).not.toContain("'-9007199254740993.001")
  expect(output).not.toContain("'-2.50")
  expect(output).toContain("SEND")
})

it.each([
  "=1+1",
  "+cmd",
  "-cmd",
  "@SUM(1)",
  "\t=1+1",
  "\r\n@SUM(1)",
  "\uFEFF=1+1",
  "\u200B+cmd",
  "\u2028=1+1",
  "\u0301=1+1",
  "＝SUM(1)",
  "＋cmd",
  "－cmd",
  "＠SUM(1)",
  "−cmd",
])(
  "escapes a text cell that begins with a formula after Unicode normalization: %s",
  (text) => {
    const output = exportRows(row({ memo: text }))
    expect(output).toContain(`'${text}`)
    expect(output).not.toContain(`''${text}`)
  },
)

it("does not alter benign text, existing apostrophe guards, or exact financial numbers", () => {
  const output = exportRows(
    row({ memo: `normal, "quoted"\nnext`, displayAmount: "+2.50", displayFee: "-1e-6" }),
    row({ memo: "'=SUM(1)", displayAmount: "-2", displayFee: 0 }),
  )

  expect(output).toContain(`"normal, ""quoted""\nnext"`)
  expect(output).toContain("'=SUM(1)")
  expect(output).not.toContain("''=SUM(1)")
  expect(output).toContain("+2.50")
  expect(output).toContain("-1e-6")
  expect(output).not.toContain("'+2.50")
  expect(output).not.toContain("'-1e-6")
})

it("leaves the native-style second pass with no formula to prefix again", () => {
  const output = exportRows(row({ memo: "=SUM(1)" }))
  const encodedCell = output.trimEnd().split(/\r?\n/)[1].split(",").at(-1)!
  const serverCell = encodedCell.replace(/^"|"$/g, "")
  const nativeStylePass = (cell: string): string =>
    /^[=+@-]/.test(cell.trim()) ? `'${cell}` : cell

  expect(serverCell).toBe("'=SUM(1)")
  expect(nativeStylePass(serverCell)).toBe(serverCell)
  expect(nativeStylePass(serverCell)).not.toBe("''=SUM(1)")
})

it("escapes untrusted identifier and numeric-text formulas without changing the original entries", () => {
  const original = row({
    id: '=HYPERLINK("https://example.invalid")',
    walletId: "\u200B+wallet",
    displayAmount: "=1+1",
    displayFee: "-cmd",
  })
  const output = exportRows(original)

  expect(output).toContain(`'\u200B+wallet`)
  expect(output).toContain(`'=1+1`)
  expect(output).toContain(`'-cmd`)
  expect(output).toContain(`"'=HYPERLINK(""https://example.invalid"")"`)
  expect(original.id).toBe('=HYPERLINK("https://example.invalid")')
})
