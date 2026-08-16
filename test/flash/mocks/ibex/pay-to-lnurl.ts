/**
 * IBEX `POST /v2/lnurl/pay/send` — the 201 body.
 *
 * PROVENANCE: this is the vendor's own documented example, copied verbatim from
 * the generated client's openapi document
 * (`ibex-client/dist/.api/apis/sing-in/openapi.json`, operation
 * `pay-to-a-lnurl-pay`, response 201, example "Result"). It is NOT a live
 * capture — no real payToLnurl response has been observed on TEST yet — and it
 * is committed precisely so the readers are asserted against the only evidence
 * that exists rather than against a shape we imagined.
 *
 * Read it carefully before treating any field as settlement:
 *   - top-level `settleDateUtc: 1668544241` is 2022-11-15T20:30:41Z, i.e.
 *     `transaction.createdAt` ("2022-11-15T20:30:41.960887Z") floored to the
 *     second — a creation-time echo, not a settlement stamp;
 *   - meanwhile `payment.statusId` is 0, `payment.settleDateUtc` is null,
 *     `paidMsat` is 0 and `payment.hash` is null: nothing has settled.
 * `Ibex.payToLnurl` also registers an async settlement webhook, so the 201 is
 * an acceptance. `paymentSendStatusFromIbexLnurlPay` must therefore report this
 * body as unconfirmed (→ pending), never as success.
 *
 * When a real 201 is captured on TEST, commit it beside this file rather than
 * overwriting it, and revisit both the settle-date rule and the Warn severity
 * in src/services/ibex/payment-status.ts.
 */
const response = {
  settleDateUtc: 1668544241,
  amountMsat: 1000,
  feesMsat: 0,
  hash: "19b7ff42e048d14791180d63592099b3394fc9ea7e3243906e810362124c29fd",
  transaction: {
    id: "dfeec8bd-b4e7-46f1-aa4a-cf4e4569df02",
    createdAt: "2022-11-15T20:30:41.960887Z",
    accountId: "eeba6152-9432-448e-b7d2-4205e5099924",
    amount: 0.00325496699508991,
    networkFee: 0,
    exchangeRateCurrencySats: 307.53,
    currencyId: 5,
    transactionTypeId: 2,
    payment: {
      bolt11: "",
      hash: null,
      preImage: null,
      memo: null,
      amountMsat: 1000,
      feeMsat: 0,
      paidMsat: 0,
      creationDateUtc: "0001-01-01T00:00:00Z",
      settleDateUtc: null,
      statusId: 0,
      failureId: null,
    },
  },
}

export { response }
