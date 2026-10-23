// No provider registration, exporter, collector, or external request is used.
jest.mock("@opentelemetry/sdk-trace-node", () => {
  const processors: unknown[] = []
  return {
    processors,
    NodeTracerProvider: class {
      addSpanProcessor(processor: unknown) {
        processors.push(processor)
      }
      register() {
        return undefined
      }
    },
  }
})
jest.mock("@opentelemetry/sdk-trace-base", () => {
  const exported: unknown[] = []
  return {
    exported,
    SimpleSpanProcessor: class {
      onStart() {
        return undefined
      }
      onEnd(span: { attributes: Record<string, unknown> }) {
        exported.push({ ...span.attributes })
      }
    },
  }
})
jest.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
  OTLPTraceExporter: class {},
}))
jest.mock("@opentelemetry/instrumentation", () => ({
  ...jest.requireActual("@opentelemetry/instrumentation"),
  registerInstrumentations: jest.fn(({ instrumentations }) => {
    for (const instrumentation of instrumentations) instrumentation.disable()
  }),
}))
jest.mock("@opentelemetry/api", () => {
  const actual = jest.requireActual("@opentelemetry/api")
  return {
    ...actual,
    trace: Object.assign(Object.create(actual.trace), {
      getTracer: () => ({
        startActiveSpan: (...args: unknown[]) => mockStartActiveSpan(...args),
      }),
    }),
  }
})

import { GraphQLInstrumentation } from "@opentelemetry/instrumentation-graphql"
import { IORedisInstrumentation } from "@opentelemetry/instrumentation-ioredis"
import { registerInstrumentations } from "@opentelemetry/instrumentation"
import { parse } from "graphql"
import { TracerProvider, Span, trace } from "@opentelemetry/api"
import {
  wrapToRunInSpan,
  wrapAsyncToRunInSpan,
  wrapAsyncFunctionsToRunInSpan,
} from "@services/tracing"

const mockStartActiveSpan = jest.fn()
let span: ReturnType<typeof fakeSpan>
function fakeSpan() {
  const result = {
    attributes: {} as Record<string, unknown>,
    events: [] as unknown[],
    setAttribute: jest.fn((key: string, value: unknown) => {
      result.attributes[key] = value
      return result
    }),
    setAttributes: jest.fn((attributes: Record<string, unknown>) => {
      Object.assign(result.attributes, attributes)
      return result
    }),
    recordException: jest.fn((error: unknown) => {
      result.events.push(error)
    }),
    setStatus: jest.fn(),
    end: jest.fn(),
    updateName: jest.fn(),
  }
  return result
}

beforeEach(() => {
  span = fakeSpan()
  mockStartActiveSpan.mockReset().mockImplementation((_name, options, callback) => {
    span.attributes = { ...options.attributes }
    return callback(span)
  })
})

// Public deterministic fixtures, never real account credentials.
const secrets = {
  password: "0c305189-aa6d-487d-8ec4-66f779871e49",
  code: "418735",
  bearer: "Bearer PRIVATE_SESSION_TOKEN_f72cc9",
  basic: "Basic Zml4dHVyZS11c2VyOmZpeHR1cmUtcGFzc3dvcmQ=",
  account: "PRIVATE_BANK_ACCOUNT_00123456789",
  name: "PRIVATE_PERSONAL_NAME_Ada",
  email: "PRIVATE_EMAIL_alice@example.invalid",
  address: "PRIVATE_POSTAL_ADDRESS_10_Main_Street",
}
const expectNoInvocationValues = () => {
  const automatic = JSON.stringify(span.attributes)
  for (const secret of Object.values(secrets)) expect(automatic).not.toContain(secret)
  expect(
    Object.keys(span.attributes).some((key) => key.startsWith("code.function.params.")),
  ).toBe(false)
}

it.each(["sync", "async"])(
  "never inspects object inputs or records argument values in %s wrapper",
  async (kind) => {
    const input = {
      ...secrets,
      nested: { bank: secrets.account },
      absent: undefined,
      empty: null,
    }
    const fn = jest.fn((value: unknown) => value)
    const wrapped =
      kind === "sync"
        ? wrapToRunInSpan({ namespace: "privacy", fnName: "authenticate", fn })
        : wrapAsyncToRunInSpan({
            namespace: "privacy",
            fnName: "authenticate",
            fn: async (value: unknown) => fn(value),
          })
    expect(await wrapped(input)).toBe(input)
    expect(fn).toHaveBeenCalledWith(input)
    expect(span.attributes).toEqual({
      "code.function": "authenticate",
      "code.namespace": "privacy",
    })
    expectNoInvocationValues()
    expect(span.end).toHaveBeenCalledTimes(1)
  },
)

