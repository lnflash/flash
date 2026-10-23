import PinoHttp from "pino-http"
import type { Logger } from "pino"

const methods = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
const routes = new Set(["/graphql", "/healthz", "/consent", "/consent/log"])

const routeForLog = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 16_384) return "[other route]"
  try {
    const path = new URL(value, "http://request.invalid").pathname
    return routes.has(path) ? path : "[other route]"
  } catch {
    return "[other route]"
  }
}

/** Access telemetry contains no request body, query values, headers or user. */
export const createRequestLogger = (logger: Logger) =>
  PinoHttp({
    logger,
    wrapSerializers: true,
    autoLogging: { ignore: (req) => routeForLog(req.url) === "/healthz" },
    customSuccessMessage: () => "request completed",
    customErrorMessage: () => "request errored",
    serializers: {
      req: (request) => ({
        ...(typeof request.id === "number" && Number.isSafeInteger(request.id)
          ? { id: request.id }
          : {}),
        method: methods.has(request.method) ? request.method : "OTHER",
        url: routeForLog(request.url),
      }),
      res: (response) => ({
        statusCode:
          Number.isInteger(response.statusCode) &&
          response.statusCode >= 100 &&
          response.statusCode <= 599
            ? response.statusCode
            : undefined,
      }),
      // Pino's standard error serializer copies enumerable Axios config/body
      // fields. Access failures need a failure marker and HTTP status only.
      err: () => ({ type: "HttpRequestError" }),
    },
  })
