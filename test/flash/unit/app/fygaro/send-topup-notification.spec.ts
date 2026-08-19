import { DeviceTokensNotRegisteredNotificationsServiceError } from "@domain/notifications"

const mockFindAccountById = jest.fn()
const mockFindUserById = jest.fn()
const mockSendFiltered = jest.fn()
const mockRemoveDeviceTokens = jest.fn()

jest.mock("@services/mongoose/accounts", () => ({
  AccountsRepository: () => ({
    findById: (...a: unknown[]) => mockFindAccountById(...a),
  }),
}))
jest.mock("@services/mongoose/users", () => ({
  UsersRepository: () => ({ findById: (...a: unknown[]) => mockFindUserById(...a) }),
}))
jest.mock("@services/notifications/push-notifications", () => ({
  PushNotificationsService: () => ({
    sendFilteredNotification: (...a: unknown[]) => mockSendFiltered(...a),
  }),
  SendFilteredPushNotificationStatus: { Sent: "Sent", Filtered: "Filtered" },
}))
jest.mock("@app/users/remove-device-tokens", () => ({
  removeDeviceTokens: (...a: unknown[]) => mockRemoveDeviceTokens(...a),
}))

// The best-effort wrapper is the ONLY export, and the only thing payment.ts
// calls. Testing the content through it — rather than through a parallel
// error-returning entry point production never executes — means these
// assertions cover the code path that actually reaches a customer's phone.
import { sendFygaroTopupNotificationBestEffort } from "@app/fygaro/send-topup-notification"

const ACCOUNT_ID = "6a8203ce490716aa69381454"

beforeEach(() => {
  jest.clearAllMocks()
  mockFindAccountById.mockResolvedValue({
    id: ACCOUNT_ID,
    kratosUserId: "kratos-1",
    notificationSettings: {},
  })
  mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "en" })
  mockSendFiltered.mockResolvedValue({ status: "Sent" })
})

