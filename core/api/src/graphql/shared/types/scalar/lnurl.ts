import { GT } from "@/graphql/index"

const Lnurl = GT.Scalar({
  name: "Lnurl",
  description:
    "A bech32-encoded HTTPS/Onion URL that can be interacted with automatically by a WALLET in a standard way such that a SERVICE can provide extra services or a better experience for the user. Ref: https://github.com/lnurl/luds/blob/luds/01.md ",
})

export default Lnurl
