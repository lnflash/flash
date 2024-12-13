import { toWalletTransactions } from "@app/wallets"

const ibex_data = [
  {
    "id": "f2fa0473-43b4-4101-8e19-11f1caaeb011",
    "createdAt": "2024-01-31T17:27:20.718984Z",
    "settledAt": "2024-01-31T17:27:21.422794Z",
    "accountId": "e24b85d1-9f61-47da-acb9-fe9d069de2fc",
    "amount": 0.045584045584,
    "networkFee": 0.000898969976,
    "onChainSendFee": 0,
    "exchangeRateCurrencySats": 2281.5,
    "currencyId": 3,
    "transactionTypeId": 2
  },
  {
    "id": "d3a61722-c212-4232-9af0-6c6360ee3ad9",
    "createdAt": "2024-01-31T17:24:23.446563Z",
    "settledAt": "2024-01-31T17:24:44.423267Z",
    "accountId": "e24b85d1-9f61-47da-acb9-fe9d069de2fc",
    "amount": 0.100425509811,
    "networkFee": 0,
    "onChainSendFee": 0,
    "exchangeRateCurrencySats": 2310.17,
    "currencyId": 3,
    "transactionTypeId": 1
  }
]

describe("Test transformation of IbexResponse to WalletTransaction[]", () => {
    it("should set the settlementAmount to negative on send", async () => {
        const result: WalletTransaction[] = toWalletTransactions(ibex_data)

        expect(result[0].settlementAmount).toEqual(-0.045584045584)
        expect(result[1].settlementAmount).toEqual(0.100425509811)
    })
})