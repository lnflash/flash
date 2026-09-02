import {
  LikelyUserAlreadyExistError,
  PhoneAlreadyExistsError,
  PhoneAlreadyRegisteredError,
  PhoneNotAllowedForRegistrationError,
} from "@domain/authentication/errors"
import { KratosHookMessageId } from "@domain/authentication/kratos-hook-messages"
import { RegistrationHookFailedError } from "@services/kratos/errors"
import { mapRegistrationFlowRejection } from "@services/kratos/registration-flow-error"

// Shape @ory/client (axios) throws when Kratos answers updateRegistrationFlow
// with 400: the message is the axios one, the flow rides in response.data.
const axios400 = (flow: unknown) =>
  Object.assign(new Error("Request failed with status code 400"), {
    response: { status: 400, data: flow },
  })

const flowWithHookMessage = (id: number) => ({
  id: "flow",
  ui: {
    messages: [],
    nodes: [
      {
        attributes: { name: "traits.phone" },
        messages: [{ id, text: "x", type: "error" }],
      },
    ],
  },
})

describe("mapRegistrationFlowRejection", () => {
  it("ignores anything that is not a 400", () => {
    expect(
      mapRegistrationFlowRejection(new Error("Request failed with status code 500")),
    ).toBeNull()
    expect(mapRegistrationFlowRejection(new Error("ECONNREFUSED"))).toBeNull()
    expect(mapRegistrationFlowRejection("400")).toBeNull()
    expect(mapRegistrationFlowRejection(undefined)).toBeNull()
  })

  it("maps the pre-hook 'already registered' id to PhoneAlreadyRegisteredError, never the add-phone error", () => {
    const mapped = mapRegistrationFlowRejection(
      axios400(flowWithHookMessage(KratosHookMessageId.PhoneAlreadyRegistered)),
    )

    expect(mapped).toBeInstanceOf(PhoneAlreadyRegisteredError)
    // PhoneAlreadyExistsError reads "one phone per account" on the GraphQL
    // boundary; a caller on the sign-up path has no account.
    expect(mapped).not.toBeInstanceOf(PhoneAlreadyExistsError)
  })

  it("maps the pre-hook 'not allowed' id to PhoneNotAllowedForRegistrationError", () => {
    expect(
      mapRegistrationFlowRejection(
        axios400(flowWithHookMessage(KratosHookMessageId.PhoneNotAllowed)),
      ),
    ).toBeInstanceOf(PhoneNotAllowedForRegistrationError)
  })

  it.each([
    ["payload invalid", KratosHookMessageId.PayloadInvalid],
    ["unauthorized", KratosHookMessageId.Unauthorized],
    ["internal error", KratosHookMessageId.InternalError],
  ])(
    "maps the '%s' id to RegistrationHookFailedError carrying the id, not to a phone-policy answer",
    (_label, id) => {
      const mapped = mapRegistrationFlowRejection(axios400(flowWithHookMessage(id)))

      expect(mapped).toBeInstanceOf(RegistrationHookFailedError)
      expect((mapped as Error).message).toBe(`hook message id ${id}`)
      expect(mapped).not.toBeInstanceOf(PhoneNotAllowedForRegistrationError)
      expect(mapped).not.toBeInstanceOf(PhoneAlreadyRegisteredError)
      expect(mapped).not.toBeInstanceOf(LikelyUserAlreadyExistError)
    },
  )

  it("prefers 'already registered' when both phone ids are present", () => {
    const flow = {
      ui: {
        messages: [{ id: KratosHookMessageId.PhoneNotAllowed, text: "x", type: "error" }],
        nodes: [
          {
            messages: [
              {
                id: KratosHookMessageId.PhoneAlreadyRegistered,
                text: "y",
                type: "error",
              },
            ],
          },
        ],
      },
    }
    expect(mapRegistrationFlowRejection(axios400(flow))).toBeInstanceOf(
      PhoneAlreadyRegisteredError,
    )
  })

  it("prefers a phone-policy id over a hook-failure id when both are present", () => {
    const flow = {
      ui: {
        messages: [{ id: KratosHookMessageId.InternalError, text: "x", type: "error" }],
        nodes: [
          {
            messages: [
              { id: KratosHookMessageId.PhoneNotAllowed, text: "y", type: "error" },
            ],
          },
        ],
      },
    }
    expect(mapRegistrationFlowRejection(axios400(flow))).toBeInstanceOf(
      PhoneNotAllowedForRegistrationError,
    )
  })

  it("keeps the historical reading for a 400 without our ids (Kratos duplicate identifier)", () => {
    const kratosDuplicate = {
      ui: {
        messages: [
          {
            id: 4000007,
            text: "An account with the same identifier exists already.",
            type: "error",
          },
        ],
      },
    }
    const mapped = mapRegistrationFlowRejection(axios400(kratosDuplicate))
    expect(mapped).toBeInstanceOf(LikelyUserAlreadyExistError)
    expect((mapped as Error).message).toBe("Request failed with status code 400")
  })

  it("keeps the historical reading for a 400 with no body at all", () => {
    expect(
      mapRegistrationFlowRejection(new Error("Request failed with status code 400")),
    ).toBeInstanceOf(LikelyUserAlreadyExistError)
  })
})