it.each(Object.values(secrets))(
  "never records positional credentials or other primitive inputs (fixture %#)",
  async (secret) => {
    const sync = wrapToRunInSpan({ namespace: "privacy", fn: (value: string) => value })
    expect(sync(secret)).toBe(secret)
    expectNoInvocationValues()
    const async = wrapAsyncToRunInSpan({
      namespace: "privacy",
      fn: async (value: string) => value,
    })
    expect(await async(secret)).toBe(secret)
    expectNoInvocationValues()
  },
)

it("does not enumerate inputs or run property getters for tracing", () => {
  const get = jest.fn(() => {
    throw new Error("Argument getter must not run")
  })
  const ownKeys = jest.fn(() => {
    throw new Error("Argument enumeration must not run")
  })
  const input = new Proxy({}, { get, ownKeys })
  const wrapped = wrapToRunInSpan({
    namespace: "privacy",
    fn: (value: unknown) => (value === input ? 42 : 0),
  })
  expect(wrapped(input)).toBe(42)
  expect(get).not.toHaveBeenCalled()
  expect(ownKeys).not.toHaveBeenCalled()
})

it("preserves explicit span attributes, root selection, names, and every call argument", () => {
  const fn = jest.fn((first: string, second: number) => ({ first, second }))
  const wrapped = wrapToRunInSpan({
    namespace: "privacy",
    fnName: "named",
    root: true,
    spanAttributes: { "operation.category": "account", "safe.count": 0 },
    fn,
  })
  expect(wrapped(secrets.password, 7)).toEqual({ first: secrets.password, second: 7 })
  expect(wrapped.name).toBe("named")
  expect(fn).toHaveBeenCalledWith(secrets.password, 7)
  expect(mockStartActiveSpan.mock.calls[0].slice(0, 2)).toEqual([
    "privacy.named",
    {
      root: true,
      attributes: {
        "code.function": "named",
        "code.namespace": "privacy",
        "operation.category": "account",
        "safe.count": 0,
      },
    },
  ])
  expectNoInvocationValues()
})

it("dispatches both kinds of grouped wrappers without input capture", async () => {
  const wrapped = wrapAsyncFunctionsToRunInSpan({
    namespace: "group",
    fns: {
      sync: (value: unknown) => value,
      async: async (value: unknown) => value,
    },
  })
  expect(wrapped.sync(secrets)).toBe(secrets)
  expectNoInvocationValues()
  expect(await wrapped.async(secrets)).toBe(secrets)
  expectNoInvocationValues()
})

it.each(["sync", "async"])(
  "preserves returned errors and partial errors in %s wrapper",
  async (kind) => {
    const error = new Error("Safe fixture error")
    for (const result of [error, { partialResult: true, error }]) {
      span = fakeSpan()
      const fn = () => result
      const wrapped =
        kind === "sync"
          ? wrapToRunInSpan({ namespace: "errors", fn })
          : wrapAsyncToRunInSpan({ namespace: "errors", fn: async () => fn() })
      expect(await wrapped()).toBe(result)
      expect(span.recordException).toHaveBeenCalledWith(error)
      expect(span.end).toHaveBeenCalledTimes(1)
    }
  },
)

it("preserves synchronous thrown error identity and ends the span", () => {
  const error = new Error("Safe fixture error")
  const wrapped = wrapToRunInSpan({
    namespace: "errors",
    fn: () => {
      throw error
    },
  })
  let caught: unknown
  try {
    wrapped()
  } catch (value) {
    caught = value
  }
  expect(caught).toBe(error)
  expect(span.recordException).toHaveBeenCalledWith(error)
  expect(span.end).toHaveBeenCalledTimes(1)
})

it("preserves asynchronous thrown error identity and ends the span", async () => {
  const error = new Error("Safe fixture error")
  const wrapped = wrapAsyncToRunInSpan({
    namespace: "errors",
    fn: async () => {
      throw error
    },
  })
  await expect(wrapped()).rejects.toBe(error)
  expect(span.recordException).toHaveBeenCalledWith(error)
  expect(span.end).toHaveBeenCalledTimes(1)
})

function configuredGraphQL() {
  const options = jest.mocked(registerInstrumentations).mock.calls[0][0]
  const instrumentation = options.instrumentations
    ?.flat()
    .find((item) => item instanceof GraphQLInstrumentation)
  if (!(instrumentation instanceof GraphQLInstrumentation))
    throw new Error("GraphQL instrumentation not registered")
  instrumentation.setTracerProvider({
    getTracer: () => ({ startSpan: () => span }),
  } as unknown as TracerProvider)
  return instrumentation
}

it("disables real pinned GraphQL variable capture and masks string, block-string and numeric literals", () => {
  const instrumentation = configuredGraphQL()
  expect(Reflect.get(instrumentation.getConfig(), "allowValues")).toBe(false)
  const document = parse(
    `mutation Privacy($input: String) { verify(password: "${secrets.password}", code: "123456", bank: """${secrets.account}""", cents: 123456789, fraction: 12.3456789) }`,
  )
  const operation = document.definitions[0]
  // Exercise the exact installed plugin's span path, not an imitation masker.
  Reflect.get(instrumentation, "_createExecuteSpan").call(instrumentation, operation, {
    document,
    variableValues: { input: secrets, nested: [{ token: secrets.bearer }] },
  })
  expectNoInvocationValues()
  expect(span.attributes["graphql.source"]).not.toContain("123456")
  expect(span.attributes["graphql.source"]).not.toContain("12.3456789")
  expect(
    Object.keys(span.attributes).some((key) => key.startsWith("graphql.variables.")),
  ).toBe(false)
  expect(span.attributes["graphql.operation.name"]).toBe("Privacy")
})

