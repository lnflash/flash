import dedent from "dedent"

import { GT } from "@graphql/index"
import WalletId from "@graphql/shared/types/scalar/wallet-id"
import CashuCardProvisionPayload from "@graphql/public/types/payload/cashu-card-provision"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import { Cashu } from "@app"

const CashuCardProvisionInput = GT.Input({
  name: "CashuCardProvisionInput",
  fields: () => ({
    walletId: {
      type: GT.NonNull(WalletId),
      description: "USD wallet ID to fund the card from.",
    },
    amountCents: {
      type: GT.NonNull(GT.Int),
      description: "Total amount to load onto the card, in USD cents.",
    },
    cardPubkey: {
      type: GT.NonNull(GT.String),
      description:
        "The card's compressed secp256k1 public key (33 bytes, 66 hex chars). " +
        "Obtained from the NFC card via GET_PUBKEY APDU (INS: 0x10).",
    },
  }),
})

const CashuCardProvisionMutation = GT.Field({
  extensions: {
    complexity: 120,
  },
  type: GT.NonNull(CashuCardProvisionPayload),
  description: dedent`
    Provisions a Cashu NFC card with ecash proofs (NUT-XX Profile B).

    Flow:
    1. Tap card to read its public key (GET_PUBKEY APDU)
    2. Call this mutation with the card pubkey, wallet ID, and amount
    3. The backend pays the Cashu mint from your USD wallet balance
    4. Returns signed Cashu proofs locked to the card's key
    5. Write each proof to the card via LOAD_PROOF APDUs

    The card can then be used for offline payments. Merchant redeems proofs
    online by presenting them to the mint with the card's Schnorr signature.
  `,
  args: {
    input: { type: GT.NonNull(CashuCardProvisionInput) },
  },
  resolve: async (_, args, { domainAccount }: { domainAccount: Account }) => {
    const { walletId, amountCents, cardPubkey } = args.input

    for (const input of [walletId, amountCents, cardPubkey]) {
      if (input instanceof Error) {
        return { errors: [{ message: input.message }] }
      }
    }

    if (typeof amountCents !== "number" || amountCents <= 0) {
      return { errors: [{ message: "amountCents must be a positive integer" }] }
    }

    if (typeof cardPubkey !== "string" || cardPubkey.length !== 66) {
      return {
        errors: [{ message: "cardPubkey must be 66 hex characters (33 bytes compressed)" }],
      }
    }

    const result = await Cashu.provisionCashuCard({
      walletId,
      accountId: domainAccount.id,
      amountCents,
      cardPubkey,
    })

    if (result instanceof Error) {
      return { errors: [mapAndParseErrorForGqlResponse(result)] }
    }

    return {
      errors: [],
      proofs: result.proofs,
      cardPubkey: result.cardPubkey,
      totalAmountCents: result.totalAmount,
    }
  },
})

export default CashuCardProvisionMutation
