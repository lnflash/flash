import CashoutManager from "@app/offers/CashoutManager"

import { Cashout } from "@config"
import { OfferAlreadyExecuted } from "@domain/cache"
import { JMDAmount, USDAmount, ValidationError } from "@domain/shared"
import ErpNext, { CashoutId } from "@services/frappe/ErpNext"
import { BankAccountQueryError } from "@services/frappe/errors"
import Ibex from "@services/ibex/client"

import { alice } from "../jest.setup"

import * as Mocks from "test/flash/mocks/ibex"

jest.mock("@domain/bitcoin/lightning", () => {
  const actual = jest.requireActual("@domain/bitcoin/lightning")
  return {
    ...actual,
    decodeInvoice: jest.fn(() => ({
      destination: "0".repeat(66) as Pubkey,
      paymentHash:
        "8862fa7f4dcea0533952783bda143ff7fb7242a9573ac74f1ff944a601f02319" as PaymentHash,
      paymentRequest: "lnbc1test" as EncodedPaymentRequest,
      milliSatsAmount: 0 as MilliSatoshis,
      description: "",
      cltvDelta: null,
      amount: null,
      paymentAmount: null,
      routeHints: [],
      paymentSecret: null,
      features: [],
      expiresAt: new Date(Date.now() + 600_000),
      isExpired: false,
    })),
  }
})

const send = USDAmount.cents("100") as USDAmount
const bankAccount = {
  name: "",
  account_name: "Test Account",
  bank: "Test Bank",
  bank_account_no: "000000000",
  branch_code: "000",
  account_type: "Checking",
  currency: "JMD",
}

jest.mock("@services/ibex/client", () => ({
  getAccountDetails: jest.fn(),
  addInvoice: jest.fn(),
  createLnurlPay: jest.fn(),
  createAccount: jest.fn(),
  payInvoice: jest.fn(),
}))
jest.mock("@services/frappe/ErpNext", () => ({
  __esModule: true,
  default: {
    getBankAccountsByCustomer: jest.fn(),
    getCashoutExchangeRate: jest.fn(),
    draftCashout: jest.fn(),
    submitCashout: jest.fn(),
  },
}))
jest.mock("@services/email", () => ({
  EmailService: {
    sendCashoutInitiatedEmail: jest.fn(),
  },
}))

let mockedIbex: jest.Mocked<typeof Ibex>
let mockedErpNext: jest.Mocked<typeof ErpNext>
beforeAll(async () => {
  mockedIbex = Ibex as jest.Mocked<typeof Ibex>
  mockedErpNext = ErpNext as jest.Mocked<typeof ErpNext>
})

beforeEach(async () => {
  mockedIbex.addInvoice.mockResolvedValue(Mocks.addInvoice.response)
  mockedIbex.createLnurlPay.mockResolvedValue({
    lnurl: "lnurl1dp68gurn8ghj7um9dej8xct5v93kzmmfd3skjmn0wvhxcmmv9u",
  })
  mockedIbex.payInvoice.mockResolvedValue(Mocks.payInvoiceV2.response)
  mockedErpNext.getBankAccountsByCustomer.mockResolvedValue([bankAccount])
  mockedErpNext.getCashoutExchangeRate.mockResolvedValue(
    JMDAmount.dollars(160) as JMDAmount,
  )
  mockedErpNext.draftCashout.mockResolvedValue("cashout-test-id" as CashoutId)
  mockedErpNext.submitCashout.mockResolvedValue(true)
})

afterEach(async () => {
  jest.clearAllMocks()
})

describe("Offers", () => {
  it("successfully makes and executes an offer", async () => {
    const offer = await CashoutManager.createOffer(
      alice.usdWalletD.id,
      send,
      "",
      alice.account.id,
    )
    if (offer instanceof Error) throw offer

    const { id } = offer
    const status = await CashoutManager.executeCashout(
      id,
      alice.usdWalletD.id,
      alice.account.id,
    )

    // make assertions against ledger
    expect(status).toBeDefined()
  })

  describe("single use per offerId", () => {
    // dev/config/base-config.yaml sets cashout.skipPayment, which skips the
    // IBEX leg of ValidOffer.execute entirely. Put it back on the path so the
    // payInvoice call count below is evidence of what a duplicate would pay.
    let skipPayment: jest.ReplaceProperty<boolean>
    beforeEach(() => {
      skipPayment = jest.replaceProperty(Cashout, "SkipPayment", false)
    })
    afterEach(() => {
      skipPayment.restore()
    })

    const createOffer = async () => {
      const offer = await CashoutManager.createOffer(
        alice.usdWalletD.id,
        send,
        "",
        alice.account.id,
      )
      if (offer instanceof Error) throw offer
      return offer
    }

    const executeOffer = (id: OfferId) =>
      CashoutManager.executeCashout(id, alice.usdWalletD.id, alice.account.id)

    it("rejects a second execution of the same offer before ERPNext or IBEX", async () => {
      const { id } = await createOffer()

      const first = await executeOffer(id)
      const second = await executeOffer(id)

      // the money-moving side effects ran for the first call only
      expect(mockedErpNext.draftCashout).toHaveBeenCalledTimes(1)
      expect(mockedIbex.payInvoice).toHaveBeenCalledTimes(1)
      expect(first).not.toBeInstanceOf(Error)
      expect(second).toBeInstanceOf(OfferAlreadyExecuted)
    })

    it("lets exactly one of two concurrent executions through", async () => {
      const { id } = await createOffer()

      // Hold both executions inside offer validation, after Storage.get and
      // before the consume gate, until both have arrived. Both callers have
      // then read the offer, so only the atomic consume can stop the second.
      // If a regression stops one execution before validation, the timer lets
      // the other through, so the arrived count fails the test rather than the
      // jest timeout.
      let arrived = 0
      let releaseBoth: () => void = () => undefined
      const bothArrived = new Promise<void>((resolve) => {
        releaseBoth = resolve
      })
      const safetyRelease = setTimeout(() => releaseBoth(), 5_000)
      mockedErpNext.getBankAccountsByCustomer.mockImplementation(async () => {
        arrived += 1
        if (arrived === 2) releaseBoth()
        await bothArrived
        return [bankAccount]
      })

      const results = await Promise.all([executeOffer(id), executeOffer(id)]).finally(
        () => clearTimeout(safetyRelease),
      )

      expect(arrived).toBe(2)
      expect(mockedErpNext.draftCashout).toHaveBeenCalledTimes(1)
      expect(mockedIbex.payInvoice).toHaveBeenCalledTimes(1)
      expect(results.filter((r) => !(r instanceof Error))).toHaveLength(1)
      expect(results.filter((r) => r instanceof OfferAlreadyExecuted)).toHaveLength(1)
    })

    it("keeps an offer whose execution fails validation, so a retry can run it", async () => {
      const { id } = await createOffer()
      mockedErpNext.getBankAccountsByCustomer.mockResolvedValueOnce(
        new BankAccountQueryError("ERPNext unavailable"),
      )

      const failed = await executeOffer(id)
      const retried = await executeOffer(id)

      expect(failed).toBeInstanceOf(ValidationError)
      expect(retried).not.toBeInstanceOf(Error)
      expect(mockedErpNext.draftCashout).toHaveBeenCalledTimes(1)
      expect(mockedIbex.payInvoice).toHaveBeenCalledTimes(1)
    })
  })
})
