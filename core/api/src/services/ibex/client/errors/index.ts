import { DomainError, ErrorLevel } from "@/domain/shared"

export class IbexClientError extends DomainError {}

export class IbexApiError extends IbexClientError {
  code: number // http error code
  constructor(code: number, message?: string | unknown | Error) {
    super(message)
    this.code = code
  }
}

export class NotImplementedError extends IbexClientError {
  level = ErrorLevel.Critical
}
export class IbexAuthenticationError extends IbexClientError {}
export class UnexpectedResponseError extends IbexClientError {
  level = ErrorLevel.Warn
}
