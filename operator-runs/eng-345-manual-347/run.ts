import fs from "fs/promises"
import path from "path"
import { randomUUID } from "crypto"

import { getDefaultAccountsConfig } from "@config"

import { Accounts, CashWalletCutover, Payments, Wallets } from "@app"
import { getBalanceForWallet } from "@app/wallets"
import { WalletCurrency } from "@domain/shared"
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { WalletType } from "@domain/wallets"

import { setupMongoConnection } from "@services/mongodb"
import {
  AccountsRepository,
  CashWalletCutoverRepository,
  WalletsRepository,
} from "@services/mongoose"
import { Account, CashWalletCutoverConfig } from "@services/mongoose/schema"

type TargetAccount = {
  index: number
  phone: string
  kratosUserId: string
  accountId: string
  accountUuid?: string
  legacyUsdWalletId: string
  destinationUsdtWalletId: string
  startingFundingCents: number
}

type Manifest = {
  cutoverVersion: number
  runId: string
  createdAt: string
  funderUsdWalletId?: string
  accounts: TargetAccount[]
}

const CUTOVER_VERSION = 347
const RUN_ID = "manual-eng-347"
const ACCOUNT_COUNT = 10
const OUTPUT_DIR = path.resolve("operator-runs/eng-345-manual-347")
const MANIFEST_PATH = path.join(OUTPUT_DIR, "manifest.json")
const RESULTS_PATH = path.join(OUTPUT_DIR, "results.json")
const PROGRESS_PATH = path.join(OUTPUT_DIR, "progress.md")

const logProgress = async (line: string) => {
  await fs.appendFile(PROGRESS_PATH, `- ${new Date().toISOString()} ${line}\n`)
}

const throwIfError = <T>(result: T | Error): T => {
  if (result instanceof Error) throw result
  return result
}

const loadManifest = async (): Promise<Manifest> => {
  const raw = await fs.readFile(MANIFEST_PATH, "utf8")
  return JSON.parse(raw) as Manifest
}