describe("sendFygaroTopupNotificationBestEffort", () => {
  it("tells the customer the NET that landed, not the gross they paid", async () => {
    // $60 paid, $56.52 credited. Naming the gross would overstate the balance
    // change and invite a support ticket about the missing $3.48.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.title).toBe("Top-up complete")
    expect(args.body).toContain("56.52 USD")
    expect(args.data).toMatchObject({ type: "fygaro_topup_credited", currency: "USD" })
  })

  it("sends data.amount in MAJOR units, the way every other Payments push does", async () => {
    // `amount` is the Bridge-deposit convention (major units); the referral
    // sender uses a different key, `amountCents`, precisely because it is cents.
    // Cents under this key renders a $56.52 credit as $5,652 in the app.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
    })

    expect(mockSendFiltered.mock.calls[0][0].data.amount).toBe("56.52")
  })

  it("also notifies when the payment was captured and NOT credited", async () => {
    // The case that actually matters. Notifying only on success keeps the
    // promise exactly when it costs nothing.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 6000,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.title).toBe("Top-up needs a moment")
    expect(args.body).toContain("60.00 USD")
    // Not a dead end: ops is already paged by the gate that produced this.
    expect(args.body.toLowerCase()).toContain("completing it manually")
  })

  it("promises no follow-up it cannot keep on a hand-credited payment", async () => {
    // Nothing in this codebase re-notifies when ops finishes the credit by hand
    // — that is an intraledger send, and `intraLedgerTxReceived` is on the
    // notifications service with no call site anywhere in this fork (grep it:
    // definition and export only). "We'll let you know when it lands" is the
    // exact unkeepable promise this whole feature was written to retire, with
    // an explicit broken commitment attached: a $500.01 over-limit payment
    // hand-credited three days later would leave the customer in the same
    // silence, now having been told otherwise.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 50001,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body.toLowerCase()).not.toContain("let you know")
    expect(args.body.toLowerCase()).not.toContain("when it lands")
  })

  it("names the currency the payment was actually captured in", async () => {
    // The heldForReview push fires on refusals that include `non-usd`. Assuming
    // USD rendered a J$6,000 payment as "$6000.00" — a ~150x overstatement in
    // the one message whose entire job is telling the customer what we hold.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 600000,
      currency: "JMD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("6000.00 JMD")
    expect(args.body).not.toContain("USD")
    expect(args.data).toMatchObject({ amount: "6000.00", currency: "JMD" })
  })

  it("tells an in-flight credit's customer it is on the way, in words that render", async () => {
    // The `crediting` copy is the newest customer-visible string here, and i18n
    // is configured `updateFiles: false`, so a dropped, renamed or mistyped key
    // ships the literal `notification.fygaroTopup.crediting.body` to a lock
    // screen with a fully green suite. Asserting it against a mocked
    // notification module — which is all payment.spec.ts can do — would not
    // catch that. Render it.
    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "crediting",
      amountCents: 5652,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.title).toBe("Top-up on its way")
    expect(args.body).toContain("56.52 USD")
    expect(args.body).toContain("should appear shortly")
    // Deliberately weaker than the credited copy: nothing has landed yet.
    expect(args.body).not.toContain("has been added")
  })

  it.each([
    ["credited", "Recarga completada"],
    ["crediting", "Tu recarga está en camino"],
  ] as const)("sends %s in the user's language", async (outcome, title) => {
    mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "es" })

    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome,
      amountCents: 5652,
      currency: "USD",
    })

    expect(mockSendFiltered.mock.calls[0][0].title).toBe(title)
  })

  it("makes the same manual-credit commitment in Spanish, and no more", async () => {
    // Asserted by substring rather than the whole sentence on purpose: the
    // Spanish title is the one string in this file the repo's spell checker
    // reads against an English dictionary (see typos.toml — es.json is excluded
    // for exactly this, test files are not). These two substrings are what
    // actually carries meaning: that a human finishes the payment, and that we
    // do NOT promise a second message when it lands, because nothing sends one.
    mockFindUserById.mockResolvedValue({ deviceTokens: ["tok-1"], language: "es" })

    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "heldForReview",
      amountCents: 50001,
      currency: "USD",
    })

    const [args] = mockSendFiltered.mock.calls[0]
    expect(args.body).toContain("500.01 USD")
    expect(args.body).toContain("manualmente")
    expect(args.body.toLowerCase()).not.toContain("cuando se acredite")
  })

  it.each([
    ["credited", "fygaro_topup_credited"],
    ["crediting", "fygaro_topup_crediting"],
    ["heldForReview", "fygaro_topup_held_for_review"],
  ] as const)(
    "sends %s under a fully snake_case data.type",
    async (outcome, dataType) => {
      // The wire contract flash-mobile switches on, alongside
      // `bridge_deposit_completed` / `bridge_deposit_processing`. Interpolating
      // the camelCase outcome into a snake_case prefix produced
      // `fygaro_topup_heldForReview`; once a mobile release ships against that,
      // correcting it costs a coordinated change across two repos.
      await sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome,
        amountCents: 5652,
        currency: "USD",
      })

      const actual = mockSendFiltered.mock.calls[0][0].data.type
      expect(actual).toBe(dataType)
      // Guards the CONVENTION, not just today's three strings: any future outcome
      // whose wire type picks up a camelCase segment fails here too.
      expect(actual).toBe(actual.toLowerCase())
    },
  )

  it("never throws when the push fails — the money has already moved", async () => {
    // Turning a failed notification into an error would put a DELIVERED credit
    // back into Fygaro's retry loop.
    mockSendFiltered.mockResolvedValue(new Error("fcm unavailable"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "credited",
        amountCents: 5652,
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
  })

  it("prunes device tokens that are no longer registered", async () => {
    // Reinstalled or handed-on devices, so the next notification is not sent
    // into the same void.
    mockSendFiltered.mockResolvedValue(
      new DeviceTokensNotRegisteredNotificationsServiceError(["stale-1" as DeviceToken]),
    )

    await sendFygaroTopupNotificationBestEffort({
      accountId: ACCOUNT_ID,
      outcome: "credited",
      amountCents: 5652,
      currency: "USD",
    })

    expect(mockRemoveDeviceTokens).toHaveBeenCalledWith({
      userId: "kratos-1",
      deviceTokens: ["stale-1"],
    })
  })

  it("swallows an unreadable account without throwing, and sends nothing", async () => {
    mockFindAccountById.mockResolvedValue(new Error("mongo down"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "heldForReview",
        amountCents: 6000,
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
    expect(mockSendFiltered).not.toHaveBeenCalled()
  })

  // The two cases below are the ONLY ones that exercise the try/catch in
  // `sendOutcomeNotificationBestEffort`, which is the entire justification for
  // awaiting this call on the money path. A repository that RETURNS an error
  // (above) is handled without any catch at all; a repository that THROWS —
  // a Mongoose connection error, an FCM client blowing up — is what the catch
  // is for. Without these, deleting the catch keeps the suite green while an
  // already-credited payment starts answering 500 with a CRITICAL alert,
  // because the throw propagates out of the redlock callback and payment.ts
  // rethrows it.
  it("swallows a repository that THROWS rather than returning an error", async () => {
    mockFindAccountById.mockRejectedValue(new Error("mongo down"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "credited",
        amountCents: 5652,
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
  })

  it("swallows a push client that THROWS after the credit already landed", async () => {
    mockSendFiltered.mockRejectedValue(new Error("fcm exploded"))

    await expect(
      sendFygaroTopupNotificationBestEffort({
        accountId: ACCOUNT_ID,
        outcome: "credited",
        amountCents: 5652,
        currency: "USD",
      }),
    ).resolves.toBeUndefined()
  })
})
