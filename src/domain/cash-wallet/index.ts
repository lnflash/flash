/**
 * SMART_ROUTER: Cash Wallet Domain Implementation
 *
 * Purpose: Export constants, enums, and utility functions for the cash wallet domain.
 * This file contains the actual implementations while index.types.d.ts contains
 * the type definitions.
 *
 * Security: All exports are immutable constants or pure functions.
 * No sensitive data or mutable state should be exported.
 *
 * Dependencies:
 * - None for constants
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */

/**
 * SMART_ROUTER: Adapter Type Constants
 *
 * Purpose: Defines the types of payment adapters available in the Smart Router.
 * Each type represents a different backend source for funds.
 *
 * Security: Used for adapter validation and capability checking.
 *
 * Error Handling: N/A - const definition
 *
 * @example
 * ```typescript
 * // Check adapter type for routing decisions
 * if (adapter.type === AdapterType.CASHU) {
 *   // Handle offline-capable eCash adapter
 * }
 * ```
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */
export const AdapterType = {
  /**
   * IBEX Lightning adapter - custodial Lightning balance
   * Characteristics: Fast, reliable, requires internet
   */
  IBEX: "IBEX",

  /**
   * Cashu eCash adapter - local bearer tokens
   * Characteristics: Offline-capable, private, bearer asset risk
   */
  CASHU: "CASHU",

  /**
   * Future custodian adapters (Strike, etc.)
   * Characteristics: TBD based on integration
   */
  FUTURE: "FUTURE",
} as const

/**
 * SMART_ROUTER: Routing Strategy Constants
 *
 * Purpose: Defines different strategies for selecting payment routes.
 * Each strategy optimizes for different characteristics.
 *
 * Security: Strategy choice affects privacy and security properties.
 *
 * @example
 * ```typescript
 * // Use cheapest route for cost optimization
 * const route = await routingEngine.findRoute(amount, RoutingStrategy.CHEAPEST)
 * ```
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */
export const RoutingStrategy = {
  /**
   * Minimize total fees - may sacrifice speed or privacy
   */
  CHEAPEST: "CHEAPEST",

  /**
   * Minimize transaction time - may cost more
   */
  FASTEST: "FASTEST",

  /**
   * Maximize privacy - prefer eCash when possible
   */
  PRIVATE: "PRIVATE",

  /**
   * Automatic selection based on amount and context
   */
  AUTO: "AUTO",
} as const

/**
 * SMART_ROUTER: Route Type Constants
 *
 * Purpose: Categorizes different types of payment routes for analytics
 * and optimization.
 *
 * Security: Used for audit logging and security analysis.
 *
 * @since smart-router-v1
 * @security-review pending
 * @milestone 1
 */
export const RouteType = {
  /**
   * Payment from single adapter source
   */
  SINGLE: "SINGLE",

  /**
   * Payment split across multiple adapters
   */
  SPLIT: "SPLIT",

  /**
   * Cashu tokens swapped to Lightning
   */
  SWAP: "SWAP",
} as const