it("drops source at the export boundary, including comment and enum literals not masked by the pinned plugin", () => {
  const instrumentation = configuredGraphQL()
  const document = parse(
    "query Privacy { verify(kind: PRIVATE_ENUM_SECRET) # PRIVATE_COMMENT_SECRET\n }",
  )
  Reflect.get(instrumentation, "_createExecuteSpan").call(
    instrumentation,
    document.definitions[0],
    { document },
  )
  expect(span.attributes["graphql.source"]).toContain("PRIVATE_COMMENT_SECRET")
  expect(span.attributes["graphql.source"]).toContain("PRIVATE_ENUM_SECRET")
  const processor = jest.requireMock("@opentelemetry/sdk-trace-node").processors[0]
  processor.onEnd(span)
  const exported = jest.requireMock("@opentelemetry/sdk-trace-base").exported.at(-1)
  expect(exported["graphql.source"]).toBeUndefined()
  expect(JSON.stringify(exported)).not.toContain("PRIVATE_")
  expect(exported["graphql.operation.name"]).toBe("Privacy")
  expect(exported["graphql.operation.type"]).toBe("query")
})

it("also drops GraphQL parser source before export rather than protecting only execute spans", () => {
  const instrumentation = configuredGraphQL()
  const document = Reflect.get(instrumentation, "_parse").call(
    instrumentation,
    undefined,
    parse,
    "query Parsed { verify(kind: PRIVATE_ENUM_SECRET) # PRIVATE_COMMENT_SECRET\n }",
    undefined,
  )
  expect(document.kind).toBe("Document")
  expect(span.attributes["graphql.source"]).toContain("PRIVATE_COMMENT_SECRET")
  expect(span.end).toHaveBeenCalledTimes(1)
  const processor = jest.requireMock("@opentelemetry/sdk-trace-node").processors[0]
  processor.onEnd(span)
  const exported = jest.requireMock("@opentelemetry/sdk-trace-base").exported.at(-1)
  expect(exported["graphql.source"]).toBeUndefined()
  expect(JSON.stringify(exported)).not.toContain("PRIVATE_")
})

it.each([
  ["set", ["plaid:link:PRIVATE_TOKEN", "PRIVATE_BANK_BINDING"]],
  ["get", ["plaid:link:PRIVATE_TOKEN"]],
  ["del", ["plaid:link:PRIVATE_TOKEN"]],
  ["eval", ["return 'PRIVATE_LUA_SECRET'", "1", "PRIVATE_KEY", "PRIVATE_ARGUMENT"]],
  ["auth", ["PRIVATE_REDIS_PASSWORD"]],
])(
  "records only the %s command name through the exact Redis plugin while preserving execution",
  (name, args) => {
    const options = jest.mocked(registerInstrumentations).mock.calls[0][0]
    const instrumentation = options.instrumentations
      ?.flat()
      .find((item) => item instanceof IORedisInstrumentation)
    if (!(instrumentation instanceof IORedisInstrumentation))
      throw new Error("Redis instrumentation not registered")
    instrumentation.setTracerProvider({
      getTracer: () => ({
        startSpan: (_name: string, options: { attributes: Record<string, unknown> }) => {
          Object.assign(span.attributes, options.attributes)
          return span
        },
      }),
    } as unknown as TracerProvider)
    const resolve = jest.fn(),
      reject = jest.fn()
    const command = { name, args, resolve, reject }
    const providerResult = { fixture: true }
    const original = jest.fn(() => providerResult)
    const wrapped = Reflect.get(instrumentation, "_traceSendCommand").call(
      instrumentation,
      original,
      "fixture-version",
    )
    // The production plugin requires a parent span. Simulate that authority
    // without registering an SDK or exporting any span.
    const parent = jest.spyOn(trace, "getSpan").mockReturnValue(span as unknown as Span)
    try {
      expect(
        wrapped.call({ options: { host: "fixture.invalid", port: 6379 } }, command),
      ).toBe(providerResult)
      expect(original).toHaveBeenCalledWith(command)
      expect(command.args).toBe(args)
      expect(span.attributes["db.statement"]).toBe(name)
      expect(JSON.stringify(span.attributes)).not.toContain("PRIVATE_")
      command.resolve("fixture-result")
      expect(resolve).toHaveBeenCalledWith("fixture-result")
      expect(span.end).toHaveBeenCalledTimes(1)
    } finally {
      parent.mockRestore()
    }
  },
)
