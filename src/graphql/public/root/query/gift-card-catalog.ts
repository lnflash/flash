import { listGiftCardProducts } from "@app/gift-cards"
import { encodeGiftCardProductCursor } from "@domain/gift-cards"
import { InputValidationError } from "@graphql/error"
import { mapError } from "@graphql/error-map"
import { GT } from "@graphql/index"
import { gateGiftCardsForAccount } from "@graphql/public/root/gift-card-gate"
import { GiftCardProductConnection } from "@graphql/public/types/object/gift-card-product"
import CountryCode from "@graphql/public/types/scalar/country-code"

type GiftCardCatalogArgs = {
  countryCode?: string | InputValidationError | null
  category?: string | null
  search?: string | null
  first?: number | null
  after?: string | null
}

const GiftCardCatalogQuery = GT.Field<
  null,
  GraphQLPublicContextAuth,
  GiftCardCatalogArgs
>({
  type: GT.NonNull(GiftCardProductConnection),
  description:
    "The gift cards on sale for a country, in stock only, ordered by brand then name. " +
    "Served from a cached catalog: a card can be listed and then refused by " +
    "giftCardQuote if it sold out in between. Paginate forwards with `first`/`after`.",
  args: {
    countryCode: {
      type: CountryCode,
      description:
        "Which country's catalog. Defaults to the calling account's country, which is " +
        "also the country the purchase will be routed by — browse another country's " +
        "catalog and the purchase of a card from it is refused as not available.",
    },
    category: {
      type: GT.String,
      description: "Keep only cards carrying this category label (case-insensitive).",
    },
    search: {
      type: GT.String,
      description:
        "Keep only cards whose name or brand contains this text (case-insensitive).",
    },
    first: {
      type: GT.Int,
      description: "Page size, 1 to 200. Defaults to 50.",
    },
    after: {
      type: GT.String,
      description:
        "The `endCursor` (or any edge cursor) from the previous page. An unknown cursor " +
        "restarts from the beginning rather than guessing; the client may see a repeat, " +
        "never a gap.",
    },
  },
  resolve: async (_, args, { domainAccount }) => {
    // CountryCode hands back an InputValidationError for a malformed code — an
    // Apollo error already, so it is thrown as-is rather than mapped.
    if (args.countryCode instanceof Error) throw args.countryCode
    if (typeof args.first === "number" && args.first < 1) {
      throw new InputValidationError({
        message: 'Argument "first" must be greater than 0',
      })
    }

    const gate = await gateGiftCardsForAccount({
      account: domainAccount,
      countryCode: args.countryCode ?? undefined,
    })
    if (!gate.ok) throw mapError(gate.error)

    const page = await listGiftCardProducts({
      countryCode: gate.countryCode,
      category: args.category ?? undefined,
      search: args.search ?? undefined,
      first: args.first ?? undefined,
      after: args.after ?? undefined,
    })
    if (page instanceof Error) throw mapError(page)

    const edges = page.products.map((product) => ({
      node: product,
      cursor: encodeGiftCardProductCursor(product.id),
    }))
    return {
      edges,
      pageInfo: {
        hasNextPage: page.hasNextPage,
        // Forward-only pagination; the relay contract lets hasPreviousPage be
        // false when paginating forwards (same as connectionFromPaginatedArray).
        hasPreviousPage: false,
        startCursor: edges.length > 0 ? edges[0].cursor : null,
        endCursor: page.endCursor,
      },
    }
  },
})

export default GiftCardCatalogQuery
