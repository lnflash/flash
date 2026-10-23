import { SpanKind, SpanStatusCode } from "@opentelemetry/api"
import { getOutgoingRequestAttributes } from "@opentelemetry/instrumentation-http/build/src/utils"
import type { Span as SdkSpan } from "@opentelemetry/sdk-trace-base"

import { sanitizeHTTPSpanForExport } from "@services/http-trace-privacy"

const secret = "fixture-private-url-token"

const span = (name: string, kind: SpanKind, attributes: Record<string, unknown>) =>
  ({
    name,
    kind,
    instrumentationLibrary: { name: "@opentelemetry/instrumentation-http" },
    attributes,
    status: { code: SpanStatusCode.ERROR, message: secret },
    events: [{ name: secret, time: [0, 0], attributes: { "exception.message": secret } }],
    links: [{ attributes: { private: secret } }],
  }) as unknown as SdkSpan

it("removes actual pinned HTTP plugin URL, target, host, headers and exception data", () => {
  const options = { hostname: "erp.example", port: 443, component: "https" }
  const request = {
    hostname: "erp.example",
    path: `/account/${secret}?token=${secret}`,
    method: "POST",
    headers: { "host": "erp.example", "user-agent": secret },
  }
  const attributes = getOutgoingRequestAttributes(request, options)
  expect(JSON.stringify(attributes)).toContain(secret)
  const target = span(`POST /account/${secret}`, SpanKind.CLIENT, {
    ...attributes,
    "http.status_code": 502,
    "http.request.header.authorization": secret,
  })
  sanitizeHTTPSpanForExport(target)
  expect(target.name).toBe("http.client")
  expect(target.attributes).toEqual({ "http.method": "POST", "http.status_code": 502 })
  expect(target.status).toEqual({ code: SpanStatusCode.ERROR })
  expect(target.events).toEqual([])
  expect(target.links).toEqual([])
  expect(JSON.stringify(request)).toContain(secret) // The real outgoing request remains untouched.
  expect(JSON.stringify(target)).not.toContain(secret)
})

it("closes server method, status, URL and baggage data without changing unrelated spans", () => {
  const target = span(`POST ${secret}`, SpanKind.SERVER, {
    "http.method": secret,
    "http.target": `/graphql?code=${secret}`,
    "url.full": `https://api.example/graphql?code=${secret}`,
    "http.status_code": secret,
    "enduser.id": secret,
    "http.request.header.cookie": secret,
  })
  sanitizeHTTPSpanForExport(target)
  expect(target.name).toBe("http.server")
  expect(target.attributes).toEqual({ "http.method": "OTHER" })
  expect(JSON.stringify(target)).not.toContain(secret)

  const unrelated = span(secret, SpanKind.INTERNAL, { "custom.private": secret })
  Object.assign(unrelated.instrumentationLibrary, { name: "fixture.custom" })
  sanitizeHTTPSpanForExport(unrelated)
  expect(unrelated.name).toBe(secret)
  expect(unrelated.attributes["custom.private"]).toBe(secret)
})
