// import BaseAPI from "./baseAPI"

// // Define the response shapes
// interface GenerateBitcoinAddressResponse {
//   address: string
// }

// interface SendToAddressResponse {
//   transactionId: string
//   amountSat: number
//   feeSat: number
//   status: string
// }

// interface GetTransactionDetailsResponse {
//   transactionId: string
//   amountSat: number
//   feeSat: number
//   destAddress: string
//   status: string
//   networkTxId: string
//   blockHeight: number
//   blockConfirmations: number
// }

// interface EstimateFeeResponse {
//   feeSat: number
// }

// class WalletAPI extends BaseAPI {
//   async generateBitcoinAddress(
//     accountId: string,
//   ): Promise<GenerateBitcoinAddressResponse> {
//     try {
//       const { data }: { data: GenerateBitcoinAddressResponse } =
//         await this.sdk.generateBitcoinAddress({ accountId })
//       return data
//     } catch (err) {
//       console.error(err)
//       throw err // re-throw the error so it can be caught and handled by GraphQL
//     }
//   }

//   async sendToAddress(params: {
//     accountId: string
//     address: string
//     amountSat: number
//     feeSat: number
//     webhookUrl: string
//     webhookSecret: string
//   }): Promise<SendToAddressResponse> {
//     try {
//       const { data }: { data: SendToAddressResponse } = await this.sdk.sendToAddress(
//         params,
//       )
//       return data
//     } catch (err) {
//       console.error(err)
//       throw err // re-throw the error so it can be caught and handled by GraphQL
//     }
//   }

//   async getTransactionDetails(txid: string): Promise<GetTransactionDetailsResponse> {
//     try {
//       const { data }: { data: GetTransactionDetailsResponse } =
//         await this.sdk.getTransactionDetails({ txid })
//       return data
//     } catch (err) {
//       console.error(err)
//       throw err // re-throw the error so it can be caught and handled by GraphQL
//     }
//   }

//   async estimateFee(params: {
//     dest_address: string
//     amount_sat: number
//   }): Promise<EstimateFeeResponse> {
//     try {
//       const { data }: { data: EstimateFeeResponse } = await this.sdk.estimateFee(params)
//       return data
//     } catch (err) {
//       console.error(err)
//       throw err // re-throw the error so it can be caught and handled by GraphQL
//     }
//   }
// }

// export default WalletAPI
