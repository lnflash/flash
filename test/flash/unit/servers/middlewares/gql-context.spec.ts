import { NextFunction, Request, Response } from "express"

import { AuthenticationError } from "@graphql/error"
import { setGqlContext } from "@servers/middlewares/gql-context"
import { sessionPublicContext } from "@servers/middlewares/session"
import { baseLogger } from "@services/logger"
import { recordExceptionInCurrentSpan } from "@services/tracing"

jest.mock("@servers/middlewares/session", () => ({
  sessionPublicContext: jest.fn(),
}))

jest.mock("@services/logger", () => ({
  baseLogger: { error: jest.fn(), warn: jest.fn(), info: jest.fn() },
}))

jest.mock("@services/tracing", () => ({
  ACCOUNT_USERNAME: "account.username",
  SemanticAttributes: {
    HTTP_CLIENT_IP: "http.client_ip",
    HTTP_USER_AGENT: "http.user_agent",
    ENDUSER_ID: "enduser.id",
  },
  addAttributesToCurrentSpanAndPropagate: jest.fn((_attributes, fn) => fn()),
  recordExceptionInCurrentSpan: jest.fn(),
}))

const mockedSessionPublicContext = sessionPublicContext as jest.MockedFunction<
  typeof sessionPublicContext
>
const mockedRecordException = recordExceptionInCurrentSpan as jest.MockedFunction<
  typeof recordExceptionInCurrentSpan
>
const mockedLogger = baseLogger as unknown as { error: jest.Mock; warn: jest.Mock }

const kratosUserId = "ebbe2b32-9a2e-4c77-80e4-5d7347c024bb"

const makeReq = () =>
  ({
    token: { sub: kratosUserId, iss: "galoy.io" },
    headers: { "x-real-ip": "203.0.113.7", "user-agent": "jest" },
  }) as unknown as Request & { gqlContext?: unknown }

const makeRes = () => {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  }
  res.status.mockReturnValue(res)
  return res as unknown as Response & { status: jest.Mock; json: jest.Mock }
}

describe("setGqlContext", () => {
  let next: jest.MockedFunction<NextFunction>

  beforeEach(() => {
    mockedSessionPublicContext.mockReset()
    mockedRecordException.mockReset()
    mockedLogger.error.mockReset()
    mockedLogger.warn.mockReset()
    next = jest.fn()
  })

  it("attaches the resolved context and continues the chain", async () => {
    const context = {
      domainAccount: { username: "alice" },
      user: { id: kratosUserId },
    }
    mockedSessionPublicContext.mockResolvedValue(
      context as unknown as Awaited<ReturnType<typeof sessionPublicContext>>,
    )
    const req = makeReq()
    const res = makeRes()

    await setGqlContext(req, res, next)

    expect(next).toHaveBeenCalled()
    expect(req.gqlContext).toEqual(
      expect.objectContaining({
        domainAccount: context.domainAccount,
        cashWalletClientCapabilities: expect.any(Object),
      }),
    )
    expect(res.status).not.toHaveBeenCalled()
  })

  // The 2026-09-01 crash loop: one Kratos identity with no account rejected
  // out of the async middleware, Express never caught it, and Node exited the
  // replica on the unhandled rejection. The middleware must resolve — never
  // reject — and answer the session as unauthenticated.
  it("answers an unauthenticated session as a GraphQL error and does not reject", async () => {
    const authError = new AuthenticationError({
      message: "No account is linked to this session",
      logger: baseLogger,
    })
    mockedSessionPublicContext.mockRejectedValue(authError)
    const req = makeReq()
    const res = makeRes()

    await expect(setGqlContext(req, res, next)).resolves.toBeUndefined()

    expect(next).not.toHaveBeenCalled()
    expect(req.gqlContext).toBeUndefined()
    // HTTP 200 + GraphQL error: the federation router swallows non-2xx
    // subgraph responses into an opaque SUBREQUEST_HTTP_ERROR.
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      data: null,
      errors: [
        {
          message: "No account is linked to this session",
          extensions: { code: "NOT_AUTHENTICATED" },
        },
      ],
    })
    // Not a server fault: the repair site already recorded why the session
    // has no account, and an orphan's pollers land here on every request. A
    // warn line, no error line, no Critical span exception.
    expect(mockedLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: authError, kratosUserId }),
      "unauthenticated session",
    )
    expect(mockedLogger.error).not.toHaveBeenCalled()
    expect(mockedRecordException).not.toHaveBeenCalled()
  })

  it("answers any other failure as a 500 and does not reject", async () => {
    const boom = new Error("kratos unreachable")
    mockedSessionPublicContext.mockRejectedValue(boom)
    const req = makeReq()
    const res = makeRes()

    await expect(setGqlContext(req, res, next)).resolves.toBeUndefined()

    expect(next).not.toHaveBeenCalled()
    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: "failed to build graphql context" })
    expect(mockedLogger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: boom, kratosUserId }),
      "failed to build graphql context",
    )
    expect(mockedRecordException).toHaveBeenCalledWith(
      expect.objectContaining({ error: boom, level: "critical" }),
    )
  })
})
