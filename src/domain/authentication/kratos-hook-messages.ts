// Contract between the api and Kratos for flow-interrupting web hooks.
//
// A web_hook configured with `response.parse: true` runs BEFORE Kratos persists
// the identity (selfservice/hook/web_hook.go, ExecutePostRegistrationPrePersistHook).
// Answering it with a 4xx and this body aborts the registration and surfaces
// the messages on the flow; nothing is written. The ids are Flash-private
// (Kratos' own message ids live below 5000000 in text/message_*.go, so a
// dedicated 41xxxxx block cannot collide) and are what the api matches on when
// Kratos hands the rejected flow back to it — never the text.

export const KratosHookMessageId = {
  PhoneNotAllowed: 4100001,
  PhoneAlreadyRegistered: 4100002,
  PayloadInvalid: 4100003,
  Unauthorized: 4100401,
  InternalError: 4100500,
} as const

export type KratosHookMessageId =
  (typeof KratosHookMessageId)[keyof typeof KratosHookMessageId]

export const KratosHookMessageText: Record<KratosHookMessageId, string> = {
  [KratosHookMessageId.PhoneNotAllowed]: "This phone number can't be used to sign up.",
  [KratosHookMessageId.PhoneAlreadyRegistered]:
    "This phone number is already registered.",
  [KratosHookMessageId.PayloadInvalid]: "Sign-up request was invalid. Please try again.",
  [KratosHookMessageId.Unauthorized]: "Sign-up is temporarily unavailable.",
  [KratosHookMessageId.InternalError]:
    "Sign-up is temporarily unavailable. Please try again.",
}

export const KRATOS_HOOK_PHONE_INSTANCE_PTR = "#/traits/phone"

export type KratosHookRejectionBody = {
  messages: {
    instance_ptr: string
    messages: { id: number; text: string; type: "error" }[]
  }[]
}

// Exact shape Kratos' parseWebhookResponse decodes for status >= 400.
export const kratosHookRejection = (
  id: KratosHookMessageId,
): KratosHookRejectionBody => ({
  messages: [
    {
      instance_ptr: KRATOS_HOOK_PHONE_INSTANCE_PTR,
      messages: [{ id, text: KratosHookMessageText[id], type: "error" }],
    },
  ],
})

// When the hook rejects, Kratos answers the api's updateRegistrationFlow call
// with HTTP 400 and the flow; our messages land on the matching ui node (or on
// ui.messages when no node matches the instance pointer). Collect every id in
// either place so the caller can map the rejection back to a domain error.
export const kratosHookMessageIdsFromFlow = (flowLike: unknown): number[] => {
  if (!flowLike || typeof flowLike !== "object") return []
  const ui = (flowLike as { ui?: unknown }).ui
  if (!ui || typeof ui !== "object") return []

  const ids: number[] = []
  const collect = (messages: unknown) => {
    if (!Array.isArray(messages)) return
    for (const msg of messages) {
      const id = (msg as { id?: unknown })?.id
      if (typeof id === "number") ids.push(id)
    }
  }

  collect((ui as { messages?: unknown }).messages)
  const nodes = (ui as { nodes?: unknown }).nodes
  if (Array.isArray(nodes)) {
    for (const node of nodes) collect((node as { messages?: unknown })?.messages)
  }
  return ids
}
