import { GT } from "@graphql/index"

const CashuProof = GT.Object({
  name: "CashuProof",
  description:
    "A Cashu proof locked to a card's public key (NUT-XX Profile B). " +
    "Write to the NFC card via LOAD_PROOF APDU after provisioning.",
  fields: () => ({
    id: {
      type: GT.NonNull(GT.String),
      description: "Keyset ID (hex string, e.g. '0059534ce0bfa19a').",
    },
    amount: {
      type: GT.NonNull(GT.Int),
      description: "Denomination in USD cents.",
    },
    secret: {
      type: GT.NonNull(GT.String),
      description:
        "NUT-10 P2PK secret JSON string. Contains the nonce and the card's public key.",
    },
    C: {
      type: GT.NonNull(GT.String),
      description: "Mint blind signature (compressed secp256k1 point, hex).",
    },
  }),
})

export default CashuProof
