import {
  KRATOS_HOOK_PHONE_INSTANCE_PTR,
  KratosHookMessageId,
  KratosHookMessageText,
  kratosHookMessageIdsFromFlow,
  kratosHookRejection,
} from "@domain/authentication/kratos-hook-messages"

describe("kratos hook messages", () => {
  it("builds the exact body Kratos' parseWebhookResponse decodes for a >= 400 answer", () => {
    expect(kratosHookRejection(KratosHookMessageId.PhoneNotAllowed)).toStrictEqual({
      messages: [
        {
          instance_ptr: "#/traits/phone",
          messages: [
            {
              id: 4100001,
              text: "This phone number can't be used to sign up.",
              type: "error",
            },
          ],
        },
      ],
    })
    expect(KRATOS_HOOK_PHONE_INSTANCE_PTR).toBe("#/traits/phone")
  })

  it("has a distinct id and user-readable text for every rejection kind", () => {
    const ids = Object.values(KratosHookMessageId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) {
      expect(id).toBeGreaterThanOrEqual(4100000)
      expect(KratosHookMessageText[id]).toMatch(/\S/)
      expect(kratosHookRejection(id).messages[0].messages[0]).toStrictEqual({
        id,
        text: KratosHookMessageText[id],
        type: "error",
      })
    }
  })

  describe("kratosHookMessageIdsFromFlow", () => {
    it("collects ids from ui.messages and from every node's messages", () => {
      const flow = {
        id: "flow-id",
        ui: {
          messages: [{ id: 4000007, text: "already exists", type: "error" }],
          nodes: [
            { attributes: { name: "traits.phone" }, messages: [] },
            {
              attributes: { name: "traits.phone" },
              messages: [{ id: 4100002, text: "registered", type: "error" }],
            },
          ],
        },
      }

      expect(kratosHookMessageIdsFromFlow(flow)).toStrictEqual([4000007, 4100002])
    })

    it("returns nothing for non-flow payloads", () => {
      expect(kratosHookMessageIdsFromFlow(undefined)).toStrictEqual([])
      expect(kratosHookMessageIdsFromFlow("string")).toStrictEqual([])
      expect(kratosHookMessageIdsFromFlow({})).toStrictEqual([])
      expect(kratosHookMessageIdsFromFlow({ ui: { nodes: "nope" } })).toStrictEqual([])
      expect(
        kratosHookMessageIdsFromFlow({ ui: { messages: [{ id: "4100001" }] } }),
      ).toStrictEqual([])
    })
  })
})
