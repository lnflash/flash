/*
 * This file contains functions to convert Ibex objects to/from corresponding
 * Flash (Galoy) types
 */
import { PaymentSendStatus } from "@domain/bitcoin/lightning"
import { UnexpectedIbexResponse } from "./errors"

// https://docs.ibexmercado.com/reference/get-transaction-details
// Would be nice to have this in the codegen sdk
const OnchainStatus = {
  Initiated: "INITIATED",
  Mempool: "MEMPOOL",
  Blockchain: "BLOCKCHAIN",
  Confirmed: "CONFIRMED",
  Failed: "FAILED",
} as const

const toPaymentSendStatus = (
  ibexStatus: string | undefined,
): PaymentSendStatus | UnexpectedIbexResponse => {
  switch (ibexStatus) {
    case OnchainStatus.Confirmed:
      return PaymentSendStatus.Success
    case OnchainStatus.Initiated:
    case OnchainStatus.Mempool:
    case OnchainStatus.Blockchain:
      return PaymentSendStatus.Pending
    case OnchainStatus.Failed:
      return PaymentSendStatus.Failure
    default:
      return new UnexpectedIbexResponse(
        `Could not parse ibexStatus with value "${ibexStatus}"`,
      )
  }
}

export default { toPaymentSendStatus }