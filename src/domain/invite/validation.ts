import { InviteMethod } from "@services/mongoose/models/invite"
import { ValidationError } from "@domain/shared"

export const validateEmail = (email: string): boolean => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

export const validatePhone = (phone: string): boolean => {
  const phoneRegex = /^\+[1-9]\d{7,14}$/
  return phoneRegex.test(phone)
}

export const validateContactForMethod = (
  contact: string,
  method: InviteMethod,
): true | ValidationError => {
  switch (method) {
    case InviteMethod.EMAIL:
      if (!validateEmail(contact)) {
        return new ValidationError("Invalid email format")
      }
      return true
    case InviteMethod.SMS:
    case InviteMethod.WHATSAPP:
      if (!validatePhone(contact)) {
        return new ValidationError("Invalid phone number format")
      }
      return true
    default:
      return new ValidationError("Invalid invite method")
  }
}
