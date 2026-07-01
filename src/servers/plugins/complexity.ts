import { GraphQLSchema } from "graphql"
import { getComplexity, ComplexityEstimator } from "graphql-query-complexity"
import type {
  ApolloServerPlugin,
  GraphQLRequestListener,
} from "apollo-server-plugin-base"

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
