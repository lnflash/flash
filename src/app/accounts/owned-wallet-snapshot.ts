/** Descriptive owner-scoped metadata. Never routes, heals, balances or provisions. */
export type OwnedWalletMetadata = {
  id: string
  accountId: string
  walletCurrency: "BTC" | "USD" | "USDT"
  isExternal: boolean
}
export type OwnedWalletSnapshot = {
  publicAccountId: string
  walletAccountId: string
  defaultWalletId: string | null
  wallets: OwnedWalletMetadata[]
}
type AccountOwner = Pick<Account, "id" | "uuid" | "kratosUserId" | "defaultWalletId">
export type OwnedWalletSnapshotDependencies = {
  account(id: AccountId): Promise<AccountOwner | Error>
  wallets(
    id: AccountId,
  ): Promise<Pick<Wallet, "id" | "accountId" | "currency" | "type">[] | Error>
}
export class OwnedWalletSnapshotError extends Error {
  constructor(readonly kind: "unauthenticated" | "unavailable") {
    super("Owned wallet metadata is unavailable")
  }
}
const internalId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{24}$/.test(value)
const publicId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value)
const walletId = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  value.length <= 256 &&
  !/[^A-Za-z0-9_-]/.test(value)

export const getOwnedWalletSnapshot = async (
  {
    source,
    account: contextAccount,
    userId,
  }: {
    source: AccountOwner
    account?: AccountOwner
    userId?: UserId
  },
  supplied?: OwnedWalletSnapshotDependencies,
): Promise<OwnedWalletSnapshot | OwnedWalletSnapshotError> => {
  try {
    if (
      !userId ||
      !contextAccount ||
      !source ||
      contextAccount.kratosUserId !== userId ||
      source.kratosUserId !== userId ||
      source.id !== contextAccount.id ||
      source.uuid !== contextAccount.uuid
    ) {
      return new OwnedWalletSnapshotError("unauthenticated")
    }
    if (!internalId(source.id) || !publicId(source.uuid) || !publicId(userId))
      return new OwnedWalletSnapshotError("unavailable")
    const dependencies =
      supplied ??
      (await import("./owned-wallet-snapshot-adapters")).ownedWalletSnapshotDependencies()
    const fresh = await dependencies.account(source.id)
    if (
      fresh instanceof Error ||
      !fresh ||
      fresh.id !== source.id ||
      fresh.uuid !== source.uuid ||
      fresh.kratosUserId !== userId
    ) {
      return new OwnedWalletSnapshotError("unavailable")
    }
    const rows = await dependencies.wallets(fresh.id)
    if (!Array.isArray(rows) || rows.length > 1000)
      return new OwnedWalletSnapshotError("unavailable")
    const ids = new Set<string>(),
      wallets: OwnedWalletMetadata[] = []
    for (const row of rows) {
      if (
        !row ||
        !walletId(row.id) ||
        ids.has(row.id) ||
        row.accountId !== fresh.id ||
        !["checking", "external"].includes(row.type) ||
        !["BTC", "USD", "USDT"].includes(row.currency)
      ) {
        return new OwnedWalletSnapshotError("unavailable")
      }
      ids.add(row.id)
      wallets.push({
        id: row.id,
        accountId: row.accountId,
        walletCurrency: row.currency as OwnedWalletMetadata["walletCurrency"],
        isExternal: row.type === "external",
      })
    }
    const selected = fresh.defaultWalletId
    if (
      selected !== undefined &&
      selected !== null &&
      (!walletId(selected) || !ids.has(selected))
    )
      return new OwnedWalletSnapshotError("unavailable")
    // Re-read the owner after the wallet read so a replacement/owner change
    // during awaits is rejected without exposing foreign metadata.
    const final = await dependencies.account(fresh.id)
    if (
      final instanceof Error ||
      !final ||
      final.id !== fresh.id ||
      final.uuid !== fresh.uuid ||
      final.kratosUserId !== userId ||
      final.defaultWalletId !== selected
    )
      return new OwnedWalletSnapshotError("unavailable")
    return {
      publicAccountId: fresh.uuid,
      walletAccountId: fresh.id,
      defaultWalletId: selected ?? null,
      wallets: wallets.sort((a, b) => a.id.localeCompare(b.id)),
    }
  } catch {
    return new OwnedWalletSnapshotError("unavailable")
  }
}
