import { FygaroWebhookHandler } from "./fygaro"
import { StripeWebhookHandler } from "./stripe"
import { PayPalWebhookHandler } from "./paypal"
import { TopupWebhookHandler } from "./base"

export * from "./base"
export * from "./fygaro"
export * from "./stripe"
export * from "./paypal"

const handlers: Record<string, TopupWebhookHandler> = {
  fygaro: new FygaroWebhookHandler(),
  stripe: new StripeWebhookHandler(),
  paypal: new PayPalWebhookHandler(),
}

export const getTopupWebhookHandler = (provider: string): TopupWebhookHandler | undefined => {
  return handlers[provider]
}

export const getAllTopupWebhookHandlers = (): TopupWebhookHandler[] => {
  return Object.values(handlers)
}