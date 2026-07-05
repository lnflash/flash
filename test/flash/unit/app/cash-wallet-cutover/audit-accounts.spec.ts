import { auditCashWalletCutoverAccounts } from "@app/cash-wallet-cutover/audit-accounts"

const doc = ({
  id,
  role,
  errors,
}: {
  id: string
  role?: string
  errors?: Record<string, { message: string }>
}) => ({
  _id: { toString: () => id },
  role,
  validateSync: () => (errors ? { errors } : undefined),
})

async function* documents(...docs: ReturnType<typeof doc>[]) {
  yield* docs
}

describe("auditCashWalletCutoverAccounts", () => {
  it("reports accounts whose document fails mongoose validation", async () => {
    const report = await auditCashWalletCutoverAccounts({
      listAccountDocuments: () =>
        documents(
          doc({ id: "good-account" }),
          doc({
            id: "empty-username",
            errors: {
              username: {
                message:
                  "Path `username` (``) is shorter than the minimum allowed length (3).",
              },
            },
          }),
          doc({
            id: "null-status",
            role: "funder",
            errors: {
              "statusHistory.0.status": { message: "Path `status` is required." },
            },
          }),
        ),
    })

    expect(report.scanned).toBe(3)
    expect(report.invalid).toBe(2)
    expect(report.issues).toEqual([
      {
        accountId: "empty-username",
        role: undefined,
        errors: [expect.stringMatching(/username/)],
      },
      {
        accountId: "null-status",
        role: "funder",
        errors: ["Path `status` is required."],
      },
    ])
  })

  it("reports a clean sweep when every account validates", async () => {
    const report = await auditCashWalletCutoverAccounts({
      listAccountDocuments: () => documents(doc({ id: "a" }), doc({ id: "b" })),
    })

    expect(report).toEqual({ scanned: 2, invalid: 0, issues: [] })
  })
})
