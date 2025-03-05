import { DomainError, ErrorLevel } from '@domain/shared';
import { baseLogger } from '@services/logger';
import { ApiError, AuthenticationError, UnexpectedResponseError } from 'ibex-client'
import { IbexClientError } from 'ibex-client';

export class IbexError extends DomainError {
  readonly type: string
  readonly level: ErrorLevel
  readonly httpCode?: number

  constructor(err: Error, level: ErrorLevel = ErrorLevel.Critical) {
    super(err)
    this.type = err.name
    this.level = level
    // this.httpCode = err instanceof ApiError ? err.code : undefined
  }
}

export class UnexpectedIbexResponse extends IbexError {
  constructor(message: string, level?: ErrorLevel) {
    super(new UnexpectedResponseError(message), level)
  }
}

export const errorHandler = <T>(e: T | IbexClientError | AuthenticationError | ApiError): T | IbexError => { 
  if (e instanceof IbexClientError) {
    baseLogger.error(e)
    return new IbexError(e)
  }
  else return e
}  

