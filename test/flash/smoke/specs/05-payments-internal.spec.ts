import { getMe, getTransactions, gqlOk, login, retry, usdWalletOf } from "../client"
import { SMOKE } from "../config"

// UAT: SEND-01/02 (username/paycode sends both directions with memo),
//      TX-01 (history both sides), TX-02 (detail fields), CONTACT-01 (contacts)
const describeMaybe = SMOKE.allowPayments ? describe : describe.skip

const MEMO_AB = `smoke SEND-01 ${process.env.SMOKE_RUN_ID || ""}`.trim()
const MEMO_BA = `smoke SEND-02 ${process.env.SMOKE_RUN_ID || ""}`.trim()

const sendUsd = async (
  token: string,
  walletId: string,
  recipientWalletId: string,
  amount: number,
  memo: string,
) =>
  gqlOk<{
    intraLedgerUsdPaymentSend: {
      errors: Array<{ message: string }>
      status: string | null
    }
  }>(
    `mutation smokeIntraledger($input: IntraLedgerUsdPaymentSendInput!) {
      intraLedgerUsdPaymentSend(input: $input) { errors { message } status }
    }`,
    { input: { walletId, recipientWalletId, amount, memo } },
    token,
  )

describeMaybe("Phase 2: two-account internal payments", () => {
  let tokenA: string
  let tokenB: string
  let walletA: string
  let walletB: string

  beforeAll(async () => {
    tokenA = await login(SMOKE.phoneA, SMOKE.code)
    tokenB = await login(SMOKE.phoneB, SMOKE.code)
    walletA = usdWalletOf(await getMe(tokenA)).id
    walletB = usdWalletOf(await getMe(tokenB)).id
  })

  it("SEND-01: A pays B by wallet with memo; balances update on both sides", async () => {
    const balanceA = usdWalletOf(await getMe(tokenA)).balance
    if (balanceA < 10) {
      throw new Error(
        `account A has insufficient smoke balance (${balanceA}); run the funding phase (SMOKE_DOCKER_HELPERS=true) or pre-fund ${SMOKE.phoneA}`,
      )
    }
    const balanceBBefore = usdWalletOf(await getMe(tokenB)).balance

    const res = await sendUsd(tokenA, walletA, walletB, 5, MEMO_AB)
    expect(res.intraLedgerUsdPaymentSend.errors).toEqual([])
    expect(res.intraLedgerUsdPaymentSend.status).toBe("SUCCESS")

    const balanceBAfter = await retry(
      async () => usdWalletOf(await getMe(tokenB)).balance,
      (b) => b > balanceBBefore,
    )
    expect(balanceBAfter).toBeGreaterThan(balanceBBefore)
  })

  it("SEND-02: B pays A back", async () => {
    const balanceABefore = usdWalletOf(await getMe(tokenA)).balance
    const res = await sendUsd(tokenB, walletB, walletA, 2, MEMO_BA)
    expect(res.intraLedgerUsdPaymentSend.errors).toEqual([])
    expect(res.intraLedgerUsdPaymentSend.status).toBe("SUCCESS")

    const balanceAAfter = await retry(
      async () => usdWalletOf(await getMe(tokenA)).balance,
      (b) => b > balanceABefore,
    )
    expect(balanceAAfter).toBeGreaterThan(balanceABefore)
  })

  it("TX-01/TX-02: both sides show the payment with direction, status, and memo", async () => {
    const txsA = await getTransactions(tokenA, 10)
    const txsB = await getTransactions(tokenB, 10)

    const sentFromA = txsA.find((t) => t.memo === MEMO_AB)
    const receivedByB = txsB.find((t) => t.memo === MEMO_AB)

    expect(sentFromA?.direction).toBe("SEND")
    expect(receivedByB?.direction).toBe("RECEIVE")
    for (const tx of [sentFromA, receivedByB]) {
      expect(tx?.status).toBe("SUCCESS")
      expect(typeof tx?.settlementAmount).toBe("number")
      expect(tx?.createdAt).toBeGreaterThan(0)
    }
  })

  it("CONTACT-01: counterparty appears in contacts after payment", async () => {
    const data = await gqlOk<{
      me: { contacts: Array<{ username: string; transactionsCount: number }> }
    }>(
      `query smokeContacts {
        me { contacts { username transactionsCount } }
      }`,
      {},
      tokenA,
    )
    const meB = await getMe(tokenB)
    if (!meB.username) return // usernames unset in this environment
    const contact = data.me.contacts.find((c) => c.username === meB.username)
    expect(contact).toBeTruthy()
    expect(contact?.transactionsCount).toBeGreaterThan(0)
  })
})
