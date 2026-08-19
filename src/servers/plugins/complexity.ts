import { GraphQLSchema } from "graphql"
import { getComplexity, ComplexityEstimator } from "graphql-query-complexity"
import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from "apollo-server-plugin-base"

/**
 * The complexity budget one public document may spend — the value
 * `graphql-server.ts` hands this plugin as `maximumComplexity`.
 *
 * It lives here, next to the enforcement and reachable without importing a
 * server, because it is the ceiling every `extensions.complexity` on a root
 * field is chosen AGAINST: "this read costs enough that a second copy cannot
 * fit in one document" is a statement about the PAIR, not about either number
 * alone. Hand-copied into a spec it stops being that — raising the ceiling
 * leaves the copy asserting a property that no longer holds, green the whole
 * way. Tests import this, so a change here either keeps them honest or fails
 * them.
 *
 * Scoped to the public API on purpose. `graphql-admin-server.ts` sets its own
 * ceiling for its own surface; the two happening to agree today is not a reason
 * to make one move the other.
 */
export const MAXIMUM_QUERY_COMPLEXITY = 200

interface ComplexityPluginOptions {
  schema: GraphQLSchema
  estimators: ComplexityEstimator[]
  maximumComplexity: number
  onComplete?: (complexity: number) => void
}

export function createComplexityPlugin(
  options: ComplexityPluginOptions,
): ApolloServerPlugin {
  const { schema, estimators, maximumComplexity, onComplete } = options

  return {
    async requestDidStart(): Promise<GraphQLRequestListener> {
      return {
        async didResolveOperation({ request, document }) {
          const complexity = getComplexity({
            schema,
            operationName: request.operationName ?? undefined,
            query: document,
            variables: request.variables ?? {},
            estimators,
          })

          if (onComplete) {
            onComplete(complexity)
          }

          if (complexity > maximumComplexity) {
            throw new Error(
              `Query complexity of ${complexity} exceeds maximum allowed complexity of ${maximumComplexity}`,
            )
          }
        },
      }
    },
  }
}
