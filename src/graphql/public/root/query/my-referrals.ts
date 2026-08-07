import { GT } from "@graphql/index"
import { mapAndParseErrorForGqlResponse } from "@graphql/error-map"
import {
  InviteMethodEnum,
  InviteStatusEnum,
} from "@graphql/public/root/mutation/create-invite"
import { getMyReferralStats, listInvites } from "@app/invite"
import { InviteStatus } from "@services/mongoose/models/invite"

const DEFAULT_PAGE = 20
const MAX_PAGE = 100

const MyReferralInviteType = GT.Object({
  name: "MyReferralInvite",
  fields: () => ({
    id: { type: GT.NonNull(GT.ID) },
    contact: { type: GT.NonNull(GT.String) },
    method: { type: GT.NonNull(InviteMethodEnum) },
    status: { type: GT.NonNull(InviteStatusEnum) },
    createdAt: { type: GT.NonNull(GT.String) },
    redeemedAt: { type: GT.String },
    // The caller's (inviter's) reward for this referral, in USD cents — set
    // only once their leg of the payout has gone out. The invitee's leg is
    // deliberately not exposed here.
    myRewardCents: { type: GT.Int },
    // Redeemed but the caller's reward hasn't paid yet (awaiting the
    // invitee's KYC approval — or an internal retry; the distinction is ops',
    // not the user's).
    rewardPending: { type: GT.NonNull(GT.Boolean) },
  }),
})

const MyReferralsType = GT.Object({
  name: "MyReferrals",
  fields: () => ({
    totalInvites: { type: GT.NonNull(GT.Int) },
    acceptedCount: { type: GT.NonNull(GT.Int) },
    totalEarnedCents: { type: GT.NonNull(GT.Int) },
    pendingRewardCount: { type: GT.NonNull(GT.Int) },
    invites: { type: GT.NonNullList(MyReferralInviteType) },
  }),
})

const toIso = (d: unknown): string | null =>
  d instanceof Date ? d.toISOString() : d ? String(d) : null

const MyReferralsQuery = GT.Field({
  type: GT.NonNull(MyReferralsType),
  args: {
    first: { type: GT.Int },
    // _id cursor: invites strictly older than this id (newest-first pages).
    afterId: { type: GT.ID },
  },
  resolve: async (
    _,
    args: { first?: number; afterId?: string },
    { domainAccount }: GraphQLPublicContextAuth,
  ) => {
    const first = Math.min(Math.max(args.first ?? DEFAULT_PAGE, 1), MAX_PAGE)

    // Independent reads — run them together; a screen load pays one latency.
    const [stats, page] = await Promise.all([
      getMyReferralStats(domainAccount.id),
      listInvites({
        first,
        afterId: args.afterId,
        inviterId: domainAccount.id,
      }),
    ])
    if (stats instanceof Error) {
      throw mapAndParseErrorForGqlResponse(stats)
    }
    if (page instanceof Error) {
      throw mapAndParseErrorForGqlResponse(page)
    }

    return {
      ...stats,
      invites: page.data.map(
        (inv: {
          id: string
          contact: string
          method: string
          status: string
          createdAt?: Date
          redeemedAt?: Date
          rewardStatus?: string
          rewardAmountCents?: number
          inviterRewardedAt?: Date
        }) => ({
          id: inv.id,
          contact: inv.contact,
          method: inv.method,
          status: inv.status,
          createdAt: toIso(inv.createdAt),
          redeemedAt: toIso(inv.redeemedAt),
          myRewardCents: inv.inviterRewardedAt ? (inv.rewardAmountCents ?? null) : null,
          // A zero-tier claim terminates as rewardStatus "paid" with 0 cents
          // and no inviterRewardedAt — done, never "pending" (a capped promo
          // schedule produces exactly this state for every referral past its
          // last tier).
          rewardPending:
            inv.status === InviteStatus.ACCEPTED &&
            !inv.inviterRewardedAt &&
            inv.rewardStatus !== "paid",
        }),
      ),
    }
  },
})

export default MyReferralsQuery
