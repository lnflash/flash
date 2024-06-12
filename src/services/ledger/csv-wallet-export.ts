import { getTransactionsForWallets } from "@app/wallets"
import { txDirectionValues } from "@graphql/shared/types/scalar/tx-direction"
import { baseLogger } from "@services/logger"
import { createObjectCsvStringifier, createObjectCsvWriter } from "csv-writer"

const header = [
  { id: "id", title: "Id" },
  { id: "walletId", title: " Wallet Id" },
  { id: "type", title: " Type" },
  { id: "direction", title: " Direction" },
  { id: "amount", title: " Amount" },
  { id: "displayAmount", title: " Display Amount" },
  { id: "fee", title: " Fee" },
  { id: "displayFee", title: " Display Fee" },
  { id: "currency", title: " Currency" },
  { id: "timestamp", title: " Timestamp" },
  { id: "status", title: " Status" },
  { id: "memo", title: " Memo" },
]

export class CsvWalletsExport {
  entries: LedgerTransaction<WalletCurrency>[] = []

  getBase64(): string {
    const csvWriter = createObjectCsvStringifier({
      header,
    })

    const header_stringify = csvWriter.getHeaderString()
    const records = csvWriter.stringifyRecords(this.entries)

    const str = header_stringify + records

    // create buffer from string
    const binaryData = Buffer.from(str, "utf8")

    // decode buffer as base64
    const base64Data = binaryData.toString("base64")

    return base64Data
  }

  async saveToDisk(): Promise<void> {
    const csvWriter = createObjectCsvWriter({
      path: "export_accounts.csv",
      header,
    })

    await csvWriter.writeRecords(this.entries)
    baseLogger.info("saving complete")
  }

  async addWallets(wallets: Wallet[]): Promise<void | ApplicationError> {
    // TODO: interface could be improved by returning self, so that it's
    // possible to run csv.addWallet(wallet).getBase64()

    const response = await getTransactionsForWallets({
      wallets,
    })

    const txs = await this.formatTxs(response.result?.slice)

    if (!(txs instanceof Error)) {
      // @ts-ignore-next-line no-implicit-any error
      this.entries.push(...txs)
    }
  }

  async formatTxs(txs?: WalletTransaction[]) {
    const result = txs?.map((el) => {
      return {
        id: el.id,
        walletId: el.walletId,
        type: el.initiationVia.type,
        direction:
          el.settlementAmount > 0 ? txDirectionValues.RECEIVE : txDirectionValues.SEND,
        amount: el.settlementAmount,
        displayAmount: el.settlementDisplayAmount,
        fee: el.settlementFee,
        displayFee: el.settlementDisplayFee,
        currency: el.settlementCurrency,
        timestamp: el.createdAt,
        status: el.status, // status
        memo: el.memo,
      }
    })

    return result
  }
}
