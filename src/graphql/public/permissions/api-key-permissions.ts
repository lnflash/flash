import { shield } from "graphql-shield"
import { isApiKeyAuthenticated, hasApiKeyScope } from "../rules/api-key-rules"

export const apiKeyPermissions = shield(
  {
    Query: {
      // Public queries accessible with API key
      globals: isApiKeyAuthenticated,
      currencyList: isApiKeyAuthenticated,
      btcPrice: isApiKeyAuthenticated,
      btcPriceList: isApiKeyAuthenticated,
      realtimePrice: isApiKeyAuthenticated,
      
      // Account-level queries
      me: hasApiKeyScope("read:account"),
      
      // Wallet-level queries
      onChainTxFee: hasApiKeyScope("read:onchain"),
      onChainUsdTxFee: hasApiKeyScope("read:onchain"),
      onChainUsdTxFeeAsBtcDenominated: hasApiKeyScope("read:onchain"),
      
      // Transaction queries
      lnInvoicePaymentStatus: hasApiKeyScope("read:transaction"),
    },
    
    Mutation: {
      // Lightning invoice mutations
      lnInvoiceCreate: hasApiKeyScope("write:lightning"),
      lnUsdInvoiceCreate: hasApiKeyScope("write:lightning"),
      lnNoAmountInvoiceCreate: hasApiKeyScope("write:lightning"),
      
      // Lightning payment mutations
      lnInvoicePaymentSend: hasApiKeyScope("write:lightning"),
      lnNoAmountInvoicePaymentSend: hasApiKeyScope("write:lightning"),
      lnNoAmountUsdInvoicePaymentSend: hasApiKeyScope("write:lightning"),
      
      // Lightning fee probing
      lnInvoiceFeeProbe: hasApiKeyScope("read:lightning"),
      lnUsdInvoiceFeeProbe: hasApiKeyScope("read:lightning"),
      lnNoAmountInvoiceFeeProbe: hasApiKeyScope("read:lightning"),
      lnNoAmountUsdInvoiceFeeProbe: hasApiKeyScope("read:lightning"),
      
      // Intraledger payments
      intraLedgerPaymentSend: hasApiKeyScope("write:transaction"),
      intraLedgerUsdPaymentSend: hasApiKeyScope("write:transaction"),
      
      // On-chain operations
      onChainAddressCreate: hasApiKeyScope("write:onchain"),
      onChainAddressCurrent: hasApiKeyScope("read:onchain"),
      onChainPaymentSend: hasApiKeyScope("write:onchain"),
      onChainUsdPaymentSend: hasApiKeyScope("write:onchain"),
      onChainUsdPaymentSendAsBtcDenominated: hasApiKeyScope("write:onchain"),
      onChainPaymentSendAll: hasApiKeyScope("write:onchain"),
      
      // Callback endpoints
      callbackEndpointAdd: hasApiKeyScope("write:webhook"),
      callbackEndpointDelete: hasApiKeyScope("write:webhook"),
    },
    
    Subscription: {
      // Real-time price subscription
      realtimePrice: isApiKeyAuthenticated,
      lnInvoicePaymentStatus: hasApiKeyScope("read:transaction"),
    },
  },
  {
    allowExternalErrors: true,
    fallbackRule: isApiKeyAuthenticated,
    fallbackError: "Not authorized via API key",
  },
)