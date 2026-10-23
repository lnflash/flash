import { SpanKind, SpanStatusCode, type Attributes } from "@opentelemetry/api"
import type { Span as SdkSpan } from "@opentelemetry/sdk-trace-base"

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])

/** Project only closed HTTP facts before a span reaches any exporter. */
export const sanitizeHTTPSpanForExport = (span: SdkSpan): void => {
  if (span.instrumentationLibrary.name !== "@opentelemetry/instrumentation-http") return
  const method = span.attributes["http.method"] ?? span.attributes["http.request.method"]
  const rawStatus =
    span.attributes["http.status_code"] ?? span.attributes["http.response.status_code"]
  const status =
    typeof rawStatus === "number" &&
    Number.isInteger(rawStatus) &&
    rawStatus >= 100 &&
    rawStatus <= 599
      ? rawStatus
      : undefined
  const safe: Attributes = {
    "http.method": typeof method === "string" && methods.has(method) ? method : "OTHER",
  }
  if (status !== undefined) safe["http.status_code"] = status
  for (const key of Object.keys(span.attributes)) delete span.attributes[key]
  Object.assign(span.attributes, safe)
  span.name =
    span.kind === SpanKind.CLIENT
      ? "http.client"
      : span.kind === SpanKind.SERVER
        ? "http.server"
        : "http.other"
  span.status = {
    code:
      span.status.code === SpanStatusCode.ERROR ? SpanStatusCode.ERROR : span.status.code,
  }
  span.events.splice(0, span.events.length)
  span.links.splice(0, span.links.length)
}
