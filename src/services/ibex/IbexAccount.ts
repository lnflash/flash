// import Ibex from "./client"
// import { WalletsRepository } from "@services/mongoose"
// import { RepositoryError, UnsupportedCurrencyError } from "@domain/errors"
// import { WalletCurrency } from "@domain/shared"

// // const supportedCurrencies: WalletCurrency[] = [WalletCurrency.Usd]
// // const toWalletCurrency = (currencyId: number): WalletCurrency | UnsupportedCurrencyError => {
// //   if (currencyId === 3) return WalletCurrency.Usd
// //   else return new UnsupportedCurrencyError("Account is not a supported currency.")
// // } 

// class IbexAccount {
//   readonly id: WalletId
//   readonly currency: WalletCurrency

//   private constructor(id: WalletId, currency: WalletCurrency) {
//     this.id = id
//     this.currency = currency
//   }

//   static fromWallet(w: Wallet): IbexAccount {
//     return new IbexAccount(w.id, w.currency)
//   }

//   // If exists, get from local db, else fetch from Ibex
//   static async fromWalletId(id: WalletId): Promise<IbexAccount | IbexClientError> {
//     const w = await WalletsRepository().findById(id)
//     if (w instanceof RepositoryError) return this.fromIbex(id)
//     else return this.fromWallet(w)
//   }

//   private static async fromIbex(id: WalletId): Promise<IbexAccount | IbexClientError> {
//     const resp = await Ibex.getAccountDetails(id)
//     if (resp instanceof IbexClientError) return resp

//     const currency = toWalletCurrency(resp.currencyId as number)
//     if (currency instanceof UnsupportedCurrencyError) return currency

//     return new IbexAccount(id, currency)
//   }
// }

// export default IbexAccount