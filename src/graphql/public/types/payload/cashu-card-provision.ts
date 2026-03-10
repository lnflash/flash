import { GT } from "@graphql/index"

import IError from "@graphql/shared/types/abstract/error"
import CashuProof from "@graphql/public/types/object/cashu-proof"

const CashuCardProvisionPayload = GT.Object({
  name: "CashuCardProvisionPayload",
  fields: () => ({
    errors: {
      type: GT.NonNullList(IError),
    },
    proofs: {
      type: GT.List(GT.NonNull(CashuProof)),
      description:
        "Signed Cashu proofs ready to be written to the NFC card via LOAD_PROOF APDUs.",
    },
    cardPubkey: {
      type: GT.String,
      description: "The card's public key (hex), echoed back for verification.",
    },
    totalAmountCents: {
      type: GT.Int,
      description: "Total amount loaded onto the card, in USD cents.",
    },
  }),
})

export default CashuCardProvisionPayload
