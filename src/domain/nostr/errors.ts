import { DomainError, ValidationError } from "@domain/shared"

export class NostrError extends DomainError {}

export class InvalidNpubError extends ValidationError {}

export class NpubNotAvailableError extends NostrError {}