const saveManifest = async (manifest: Manifest) => {
  await fs.writeFile(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`)
}

const listWalletsForAccount = async (accountId: string) => {
  const wallets = throwIfError(
    await WalletsRepository().listByAccountId(accountId as AccountId),
  )
  const usd = wallets.find((wallet) => wallet.currency === WalletCurrency.Usd)
  const usdt = wallets.find((wallet) => wallet.currency === WalletCurrency.Usdt)

  if (!usd) throw new Error(`Missing USD wallet for account ${accountId}`)
  if (!usdt) throw new Error(`Missing USDT wallet for account ${accountId}`)

  return { usd, usdt }
}

const funderUsdWalletId = async (): Promise<string> => {
  const funder = await Account.findOne({ role: "funder" })
  if (!funder) throw new Error("Missing funder account")

  const wallets = throwIfError(
    await WalletsRepository().listByAccountId(funder._id.toString() as AccountId),
  )
  const usdWallet = wallets.find((wallet) => wallet.currency === WalletCurrency.Usd)
  if (!usdWallet) throw new Error("Missing funder USD wallet")

  return usdWallet.id
}

const createAccounts = async () => {
  await fs.mkdir(OUTPUT_DIR, { recursive: true })

  const config = getDefaultAccountsConfig()
  const existing = await fs
    .readFile(MANIFEST_PATH, "utf8")
    .then((raw) => JSON.parse(raw) as Manifest)
    .catch(() => undefined)
  const funderWalletId = existing?.funderUsdWalletId ?? (await funderUsdWalletId())
  const accounts: TargetAccount[] = existing?.accounts ?? []
  const stamp = Date.now().toString().slice(-7)

  for (let i = accounts.length + 1; i <= ACCOUNT_COUNT; i += 1) {
    const suffix = `${stamp}${String(i).padStart(2, "0")}`
    const phone = `+16509${suffix}` as PhoneNumber
    const kratosUserId = randomUUID() as UserId

    const account = throwIfError(
      await Accounts.createAccountWithPhoneIdentifier({
        newAccountInfo: { kratosUserId, phone },
        config,
      }),
    )

    const { usd, usdt } = await listWalletsForAccount(account.id)

    throwIfError(
      await Accounts.updateDefaultWalletId({
        accountId: account.id,
        walletId: usd.id,
      }),
    )

    const fundingCents = i <= 8 ? 25 : i === 9 ? 1 : 0

    accounts.push({
      index: i,
      phone,
      kratosUserId,
      accountId: account.id,
      accountUuid: account.uuid,
      legacyUsdWalletId: usd.id,
      destinationUsdtWalletId: usdt.id,
      startingFundingCents: fundingCents,
    })

    await logProgress(
      `created account ${i}: ${account.id} USD=${usd.id} USDT=${usdt.id} funding=${fundingCents}`,
    )

    await saveManifest({
      cutoverVersion: CUTOVER_VERSION,
      runId: RUN_ID,
      createdAt: existing?.createdAt ?? new Date().toISOString(),
      funderUsdWalletId: funderWalletId,
      accounts,
    })
  }

  const manifest: Manifest = {
    cutoverVersion: CUTOVER_VERSION,
    runId: RUN_ID,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    funderUsdWalletId: funderWalletId,
    accounts,
  }
  await saveManifest(manifest)
  console.log(JSON.stringify(manifest, null, 2))
}

const completePartialAccounts = async () => {
  const manifest = await loadManifest()
  const existingIds = new Set(manifest.accounts.map((account) => account.accountId))
  const partials = await Account.find({
    role: "user",
    defaultWalletId: { $exists: false },
    created_at: { $gte: new Date(Date.now() - 60 * 60 * 1000) },
  }).sort({ created_at: 1 })

  for (const partial of partials) {
    if (manifest.accounts.length >= ACCOUNT_COUNT) break
    const accountId = partial._id.toString()
    if (existingIds.has(accountId)) continue

    const usd = throwIfError(
      await WalletsRepository().persistNew({
        accountId: accountId as AccountId,
        type: WalletType.Checking,
        currency: WalletCurrency.Usd,
      }),
    )
    const usdt = throwIfError(
      await WalletsRepository().persistNew({
        accountId: accountId as AccountId,
        type: WalletType.Checking,
        currency: WalletCurrency.Usdt,
      }),
    )
    throwIfError(
      await Accounts.updateDefaultWalletId({
        accountId: accountId as AccountId,
        walletId: usd.id,
      }),
    )

    const index = manifest.accounts.length + 1
    const fundingCents = index <= 8 ? 25 : index === 9 ? 1 : 0
    manifest.accounts.push({
      index,
      phone: `partial-${index}`,
      kratosUserId: partial.kratosUserId,
      accountId,
      accountUuid: partial.id,
      legacyUsdWalletId: usd.id,
      destinationUsdtWalletId: usdt.id,
      startingFundingCents: fundingCents,
    })
    existingIds.add(accountId)
    await saveManifest(manifest)
    await logProgress(
      `completed partial account ${index}: ${accountId} USD=${usd.id} USDT=${usdt.id} funding=${fundingCents}`,
    )
  }

  console.log(JSON.stringify(manifest, null, 2))
}

const fundAccounts = async () => {
  const manifest = await loadManifest()
  if (!manifest.funderUsdWalletId) {
    manifest.funderUsdWalletId = await funderUsdWalletId()
    await saveManifest(manifest)
  }

  for (const account of manifest.accounts) {
    if (account.startingFundingCents === 0) {
      await logProgress(`left account ${account.index} unfunded`)
      continue
    }

    const status = throwIfError(
      await Payments.intraledgerPaymentSendWalletIdForUsdWallet({
        senderWalletId: manifest.funderUsdWalletId,
        recipientWalletId: account.legacyUsdWalletId,
        amount: account.startingFundingCents,
        memo: `ENG-345 ${RUN_ID} seed ${account.index}`,
      }),
    )

    if (status !== PaymentSendStatus.Success && status !== PaymentSendStatus.Pending) {
      throw new Error(`Funding account ${account.index} returned ${status}`)
    }

    await logProgress(
      `funded account ${account.index} ${account.legacyUsdWalletId} with ${account.startingFundingCents} cents status=${status}`,
    )
  }
}

const scopedAccountsRepo = (targetIds: Set<string>) => ({
  async *listUnlockedAccounts() {
    for (const accountId of targetIds) {
      yield throwIfError(await AccountsRepository().findById(accountId as AccountId))
    }
  },
})

const preview = async () => {
  const manifest = await loadManifest()
  const result = throwIfError(
    await CashWalletCutover.previewPrimaryCashWalletCutover({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      accountsRepo: scopedAccountsRepo(new Set(manifest.accounts.map((a) => a.accountId))),
      walletsRepo: WalletsRepository(),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`preview planned=${result.plannedMigrations.length}`)
}

const prepare = async () => {
  const manifest = await loadManifest()
  const result = throwIfError(
    await CashWalletCutover.preparePrimaryCashWalletCutover({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      accountsRepo: scopedAccountsRepo(new Set(manifest.accounts.map((a) => a.accountId))),
      walletsRepo: WalletsRepository(),
      migrationsRepo: CashWalletCutoverRepository(),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`prepared migrations=${result.migrations.length}`)
}

const start = async () => {
  const manifest = await loadManifest()
  const result = throwIfError(
    await CashWalletCutover.startPrimaryCashWalletCutover({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      actor: "manual-local",
      migrationsRepo: CashWalletCutoverRepository(),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`started state=${result.state}`)
}

const runBatches = async () => {
  const manifest = await loadManifest()
  const batches = []

  for (let i = 1; i <= 40; i += 1) {
    const result = throwIfError(
      await CashWalletCutover.runPrimaryCashWalletCutoverBatch({
        cutoverVersion: manifest.cutoverVersion,
        runId: manifest.runId,
        workerId: "manual-local",
        limit: ACCOUNT_COUNT,
        lockStaleBefore: new Date(Date.now() - 300_000),
        migrationsRepo: CashWalletCutoverRepository(),
      }),
    )
    batches.push(result)
    await logProgress(`batch ${i}: ${JSON.stringify(result)}`)

    const status = throwIfError(
      await CashWalletCutover.getPrimaryCashWalletCutoverStatus({
        cutoverVersion: manifest.cutoverVersion,
        runId: manifest.runId,
        migrationsRepo: CashWalletCutoverRepository(),
      }),
    )

    if (result.failed > 0) {
      console.log(JSON.stringify({ batches, status }, null, 2))
      throw new Error(`Batch ${i} failed`)
    }

    if (Object.keys(status.countsByStatus).length === 1 && status.countsByStatus.complete) {
      console.log(JSON.stringify({ batches, status }, null, 2))
      await logProgress(`all migrations complete after batch ${i}`)
      return
    }

    if (result.attempted === 0) {
      console.log(JSON.stringify({ batches, status }, null, 2))
      throw new Error("No runnable migrations, but run is not complete")
    }
  }

  throw new Error("Exceeded maximum batch count")
}

const complete = async () => {
  const manifest = await loadManifest()
  const result = throwIfError(
    await CashWalletCutover.completePrimaryCashWalletCutover({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      actor: "manual-local",
      migrationsRepo: CashWalletCutoverRepository(),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`completed lifecycle state=${result.state}`)
}

const status = async () => {
  const manifest = await loadManifest()
  const result = throwIfError(
    await CashWalletCutover.getPrimaryCashWalletCutoverStatus({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      migrationsRepo: CashWalletCutoverRepository(),
    }),
  )
  console.log(JSON.stringify(result, null, 2))
}

const resetConfig = async () => {
  const manifest = await loadManifest()
  const result = await CashWalletCutoverConfig.updateOne(
    { _id: "cash_wallet_cutover" },
    {
      $set: {
        state: "pre",
        cutoverVersion: manifest.cutoverVersion,
        runId: manifest.runId,
        updatedBy: "manual-local",
        updatedAt: new Date(),
      },
      $unset: {
        scheduledAt: "",
        startedAt: "",
        completedAt: "",
        pausedAt: "",
        pauseReason: "",
      },
    },
    { upsert: true },
  )
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`reset singleton cutover config to pre for ${manifest.runId}`)
}

const verify = async () => {
  const manifest = await loadManifest()
  const rows = []

  for (const target of manifest.accounts) {
    const account = throwIfError(
      await AccountsRepository().findById(target.accountId as AccountId),
    )
    const usdBalance = throwIfError(
      await getBalanceForWallet({
        walletId: target.legacyUsdWalletId as WalletId,
        currency: WalletCurrency.Usd,
      }),
    )
    const usdtBalance = throwIfError(
      await getBalanceForWallet({
        walletId: target.destinationUsdtWalletId as WalletId,
        currency: WalletCurrency.Usdt,
      }),
    )

    rows.push({
      index: target.index,
      accountId: target.accountId,
      expectedFundingCents: target.startingFundingCents,
      defaultWalletId: account.defaultWalletId,
      defaultIsDestinationUsdt: account.defaultWalletId === target.destinationUsdtWalletId,
      legacyUsdWalletId: target.legacyUsdWalletId,
      destinationUsdtWalletId: target.destinationUsdtWalletId,
      legacyUsdBalanceCents: usdBalance.asCents(),
      destinationUsdtBalanceMicros: usdtBalance.asSmallestUnits(),
    })
  }

  const statusResult = throwIfError(
    await CashWalletCutover.getPrimaryCashWalletCutoverStatus({
      cutoverVersion: manifest.cutoverVersion,
      runId: manifest.runId,
      migrationsRepo: CashWalletCutoverRepository(),
    }),
  )

  const result = { status: statusResult, accounts: rows }
  await fs.writeFile(RESULTS_PATH, `${JSON.stringify(result, null, 2)}\n`)
  console.log(JSON.stringify(result, null, 2))
  await logProgress(`wrote verification results to ${RESULTS_PATH}`)
}

const commands: Record<string, () => Promise<void>> = {
  "create-accounts": createAccounts,
  "complete-partials": completePartialAccounts,
  fund: fundAccounts,
  preview,
  prepare,
  start,
  "run-batches": runBatches,
  complete,
  status,
  "reset-config": resetConfig,
  verify,
}

setupMongoConnection()
  .then(async (mongoose) => {
    const command = process.argv.find((arg) => commands[arg])
    if (!command || !commands[command]) {
      throw new Error(`Expected command: ${Object.keys(commands).join(", ")}`)
    }

    await commands[command]()
    await mongoose?.connection.close()
    process.exit(0)
  })
  .catch(async (error) => {
    await logProgress(`ERROR ${error instanceof Error ? error.message : String(error)}`)
    console.error(error)
    process.exit(1)
  })
