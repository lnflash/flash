/**
 * Flash E2E Seed Script — MongoDB Direct
 *
 * Bypasses the app layer (which calls Ibex API) and writes documents directly.
 * Safe to run multiple times — uses upsert on all writes.
 *
 * Usage:
 *   yarn ts-node --files --project tsconfig.json -r tsconfig-paths/register \
 *     dev/seed/seed-e2e.ts --configPath ./dev/config/base-config.yaml
 *
 * Outputs /tmp/e2e-users.json with phones/walletIds for Maestro flows.
 *
 * Test phones (OTP bypass 000000 — local dev + api.test.flashapp.me only):
 *   +15550000001  e2e-alice
 *   +15550000002  e2e-bob
 *   +15550000003  e2e-carol
 */

import mongoose from "mongoose"
import { setupMongoConnection } from "@services/mongodb"
import { disconnectAll } from "@services/redis"
import { Account, Wallet, User } from "@services/mongoose/schema"
import fs from "fs"

// ── Deterministic test identities ─────────────────────────────────────────────
const E2E_USERS = [
  { name: "e2e-alice", phone: "+15550000001", kratosUserId: "00000000-0000-4000-a000-000000000001" },
  { name: "e2e-bob",   phone: "+15550000002", kratosUserId: "00000000-0000-4000-a000-000000000002" },
  { name: "e2e-carol", phone: "+15550000003", kratosUserId: "00000000-0000-4000-a000-000000000003" },
]

// Bankowner from base config
const ADMIN_USERS = [
  { name: "admin-bankowner", phone: "+16505554334", kratosUserId: "00000000-0000-4000-b000-000000000001", role: "bankowner" },
]

async function upsertUser(phone: string, kratosUserId: string, deviceToken: string) {
  // Users collection stores phone → kratosUserId mapping
  const existing = await User.findOne({ phone })
  if (existing) {
    return existing.userId as string
  }
  // Try by userId field
  const byId = await User.findOne({ userId: kratosUserId })
  if (byId) {
    return byId.userId as string
  }
  const doc = new User({
    userId: kratosUserId,
    phone,
    deviceTokens: [deviceToken],
    language: "",
    createdAt: new Date(),
  })
  await doc.save()
  return kratosUserId
}

async function upsertAccount(kratosUserId: string, role = "user") {
  const existing = await Account.findOne({ kratosUserId })
  if (existing) {
    return existing
  }
  // Use kratosUserId as account id — deterministic UUID, stable across reseeds
  const doc = new Account({
    kratosUserId,
    id: kratosUserId,
    role,
    level: 1,
    status: "active",
    earn: [],
    created_at: new Date(),
  })
  await doc.save()
  return doc
}

async function upsertWallet(accountId: string, accountObjectId: mongoose.Types.ObjectId, currency: string, walletId: string) {
  const existing = await Wallet.findOne({ id: walletId })
  if (existing) return existing

  const doc = new Wallet({
    id: walletId,
    _accountId: accountObjectId,
    type: "checking",
    currency,
    onchain: [],
    lnurlp: undefined,
  })
  await doc.save()
  return doc
}

async function seedUser({ name, phone, kratosUserId, role = "user" }: { name: string; phone: string; kratosUserId: string; role?: string }) {
  console.log(`\n  Seeding ${name} (${phone})...`)

  // 1. User record
  await upsertUser(phone, kratosUserId, `e2e-token-${name}`)
  console.log(`    ✅ user record`)

  // 2. Account record
  const account = await upsertAccount(kratosUserId, role)
  const accountObjectId = account._id as mongoose.Types.ObjectId
  console.log(`    ✅ account  id=${account.id}`)

  // 3. Wallets (USD primary, BTC secondary)
  // Use deterministic wallet IDs derived from kratosUserId
  const usdWalletId = `${kratosUserId.slice(-12)}-usd`
  const btcWalletId = `${kratosUserId.slice(-12)}-btc`

  await upsertWallet(account.id, accountObjectId, "USD", usdWalletId)
  await upsertWallet(account.id, accountObjectId, "BTC", btcWalletId)
  console.log(`    ✅ wallets  USD=${usdWalletId} BTC=${btcWalletId}`)

  // 4. Set defaultWalletId if not set
  if (!account.defaultWalletId) {
    await Account.updateOne({ kratosUserId }, { $set: { defaultWalletId: usdWalletId } })
    console.log(`    ✅ default wallet set to USD`)
  }

  return {
    name,
    phone,
    kratosUserId,
    accountId: account.id,
    wallets: [
      { id: usdWalletId, currency: "USD", isDefault: true },
      { id: btcWalletId, currency: "BTC", isDefault: false },
    ],
  }
}

async function main() {
  console.log("🌱 Flash E2E Seed (MongoDB Direct)")
  console.log("====================================")

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let conn: any
  try {
    conn = await setupMongoConnection(true)
    console.log("✅ MongoDB connected")
  } catch (e) {
    console.error("❌ MongoDB failed:", (e as Error).message)
    console.error("   Start: docker compose up -d mongodb redis")
    process.exit(1)
  }

  const output: { seededAt: string; users: Record<string, unknown> } = {
    seededAt: new Date().toISOString(),
    users: {},
  }

  console.log("\n── Admin users ──")
  for (const u of ADMIN_USERS) {
    try {
      const r = await seedUser(u)
      output.users[r.name] = r
    } catch (e) {
      console.log(`  ⚠️  ${u.name}: ${(e as Error).message}`)
    }
  }

  console.log("\n── E2E test users ──")
  for (const u of E2E_USERS) {
    const r = await seedUser(u)
    output.users[r.name] = r
  }

  const outPath = process.env.E2E_SEED_OUTPUT || "/tmp/e2e-users.json"
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2))

  console.log(`\n✅ Seed complete → ${outPath}`)
  console.log("\n── Summary ──")
  for (const [, user] of Object.entries(output.users)) {
    const u = user as { name: string; phone: string; wallets: Array<{ currency: string; id: string }> }
    const usd = u.wallets.find((w) => w.currency === "USD")
    console.log(`  ${u.name}: ${u.phone} | USD wallet: ${usd?.id}`)
  }
  console.log("\n  OTP bypass: 000000 (local dev + api.test.flashapp.me only)")

  disconnectAll()
  if (conn) await conn.connection.close()
}

main().catch((e) => {
  console.error("❌ Seed failed:", e)
  process.exit(1)
})
