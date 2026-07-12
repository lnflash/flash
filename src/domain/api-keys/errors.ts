import { ValidationError } from "@domain/shared"

export class ApiKeyError extends ValidationError {}
export class InvalidApiKeyNameError extends ApiKeyError {}
export class InvalidApiKeyScopeError extends ApiKeyError {}
export class InvalidApiKeyIpConstraintError extends ApiKeyError {}
export class MaxApiKeysPerAccountError extends ApiKeyError {}
