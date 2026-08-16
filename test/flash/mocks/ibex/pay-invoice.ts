/**
 * IBEX `payInvoiceV2` — the 200 body.
 *
 * PROVENANCE: the vendor's documented example, copied verbatim from the
 * generated client's openapi document. NOT a live capture. It happens to
 * populate all three status fields (`status: 1`, `payment.statusId: 1`,
 * `payment.status.id: 1` — IN_FLIGHT), but nothing has confirmed that a real
 * 200 does the same: the pre-#483 intraledger code read the TOP-LEVEL `status`
 * alone and its fixture modelled exactly that. That is why the unreadable case
 * in src/services/ibex/payment-status.ts records at Warn rather than paging.
 * Capture a real 200 on TEST, commit it beside this file, then raise it.
 */
const response = {
  settleAtUtc: 0,
  hash: "",
  status: 1,
  failureReason: 0,
  transaction: {
    id: "",
    createdAt: "2023-07-06T14:51:59.396027Z",
    settledAt: null,
    accountId: "37fe77d13",
    amount: 654333,
    networkFee: 1240,
    onChainSendFee: 0,
    exchangeRateCurrencySats: 0.001,
    currencyId: 0,
    transactionTypeId: 2,
    payment: {
      bolt11: "",
      hash: "",
      preImage: null,
      memo: null,
      amountMsat: 654333,
      feeMsat: 0,
      paidMsat: 654333,
      creationDateUtc: "2023-07-06T14:51:59.389565Z",
      settleDateUtc: null,
      statusId: 1,
      failureId: 0,
      status: {
        id: 1,
        name: "IN_FLIGHT",
        description: null,
      },
    },
  },
}

export { response }
