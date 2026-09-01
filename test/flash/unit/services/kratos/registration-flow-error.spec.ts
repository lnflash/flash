import {
  LikelyUserAlreadyExistError,
  PhoneAlreadyExistsError,
  PhoneNotAllowedForRegistrationError,
} from "@domain/authentication/errors"
import { KratosHookMessageId } from "@domain/authentication/kratos-hook-messages"
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

  it("maps the pre-hook 'already registered' id to PhoneAlreadyExistsError", () => {
    expect(
      mapRegistrationFlowRejection(
        axios400(flowWithHookMessage(KratosHookMessageId.PhoneAlreadyRegistered)),
      ),
    ).toBeInstanceOf(PhoneAlreadyExistsError)
  })

  it("maps the pre-hook 'not allowed' and 'payload invalid' ids to PhoneNotAllowedForRegistrationError", () => {
    expect(
      mapRegistrationFlowRejection(
        axios400(flowWithHookMessage(KratosHookMessageId.PhoneNotAllowed)),
      ),
    ).toBeInstanceOf(PhoneNotAllowedForRegistrationError)
    expect(
      mapRegistrationFlowRejection(
        axios400(flowWithHookMessage(KratosHookMessageId.PayloadInvalid)),
      ),
    ).toBeInstanceOf(PhoneNotAllowedForRegistrationError)
  })

  it("prefers 'already registered' when both ids are present", () => {
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
      PhoneAlreadyExistsError,
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
