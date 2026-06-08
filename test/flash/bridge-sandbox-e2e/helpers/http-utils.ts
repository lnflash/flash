/**
 * Create mock Express req/res objects for webhook handler injection.
 */

import { EventEmitter } from "events"

interface MockRequestOptions {
  body?: Record<string, unknown>
  headers?: Record<string, string>
  method?: string
  path?: string
}

class MockResponse extends EventEmitter {
  public statusCode: number = 200
  public _body: unknown = null
  public _headers: Record<string, string> = {}
  public _ended: boolean = false

  status(code: number): this {
    this.statusCode = code
    return this
  }

  json(data: unknown): this {
    this._body = data
    this._ended = true
    this.emit("finish")
    return this
  }

  send(data: unknown): this {
    this._body = data
    this._ended = true
    this.emit("finish")
    return this
  }

  setHeader(name: string, value: string): this {
    this._headers[name] = value
    return this
  }

  end(): this {
    this._ended = true
    this.emit("finish")
    return this
  }
}

export function createReqRes(options: MockRequestOptions = {}): {
  req: Record<string, unknown>
  res: MockResponse
} {
  const req: Record<string, unknown> = {
    body: options.body || {},
    headers: options.headers || { "content-type": "application/json" },
    method: options.method || "POST",
    path: options.path || "/",
    ip: "127.0.0.1",
    query: {},
    params: {},
  }

  const res = new MockResponse()

  return { req, res }
}
