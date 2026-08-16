/**
 * A REAL IBEX response, not an openapi example.
 *
 * Captured 2026-08-16 from the sandbox hub (which settles on mainnet):
 *   GET https://ibexhub-api.sandbox.poweredbyibex.io
 *       /v2/transaction/3ba8081c-0e69-4218-9219-84486042fa5b
 * — a settled Lightning send (transactionTypeId 2) from the TEST cash wallet.
 * Amounts and identifiers are as returned; the bolt11/preimage are from a
 * sandbox transaction of ~$1.10 that has already settled.
 *
 * Why it is here: every other status assertion in this module was derived from
 * the generated openapi *examples*, which are illustrative. This capture is the
 * evidence for three things the readers depend on:
 *
 *  1. A real settled payment populates BOTH payment-level status fields —
 *     `payment.statusId: 2` and `payment.status.id: 2` (name "SUCCEEDED") — so
 *     the payment-level precedence in paymentSendStatusFromIbex is reading
 *     fields IBEX actually fills, and the "no recognised status" case is a
 *     genuine anomaly rather than this vendor's normal shape.
 *  2. `payment.failureId` is 0 on success, confirming 0 = "no failure" for the
 *     corroboration rule.
 *  3. `payment.settleDateUtc` arrives as an ISO STRING
 *     ("2026-08-15T05:33:17.554653Z"), not the integer epoch the payToLnurl
 *     example declares — which is why hasSettleDate must accept both forms.
 *
 * Note the transaction-level `status` here is the STRING "completed", a
 * different field from the integer `status` on the payInvoiceV2 send response.
 * Do not feed this whole object to a status reader as if it were one.
 */
export const capturedSettledLightningSend = {
  id: "3ba8081c-0e69-4218-9219-84486042fa5b",
  createdAt: "2026-08-15T05:33:12.081277Z",
  settledAt: "2026-08-15T05:33:17.600375Z",
  accountId: "e0eee682-2631-4081-a51e-9ebcada3b24b",
  amount: 1.10237620493,
  networkFee: 0.001423690928,
  onChainSendFee: 0,
  exchangeRateCurrencySats: 1574.78,
  currencyId: 29,
  transactionTypeId: 2,
  status: "completed",
  payment: {
    bolt11:
      "lnbc17350n1p48l7sspp5nccxp9x373c9lum267m0mms9w2v72974w2c59hcdyakausn5yxxshp5t4z8k9lpmw54z30pvn8eqyufkseznkydu3ggwvalpftg35vwn0jscqzzsxqzp6sp5ufxzxky24ffd4dwqzgazral8jf7370nhr8lxh9p5pxy47kwzfztq9qxpqysgqkmmd2qp7vs4led2rtep58hw4smk22k9lq9jmyhv76mvan3v9stf5h7qh8rh9cm2tzeqt7s2dq3z7alxz2v5l5587fpq0g3k8sgnnvwgq5udlk4",
    hash: "9e306094d1f4705ff36ad7b6fdee057299e517d572b142df0d276dde4274218d",
    preImage: "83120d0a91461bc5cdad08aaa0b72d42e6ded08bf8ffdfc00fa2247dcc0a5709",
    memo: null,
    amountMsat: 1735000,
    feeMsat: 2242,
    paidMsat: 1735000,
    creationDateUtc: "2026-08-15T05:33:12.073746Z",
    settleDateUtc: "2026-08-15T05:33:17.554653Z",
    statusId: 2,
    failureId: 0,
    status: { id: 2, name: "SUCCEEDED", description: null },
  },
} as const
