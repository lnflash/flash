// For bugs involving onchain transactions:
// 1. Check Honeycomb for full responses from Ibex service
// 2. Copy response here and use test case
  
// sample 200 response from Ibex().sendToAddressV2
// consider moving data to a .json
const response = {
  transactionHub: {
    id: "abcd-1234",
    createdAt: "2023-08-04T08:33:31.869852Z",
    settledAt: null,
    accountId: "",
    amount: 5600000,
    networkFee: 2870000,
    onChainSendFee: 0,
    exchangeRateCurrencySats: 0.001,
    currencyId: 0,
    transactionTypeId: 4,
  },
  amountSat: 5600,
  feeSat: 0,
  status: "INITIATED",
}

// Sample webhook request body
const webhookReq = {
  amountSat: 5600,
  feeSat: 0,
  status: "MEMPOOL",
  networkTransactionId: "",
  blockConfirmations: 0,
  webhookSecret: "Kramerica",
  destinationAddress: "bc1q..",
  transaction: {
    id: "",
    createdAt: "2023-08-04T08:33:31.869852Z",
    settledAt: null,
    accountId: "",
    amount: 5600000,
    networkFee: 2870000,
    onChainSendFee: 0,
    exchangeRateCurrencySats: 0.001,
    currencyId: 0,
    transactionTypeId: 4,
  },
}

export default { response, webhookReq }
