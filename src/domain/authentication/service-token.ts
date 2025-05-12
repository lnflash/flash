import { ServiceTokenError } from "./errors"
import { ValidationError } from "@domain/shared"

// Maximum duration for service tokens (1 year in days)
export const MAX_SERVICE_TOKEN_DAYS = 365

// Default token duration (in days)
export const DEFAULT_SERVICE_TOKEN_DAYS = 30

// JWT Token type for service accounts
export const SERVICE_TOKEN_TYPE = "service"

export const validateExpirationDays = (expiresIn: number): true | ValidationError => {
  if (!expiresIn || expiresIn <= 0 || expiresIn > MAX_SERVICE_TOKEN_DAYS) {
    return new ValidationError(
      `Expiration days must be between 1 and ${MAX_SERVICE_TOKEN_DAYS}`,
    )
  }
  return true
}

export const validateServiceAccount = (isServiceAccount: boolean | undefined): true | ServiceTokenError => {
  if (!isServiceAccount) {
    return new ServiceTokenError("Account is not a service account")
  }
  return true
}

export const daysToSeconds = (days: number): number => {
  return days * 24 * 60 * 60 // days to seconds
}