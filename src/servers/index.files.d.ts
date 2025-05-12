declare class DataLoader<K, V> {
  load(key: K): Promise<V>
}

interface Loaders {
  txnMetadata: DataLoader<string, LedgerTransactionMetadata | undefined | RepositoryError>
}

type GraphQLPublicContext = {
  logger: Logger
  loaders: Loaders
  user: User | undefined
  domainAccount: Account | undefined
  ip: IpAddress | undefined
  sessionId: SessionId | undefined
  apiKey?: {
    id: string
    accountId: string
    scopes: import("@domain/api-keys").Scope[]
  }
}

type GraphQLPublicContextAuth = Omit<GraphQLPublicContext, "user" | "domainAccount"> & {
  user: User
  domainAccount: Account
}

type GraphQLAdminContext = {
  logger: Logger
  loaders: Loaders
  auditorId: UserId
  isEditor: boolean
  ip: IpAddress
}

// globally used types
type Logger = import("pino").Logger

// Extend Express namespace
declare namespace Express {
  interface Request {
    token: import("jsonwebtoken").JwtPayload
    gqlContext: GraphQLPublicContext | GraphQLAdminContext
    user?: { id: string }
    domainAccount?: { id: string }
    apiKey?: {
      id: string
      accountId: string
      scopes: import("@domain/api-keys").Scope[]
    }
  }
}
