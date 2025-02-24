// import { DomainError, ErrorLevel } from '@domain/shared';
// import { IbexClientError } from 'ibex-client/dist/errors'

// export class IbexError extends DomainError {
//   readonly level: ErrorLevel
//   constructor(err: IbexClientError | string, level: ErrorLevel = ErrorLevel.Critical) {
//     super(err)
//     this.level = level
//   }
// }

// export class UnexpectedIbexResponse extends IbexError {
//   constructor(message: string, level?: ErrorLevel) {
//     super(message, level)
//   }
// }

export { 
  IbexClientError,
  // ApiError, 
  // AuthenticationError, 
  UnexpectedResponseError, 
} from 'ibex-client/dist/errors'
