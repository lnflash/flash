import { DomainError, ErrorLevel } from "@domain/shared"

export class IbexEventError extends DomainError {}
export class NotImplementedError extends Error {}

export class IbexAuthenticationError extends IbexEventError {}
export class UnexpectedResponseError extends IbexEventError {}