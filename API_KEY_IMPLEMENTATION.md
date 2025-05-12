# API Key Management System Implementation Plan

This document outlines the step-by-step implementation plan for adding a secure API key authentication system to Flash.

> **Note**: This implementation plan was created as a guide. For details on the actual implementation, please refer to [API_KEY_IMPLEMENTATION_DETAILS.md](./API_KEY_IMPLEMENTATION_DETAILS.md).

## Table of Contents

1. [Overview](#overview)
2. [Database Schema](#database-schema)
3. [API Key Service](#api-key-service)
4. [Authentication Middleware](#authentication-middleware)
5. [GraphQL Integration](#graphql-integration)
6. [Rate Limiting](#rate-limiting)
7. [Logging & Monitoring](#logging--monitoring)
8. [Testing Strategy](#testing-strategy)
9. [Security Considerations](#security-considerations)
10. [Deployment Plan](#deployment-plan)
11. [Future Enhancements](#future-enhancements)

## Overview

### Architecture

The API key management system will consist of several components:

1. **Database Schema**: MongoDB collection for storing API keys
2. **API Key Service**: Business logic for key management
3. **Authentication Middleware**: Express middleware for validating API keys
4. **GraphQL Integration**: Updates to context and resolvers
5. **Rate Limiting**: Tiered rate limiting based on key type
6. **Logging & Monitoring**: Track usage and detect anomalies

### API Key Format

```
fk_{keyId}_{randomSecret}
```

Example: `fk_a1b2c3d4_e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0`

- `fk_` prefix identifies the string as a Flash API key
- `keyId` (8-char hex) is stored in the database as a non-sensitive identifier
- `randomSecret` (64-char hex) is the secure part only stored as a hash

### Scope System

API keys will use a scope-based permission system:

- `read:wallet` - Read wallet information
- `write:wallet` - Perform wallet operations
- `read:transactions` - Access transaction history
- `write:transactions` - Create transactions
- `read:user` - Access user information
- `write:user` - Update user information
- `admin` - Full access to all operations

## Database Schema

### Step 1: Create ApiKey MongoDB Schema

Create a new file: `src/services/mongoose/api-keys.ts`

```typescript
import mongoose from "mongoose";
import { v4 as uuidv4 } from "uuid";
import { createHash } from "crypto";

export enum ApiKeyScope {
  READ_WALLET = "read:wallet",
  WRITE_WALLET = "write:wallet",
  READ_TRANSACTIONS = "read:transactions",
  WRITE_TRANSACTIONS = "write:transactions",
  READ_USER = "read:user",
  WRITE_USER = "write:user",
  ADMIN = "admin",
}

export enum ApiKeyStatus {
  ACTIVE = "active",
  REVOKED = "revoked",
  EXPIRED = "expired",
}

export type ApiKeyIpConstraint = {
  allowedIps: string[];
  allowCidrs: string[];
};

// For tracking API key usage for audit logs
export type ApiKeyUsageLog = {
  timestamp: Date;
  operation: string;
  ip: string;
  userAgent: string;
  success: boolean;
  errorType?: string;
};

const apiKeySchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    keyId: {
      type: String,
      required: true,
      unique: true,
      default: () => uuidv4().replace(/-/g, "").substring(0, 8),
    },
    hashedKey: {
      type: String,
      required: true,
    },
    accountId: {
      type: String,
      ref: "Account",
      required: true,
      index: true,
    },
    scopes: {
      type: [String],
      enum: Object.values(ApiKeyScope),
      required: true,
      validate: {
        validator: function(v) {
          // Ensure scopes array is not empty
          return Array.isArray(v) && v.length > 0;
        },
        message: "API key must have at least one scope"
      }
    },
    status: {
      type: String,
      enum: Object.values(ApiKeyStatus),
      default: ApiKeyStatus.ACTIVE,
      index: true,
    },
    ipConstraints: {
      allowedIps: [String],
      allowCidrs: [String],
    },
    expiresAt: {
      type: Date,
      required: false,
      index: true,
    },
    lastUsedAt: {
      type: Date,
      required: false,
    },
    metadata: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
    createdBy: {
      type: String,
      required: true,
    },
    // Store recent usage for audit logs (most recent 50 entries)
    usageLogs: {
      type: [
        {
          timestamp: Date,
          operation: String,
          ip: String,
          userAgent: String,
          success: Boolean,
          errorType: String,
        }
      ],
      default: [],
    },
  },
  { timestamps: true }
);

// Indexes for performance
apiKeySchema.index({ keyId: 1 }, { unique: true });
apiKeySchema.index({ accountId: 1 });
apiKeySchema.index({ status: 1 });
apiKeySchema.index({ expiresAt: 1 });

// Statics
apiKeySchema.statics.hashKey = function (key: string): string {
  return createHash("sha256").update(key).digest("hex");
};

// Methods to revoke, extend, and verify keys
apiKeySchema.methods.revoke = async function () {
  this.status = ApiKeyStatus.REVOKED;
  return this.save();
};

apiKeySchema.methods.updateLastUsed = async function () {
  this.lastUsedAt = new Date();
  return this.save();
};

apiKeySchema.methods.addUsageLog = async function(log: ApiKeyUsageLog) {
  this.usageLogs.unshift({
    timestamp: log.timestamp || new Date(),
    operation: log.operation,
    ip: log.ip,
    userAgent: log.userAgent,
    success: log.success,
    errorType: log.errorType
  });
  
  // Keep only the last 50 logs
  if (this.usageLogs.length > 50) {
    this.usageLogs = this.usageLogs.slice(0, 50);
  }
  
  return this.save();
};

// Export model and types
export type ApiKey = mongoose.Document & {
  name: string;
  keyId: string;
  hashedKey: string;
  accountId: string;
  scopes: ApiKeyScope[];
  status: ApiKeyStatus;
  ipConstraints?: ApiKeyIpConstraint;
  expiresAt?: Date;
  lastUsedAt?: Date;
  metadata: Record<string, unknown>;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  usageLogs: ApiKeyUsageLog[];
  revoke: () => Promise<ApiKey>;
  updateLastUsed: () => Promise<ApiKey>;
  addUsageLog: (log: ApiKeyUsageLog) => Promise<ApiKey>;
};

export type ApiKeyModel = mongoose.Model<ApiKey> & {
  hashKey: (key: string) => string;
};

export const ApiKeyModel = mongoose.model<ApiKey, ApiKeyModel>("ApiKey", apiKeySchema);
```

### Step 2: Integrate with Mongoose Repository

Add new methods to the existing repository system:

```typescript
// src/services/mongoose/index.ts

// Add export for ApiKeyModel
export { ApiKeyModel } from "./api-keys";

// Add API key repository integration if using repository pattern
```

## API Key Service

### Step 1: Implement API Key Service

Create a new file: `src/services/api-key/index.ts`

```typescript
import { randomBytes, createHash, timingSafeEqual } from "crypto";
import { ApiKeyModel, ApiKey, ApiKeyScope, ApiKeyStatus } from "@services/mongoose/api-keys";
import { baseLogger } from "@services/logger";

const logger = baseLogger.child({ module: "api-key-service" });

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApiKeyError";
  }
}

export class EmptyScopeError extends ApiKeyError {
  constructor() {
    super("API key must have at least one scope");
    this.name = "EmptyScopeError";
  }
}

export const generateApiKey = (): { keyId: string; key: string } => {
  const keyId = randomBytes(4).toString("hex");
  const key = `fk_${keyId}_${randomBytes(32).toString("hex")}`;
  return { keyId, key };
};

export const ApiKeyService = () => {
  return {
    /**
     * Create a new API key
     */
    create: async ({
      name,
      accountId,
      scopes,
      ipConstraints,
      expiresAt,
      metadata,
      createdBy,
    }: {
      name: string;
      accountId: string;
      scopes: ApiKeyScope[];
      ipConstraints?: { allowedIps: string[]; allowCidrs: string[] };
      expiresAt?: Date;
      metadata?: Record<string, unknown>;
      createdBy: string;
    }): Promise<{ apiKey: ApiKey; key: string }> {
      // Ensure at least one scope is provided
      if (!scopes || scopes.length === 0) {
        throw new EmptyScopeError();
      }

      const { keyId, key } = generateApiKey();
      const hashedKey = ApiKeyModel.hashKey(key);

      const apiKey = new ApiKeyModel({
        name,
        keyId,
        hashedKey,
        accountId,
        scopes,
        ipConstraints,
        expiresAt,
        metadata,
        createdBy,
      });

      try {
        await apiKey.save();
        logger.info({
          message: "API key created",
          keyId,
          accountId,
          name,
        });
        return { apiKey, key };
      } catch (error) {
        logger.error({
          message: "Failed to create API key",
          error,
          accountId,
        });
        throw new ApiKeyError("Failed to create API key");
      }
    },

    /**
     * Verify an API key and check required scopes using timing-safe comparison
     */
    verify: async (key: string, requiredScopes: ApiKeyScope[] = []): Promise<ApiKey | null> => {
      if (!key) return null;

      // Extract keyId from format fk_keyId_randomBits
      const parts = key.split("_");
      if (parts.length !== 3 || parts[0] !== "fk") {
        logger.debug({ message: "Invalid API key format", key: parts[0] });
        return null;
      }
      
      const keyId = parts[1];
      const hashedKey = ApiKeyModel.hashKey(key);
      
      try {
        const apiKey = await ApiKeyModel.findOne({ 
          keyId, 
          status: ApiKeyStatus.ACTIVE 
        });

        if (!apiKey) {
          logger.debug({ message: "API key not found or inactive", keyId });
          return null;
        }

        // Use timing-safe comparison for the hashed key
        const storedHashBuffer = Buffer.from(apiKey.hashedKey, 'hex');
        const providedHashBuffer = Buffer.from(hashedKey, 'hex');
        
        // Ensure buffers are the same length
        if (storedHashBuffer.length !== providedHashBuffer.length || 
            !timingSafeEqual(storedHashBuffer, providedHashBuffer)) {
          logger.debug({ message: "API key hash mismatch", keyId });
          return null;
        }

        // Check expiry
        if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
          logger.info({
            message: "API key expired",
            keyId,
            accountId: apiKey.accountId,
          });
          
          apiKey.status = ApiKeyStatus.EXPIRED;
          await apiKey.save();
          return null;
        }

        // Check scopes
        if (requiredScopes.length > 0) {
          const hasRequiredScopes = requiredScopes.every(scope => 
            apiKey.scopes.includes(scope) || apiKey.scopes.includes(ApiKeyScope.ADMIN)
          );
          
          if (!hasRequiredScopes) {
            logger.info({
              message: "API key missing required scopes",
              keyId,
              accountId: apiKey.accountId,
              requiredScopes,
              keyScopes: apiKey.scopes,
            });
            return null;
          }
        }

        // Update last used (in background)
        apiKey.updateLastUsed().catch(error => {
          logger.error({
            message: "Failed to update lastUsedAt for API key",
            keyId,
            error,
          });
        });

        return apiKey;
      } catch (error) {
        logger.error({
          message: "Error verifying API key",
          keyId,
          error,
        });
        return null;
      }
    },

    /**
     * Revoke an API key
     */
    revoke: async (keyId: string): Promise<boolean> => {
      try {
        const apiKey = await ApiKeyModel.findOne({ keyId });
        if (!apiKey) {
          logger.warn({
            message: "Attempted to revoke non-existent API key",
            keyId,
          });
          return false;
        }
        
        apiKey.status = ApiKeyStatus.REVOKED;
        await apiKey.save();
        
        logger.info({
          message: "API key revoked",
          keyId,
          accountId: apiKey.accountId,
        });
        
        return true;
      } catch (error) {
        logger.error({
          message: "Failed to revoke API key",
          keyId,
          error,
        });
        return false;
      }
    },

    /**
     * List all API keys for an account
     */
    listForAccount: async (accountId: string): Promise<ApiKey[]> => {
      try {
        return ApiKeyModel.find({ accountId }).sort({ createdAt: -1 });
      } catch (error) {
        logger.error({
          message: "Failed to list API keys for account",
          accountId,
          error,
        });
        return [];
      }
    },
    
    /**
     * Get a specific API key by ID
     */
    getById: async (keyId: string, accountId: string): Promise<ApiKey | null> => {
      try {
        return ApiKeyModel.findOne({ keyId, accountId });
      } catch (error) {
        logger.error({
          message: "Failed to get API key",
          keyId,
          accountId,
          error,
        });
        return null;
      }
    },

    /**
     * Get audit logs for a specific API key
     */
    getAuditLogs: async (keyId: string, accountId: string): Promise<ApiKeyUsageLog[] | null> => {
      try {
        const apiKey = await ApiKeyModel.findOne({ keyId, accountId });
        if (!apiKey) {
          logger.warn({
            message: "Attempted to get logs for non-existent API key",
            keyId,
            accountId
          });
          return null;
        }
        
        return apiKey.usageLogs || [];
      } catch (error) {
        logger.error({
          message: "Failed to get API key audit logs",
          keyId,
          accountId,
          error,
        });
        return null;
      }
    },
    
    /**
     * Add a usage log entry to an API key
     */
    addUsageLog: async (keyId: string, log: ApiKeyUsageLog): Promise<boolean> => {
      try {
        const apiKey = await ApiKeyModel.findOne({ keyId });
        if (!apiKey) return false;
        
        await apiKey.addUsageLog(log);
        return true;
      } catch (error) {
        logger.error({
          message: "Failed to add usage log",
          keyId,
          error,
        });
        return false;
      }
    }
  };
};
```

### Step 2: Add IP Validation Utilities

Create a new file: `src/services/api-key/ip-validator.ts`

```typescript
import ipaddr from "ipaddr.js";
import { ApiKeyIpConstraint } from "@services/mongoose/api-keys";
import { baseLogger } from "@services/logger";

const logger = baseLogger.child({ module: "ip-validator" });

/**
 * Validate if an IP is allowed by the constraints
 */
export const validateIpConstraints = (
  ip: string,
  ipConstraints?: ApiKeyIpConstraint
): boolean => {
  // If no constraints, allow all IPs
  if (!ipConstraints || 
      (!ipConstraints.allowedIps?.length && !ipConstraints.allowCidrs?.length)) {
    return true;
  }

  // Direct IP match
  if (ipConstraints.allowedIps?.includes(ip)) {
    return true;
  }

  // CIDR match
  try {
    const addr = ipaddr.parse(ip);
    
    for (const cidr of ipConstraints.allowCidrs || []) {
      try {
        const range = ipaddr.parseCIDR(cidr);
        if (addr.match(range)) {
          return true;
        }
      } catch (error) {
        logger.warn({
          message: "Invalid CIDR notation",
          cidr,
          error,
        });
      }
    }
    
    return false;
  } catch (error) {
    logger.warn({
      message: "Invalid IP address",
      ip,
      error,
    });
    return false;
  }
};
```

## Authentication Middleware

### Step 1: Create API Key Middleware

Create a new file: `src/servers/middlewares/api-key.ts`

```typescript
import { Request, Response, NextFunction } from "express";
import { ApiKeyService } from "@services/api-key";
import { validateIpConstraints } from "@services/api-key/ip-validator";
import { baseLogger } from "@services/logger";
import { UsersRepository, AccountsRepository } from "@services/mongoose";
import { ApiKeyModel, ApiKeyScope } from "@services/mongoose/api-keys";

const logger = baseLogger.child({ module: "api-key-middleware" });

/**
 * Extract the API key from the request
 */
export const extractApiKey = (req: Request): string | null => {
  // Extract from header
  const authHeader = req.header("Authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.substring(7);
  }
  
  // Extract from query parameter (for testing only)
  if (process.env.NODE_ENV !== "production") {
    const apiKey = req.query.api_key as string;
    if (apiKey) {
      return apiKey;
    }
  }
  
  return null;
};

// Define interface extensions
declare global {
  namespace Express {
    interface Request {
      apiKey?: any;
      auth?: {
        type: string;
        keyId?: string;
        scopes?: string[];
        accountId?: string;
        [key: string]: any;
      };
    }
  }
}

/**
 * API Key authentication middleware
 */
export const apiKeyMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const key = extractApiKey(req);
  if (!key) {
    return next(); // No API key, continue to JWT auth
  }

  try {
    const apiKeyService = ApiKeyService();
    const apiKey = await apiKeyService.verify(key);
    
    if (!apiKey) {
      return next(); // Invalid key, continue to JWT auth
    }

    // Check IP constraints
    const ip = req.ip || req.socket.remoteAddress || "";
    if (!validateIpConstraints(ip, apiKey.ipConstraints)) {
      logger.warn({
        message: "API key used from unauthorized IP",
        keyId: apiKey.keyId,
        ip,
      });
      
      // Log unauthorized IP attempt
      apiKeyService.addUsageLog(apiKey.keyId, {
        timestamp: new Date(),
        operation: req.path,
        ip,
        userAgent: req.headers["user-agent"] as string || "unknown",
        success: false,
        errorType: "UNAUTHORIZED_IP"
      }).catch(error => {
        logger.error({
          message: "Failed to log unauthorized IP attempt",
          keyId: apiKey.keyId,
          error,
        });
      });
      
      return next(); // IP not allowed, continue to JWT auth
    }

    // Load associated account
    const account = await AccountsRepository().findById(apiKey.accountId);
    if (!account || account instanceof Error) {
      logger.error({
        message: "API key references non-existent account",
        keyId: apiKey.keyId,
        accountId: apiKey.accountId,
      });
      return next();
    }

    // Set API auth context
    req.auth = {
      type: "apiKey",
      keyId: apiKey.keyId,
      scopes: apiKey.scopes,
      accountId: apiKey.accountId,
    };

    // Store in req for GraphQL context building
    req.apiKey = apiKey;
    req.account = account;

    // Log successful usage
    apiKeyService.addUsageLog(apiKey.keyId, {
      timestamp: new Date(),
      operation: req.path,
      ip,
      userAgent: req.headers["user-agent"] as string || "unknown",
      success: true
    }).catch(error => {
      logger.error({
        message: "Failed to log API key usage",
        keyId: apiKey.keyId,
        error,
      });
    });

    logger.debug({
      message: "Request authenticated via API key",
      keyId: apiKey.keyId,
      accountId: apiKey.accountId,
    });

    next();
  } catch (error) {
    logger.error({
      message: "Error validating API key",
      error,
    });
    next();
  }
};
```

### Step 2: Add Error Types

Update error types file: `src/domain/errors.ts`

```typescript
// Add new API Key errors
export class ApiKeyError extends ApplicationError {
  constructor(message = "API key error") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyNotFoundError extends ApiKeyError {
  constructor(message = "API key not found") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyRevokedError extends ApiKeyError {
  constructor(message = "API key has been revoked") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyExpiredError extends ApiKeyError {
  constructor(message = "API key has expired") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyInsufficientScopeError extends ApiKeyError {
  constructor(message = "API key has insufficient scope") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyInvalidIpError extends ApiKeyError {
  constructor(message = "API key used from invalid IP") {
    super(message);
    this.name = this.constructor.name;
  }
}

export class ApiKeyEmptyScopeError extends ApiKeyError {
  constructor(message = "API key must have at least one scope") {
    super(message);
    this.name = this.constructor.name;
  }
}
```

## GraphQL Integration

### Step 1: Update GraphQL Context Types

Update types file: `src/graphql/index.types.d.ts`

```typescript
import { ApiKey, ApiKeyScope } from "@services/mongoose/api-keys";

// Add to existing context types
export interface ApiKeyAuth {
  type: "apiKey";
  keyId: string;
  scopes: ApiKeyScope[];
  accountId: string;
}

// Update existing context type
export type GraphQLPublicContext = {
  // Existing properties
  auth?: JwtAuth | ApiKeyAuth;
  apiKey?: ApiKey;
  // ...
};
```

### Step 2: Update GraphQL Context Builder

Update server file: `src/servers/graphql-server.ts`

```typescript
// Add to existing context builder function
export const setGqlContext = async (
  req: Request,
  res: Response,
  connectionParams?: unknown
): Promise<GraphQLPublicContext> => {
  // Existing context building logic...

  // Add API key context if present
  if (req.apiKey && req.account) {
    return {
      // ...existing context properties
      auth: {
        type: "apiKey",
        keyId: req.apiKey.keyId,
        scopes: req.apiKey.scopes,
        accountId: req.apiKey.accountId,
      },
      apiKey: req.apiKey,
      account: req.account,
      // ...other properties
    };
  }

  // Existing JWT logic...
};
```

### Step 3: Add GraphQL Shield Rules

Update or create file: `src/graphql/shield/rules.ts`

```typescript
import { rule } from "graphql-shield";
import { GraphQLPublicContext, ApiKeyAuth } from "@graphql/index.types";
import { ApiKeyScope } from "@services/mongoose/api-keys";

// Existing rule
export const isAuthenticated = rule({ cache: "contextual" })(
  async (parent, args, ctx: GraphQLPublicContext) => {
    return Boolean(ctx.auth) || "Not authenticated";
  }
);

// API key specific rules
export const hasApiScope = (scope: ApiKeyScope) =>
  rule({ cache: "contextual" })(
    async (parent, args, ctx: GraphQLPublicContext) => {
      if (!ctx.auth) return "Not authenticated";
      
      if (ctx.auth.type === "apiKey") {
        const apiAuth = ctx.auth as ApiKeyAuth;
        return (
          apiAuth.scopes.includes(scope) || 
          apiAuth.scopes.includes(ApiKeyScope.ADMIN)
        ) || `Missing required scope: ${scope}`;
      }
      
      // For JWT auth, we trust the authentication mechanism
      return true;
    }
  );

// Combined rule for either JWT or API key with scope
export const hasAccess = (scope: ApiKeyScope) =>
  rule({ cache: "contextual" })(
    async (parent, args, ctx: GraphQLPublicContext) => {
      // JWT is always permitted (assuming it's authorized)
      if (ctx.auth && ctx.auth.type !== "apiKey") {
        return true;
      }
      
      // Otherwise check API key scope
      return hasApiScope(scope)(parent, args, ctx);
    }
  );
```

### Step 4: Add GraphQL Schema for API Key Management

Update file: `src/graphql/admin/schema.graphql`

```graphql
# API Key Management Types
type ApiKey {
  id: ID!
  name: String!
  keyId: String!
  scopes: [String!]!
  status: ApiKeyStatus!
  ipConstraints: ApiKeyIpConstraints
  expiresAt: DateTime
  lastUsedAt: DateTime
  createdAt: DateTime!
  updatedAt: DateTime!
  metadata: JSON
}

type ApiKeyWithSecret {
  apiKey: ApiKey!
  secret: String!
}

enum ApiKeyStatus {
  ACTIVE
  REVOKED
  EXPIRED
}

input ApiKeyIpConstraintsInput {
  allowedIps: [String!]
  allowCidrs: [String!]
}

type ApiKeyIpConstraints {
  allowedIps: [String!]!
  allowCidrs: [String!]!
}

type ApiKeyUsageLog {
  timestamp: DateTime!
  operation: String!
  ip: String!
  userAgent: String
  success: Boolean!
  errorType: String
}

# Add to existing Query type
extend type Query {
  apiKeys: [ApiKey!]!
  apiKey(id: ID!): ApiKey
  apiKeyAuditLogs(keyId: ID!, limit: Int, offset: Int): [ApiKeyUsageLog!]!
}

# Add to existing Mutation type
extend type Mutation {
  createApiKey(
    name: String!
    scopes: [String!]!
    ipConstraints: ApiKeyIpConstraintsInput
    expiresAt: DateTime
    metadata: JSON
  ): ApiKeyWithSecret!
  
  revokeApiKey(keyId: String!): Boolean!
  
  rotateApiKey(keyId: String!): ApiKeyWithSecret!
}
```

### Step 5: Implement GraphQL Resolvers

Create file: `src/graphql/admin/root/api-keys.ts`

```typescript
import { ApiKeyService } from "@services/api-key";
import { ApiKeyModel, ApiKeyScope } from "@services/mongoose/api-keys";
import { GraphQLAdminContext } from "@graphql/index.types";
import { baseLogger } from "@services/logger";

const logger = baseLogger.child({ module: "api-key-resolvers" });

/**
 * Query all API keys for the authenticated account
 */
export const apiKeysQuery = async (
  _: unknown,
  __: unknown,
  { account }: GraphQLAdminContext
) => {
  if (!account) throw new Error("Not authenticated");
  
  const apiKeyService = ApiKeyService();
  return apiKeyService.listForAccount(account.id);
};

/**
 * Query a specific API key by ID
 */
export const apiKeyQuery = async (
  _: unknown,
  { id }: { id: string },
  { account }: GraphQLAdminContext
) => {
  if (!account) throw new Error("Not authenticated");
  
  const apiKey = await ApiKeyModel.findOne({ 
    keyId: id, 
    accountId: account.id 
  });
  
  return apiKey;
};

/**
 * Query audit logs for a specific API key
 */
export const apiKeyAuditLogsQuery = async (
  _: unknown,
  { keyId, limit = 50, offset = 0 }: { keyId: string; limit?: number; offset?: number },
  { account }: GraphQLAdminContext
) => {
  if (!account) throw new Error("Not authenticated");
  
  const apiKeyService = ApiKeyService();
  const logs = await apiKeyService.getAuditLogs(keyId, account.id);
  
  if (!logs) throw new Error("API key not found");
  
  // Apply pagination
  return logs.slice(offset, offset + limit);
};

/**
 * Create a new API key
 */
export const createApiKeyMutation = async (
  _: unknown,
  {
    name,
    scopes,
    ipConstraints,
    expiresAt,
    metadata,
  }: {
    name: string;
    scopes: string[];
    ipConstraints?: { allowedIps: string[]; allowCidrs: string[] };
    expiresAt?: Date;
    metadata?: Record<string, unknown>;
  },
  { account, user }: GraphQLAdminContext
) => {
  if (!account || !user) throw new Error("Not authenticated");
  
  // Validate scopes
  const validScopes = scopes.filter(scope => 
    Object.values(ApiKeyScope).includes(scope as ApiKeyScope)
  );
  
  if (validScopes.length !== scopes.length) {
    logger.warn({
      message: "Invalid scope provided in createApiKey",
      providedScopes: scopes, 
      validScopes
    });
    throw new Error("Invalid scope provided");
  }
  
  // Ensure at least one scope is provided
  if (validScopes.length === 0) {
    throw new Error("API key must have at least one scope");
  }
  
  const apiKeyService = ApiKeyService();
  const { apiKey, key } = await apiKeyService.create({
    name,
    accountId: account.id,
    scopes: validScopes as ApiKeyScope[],
    ipConstraints,
    expiresAt,
    metadata,
    createdBy: user.id,
  });
  
  return {
    apiKey,
    secret: key,
  };
};

/**
 * Revoke an API key
 */
export const revokeApiKeyMutation = async (
  _: unknown,
  { keyId }: { keyId: string },
  { account }: GraphQLAdminContext
) => {
  if (!account) throw new Error("Not authenticated");
  
  const apiKeyService = ApiKeyService();
  const apiKey = await ApiKeyModel.findOne({ 
    keyId, 
    accountId: account.id 
  });
  
  if (!apiKey) {
    logger.warn({
      message: "Attempted to revoke non-existent API key",
      keyId,
      accountId: account.id,
    });
    throw new Error("API key not found");
  }
  
  return apiKeyService.revoke(keyId);
};

/**
 * Rotate an API key (revoke existing and create new)
 */
export const rotateApiKeyMutation = async (
  _: unknown,
  { keyId }: { keyId: string },
  { account, user }: GraphQLAdminContext
) => {
  if (!account || !user) throw new Error("Not authenticated");
  
  const apiKey = await ApiKeyModel.findOne({ 
    keyId, 
    accountId: account.id 
  });
  
  if (!apiKey) {
    logger.warn({
      message: "Attempted to rotate non-existent API key",
      keyId,
      accountId: account.id,
    });
    throw new Error("API key not found");
  }
  
  // Revoke the old key
  const apiKeyService = ApiKeyService();
  await apiKeyService.revoke(keyId);
  
  // Create a new key with the same properties
  const { apiKey: newApiKey, key } = await apiKeyService.create({
    name: `${apiKey.name} (rotated)`,
    accountId: account.id,
    scopes: apiKey.scopes,
    ipConstraints: apiKey.ipConstraints,
    expiresAt: apiKey.expiresAt,
    metadata: { 
      ...apiKey.metadata,
      rotatedFrom: keyId,
      rotationDate: new Date()
    },
    createdBy: user.id,
  });
  
  return {
    apiKey: newApiKey,
    secret: key,
  };
};
```

### Step 6: Register Resolvers

Update file: `src/graphql/admin/root/index.ts`

```typescript
// Import the resolver functions
import { 
  apiKeysQuery,
  apiKeyQuery,
  apiKeyAuditLogsQuery,
  createApiKeyMutation,
  revokeApiKeyMutation,
  rotateApiKeyMutation,
} from "./api-keys";

// Add to resolvers
export const resolvers = {
  Query: {
    // Existing queries
    apiKeys: apiKeysQuery,
    apiKey: apiKeyQuery,
    apiKeyAuditLogs: apiKeyAuditLogsQuery,
  },
  Mutation: {
    // Existing mutations
    createApiKey: createApiKeyMutation,
    revokeApiKey: revokeApiKeyMutation,
    rotateApiKey: rotateApiKeyMutation,
  },
  // Type resolvers if needed
  ApiKey: {
    id: (apiKey) => apiKey._id.toString(),
  },
};
```

## Rate Limiting

### Step 1: Implement API Key Rate Limiting

Create file: `src/services/rate-limit/api-key-limiter.ts`

```typescript
import { RateLimiterRedis } from "rate-limiter-flexible";
import { redis } from "@services/redis/connection";
import { baseLogger } from "@services/logger";
import { Request, Response, NextFunction } from "express";
import { ApiKeyService } from "@services/api-key";

const logger = baseLogger.child({ module: "api-key-rate-limiter" });

// Different tiers of rate limiting
export const RATE_LIMIT_TIERS = {
  DEFAULT: {
    points: 100,    // 100 requests
    duration: 60,   // per minute
  },
  PREMIUM: {
    points: 600,    // 600 requests
    duration: 60,   // per minute
  },
  ENTERPRISE: {
    points: 3000,   // 3000 requests
    duration: 60,   // per minute
  },
  UNLIMITED: {
    points: 10000,  // Very high limit
    duration: 60,   // per minute
  },
};

// Create limiter instances
const limiters = {
  DEFAULT: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rate_limit_api_key_default",
    points: RATE_LIMIT_TIERS.DEFAULT.points,
    duration: RATE_LIMIT_TIERS.DEFAULT.duration,
  }),
  PREMIUM: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rate_limit_api_key_premium",
    points: RATE_LIMIT_TIERS.PREMIUM.points,
    duration: RATE_LIMIT_TIERS.PREMIUM.duration,
  }),
  ENTERPRISE: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rate_limit_api_key_enterprise",
    points: RATE_LIMIT_TIERS.ENTERPRISE.points,
    duration: RATE_LIMIT_TIERS.ENTERPRISE.duration,
  }),
  UNLIMITED: new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: "rate_limit_api_key_unlimited",
    points: RATE_LIMIT_TIERS.UNLIMITED.points,
    duration: RATE_LIMIT_TIERS.UNLIMITED.duration,
  }),
};

/**
 * Check rate limits for an API key
 */
export const apiKeyRateLimiter = async (
  keyId: string,
  tier: keyof typeof RATE_LIMIT_TIERS = "DEFAULT"
): Promise<{ limited: boolean; remainingPoints: number }> => {
  const limiter = limiters[tier] || limiters.DEFAULT;
  
  try {
    const rateLimitResult = await limiter.consume(keyId);
    return {
      limited: false,
      remainingPoints: rateLimitResult.remainingPoints,
    };
  } catch (rateLimitError: any) {
    logger.warn({
      message: "API key rate limited",
      keyId,
      tier,
      msBeforeNext: rateLimitError.msBeforeNext,
    });
    
    return {
      limited: true,
      remainingPoints: 0,
    };
  }
};

/**
 * Express middleware for API key rate limiting
 */
export const apiKeyRateLimitMiddleware = async (
  req: Request, 
  res: Response, 
  next: NextFunction
) => {
  if (!req.apiKey) {
    return next();
  }
  
  const tier = (req.apiKey.metadata?.tier as keyof typeof RATE_LIMIT_TIERS) || "DEFAULT";
  const { limited, remainingPoints } = await apiKeyRateLimiter(req.apiKey.keyId, tier);
  
  // Add headers for client rate limit tracking
  res.setHeader("X-RateLimit-Limit", RATE_LIMIT_TIERS[tier].points);
  res.setHeader("X-RateLimit-Remaining", remainingPoints);
  res.setHeader("X-RateLimit-Reset", Math.floor(Date.now() / 1000) + RATE_LIMIT_TIERS[tier].duration);
  
  if (limited) {
    // Log rate limit in API key usage logs
    const apiKeyService = ApiKeyService();
    apiKeyService.addUsageLog(req.apiKey.keyId, {
      timestamp: new Date(),
      operation: req.path,
      ip: req.ip || req.socket.remoteAddress || "unknown",
      userAgent: req.headers["user-agent"] as string || "unknown",
      success: false,
      errorType: "RATE_LIMIT_EXCEEDED"
    }).catch(error => {
      logger.error({
        message: "Failed to log rate limit exceeded",
        keyId: req.apiKey.keyId,
        error,
      });
    });
    
    return res.status(429).json({
      error: "Too Many Requests",
      message: "API rate limit exceeded",
      details: {
        tier,
        limit: RATE_LIMIT_TIERS[tier].points,
        windowSeconds: RATE_LIMIT_TIERS[tier].duration,
      },
    });
  }
  
  next();
};
```

### Step 2: Add Per-Endpoint Rate Limiting

Update existing rate limit service: `src/services/rate-limit/index.ts`

```typescript
// Add method to check endpoint-specific limits
export const checkEndpointLimit = async ({
  apiKeyId,
  endpoint,
  points = 1,
}: {
  apiKeyId: string;
  endpoint: string;
  points?: number;
}): Promise<RateLimitResult> => {
  const limiter = new RateLimiterRedis({
    storeClient: redis,
    keyPrefix: `endpoint_${endpoint}`,
    points: 50, // Default per endpoint
    duration: 60,
  });
  
  const key = `apikey_${apiKeyId}`;
  
  try {
    const rateLimitResult = await limiter.consume(key, points);
    return {
      limited: false,
      remainingPoints: rateLimitResult.remainingPoints,
    };
  } catch (error) {
    return {
      limited: true,
      remainingPoints: 0,
    };
  }
};
```

## Logging & Monitoring

### Step 1: Set Up API Key Usage Logging

Create file: `src/services/api-key/logging.ts`

```typescript
import { baseLogger } from "@services/logger";
import { ApiKey } from "@services/mongoose/api-keys";
import { ApiKeyModel } from "@services/mongoose/api-keys";
import { promClient } from "@services/prometheus";

const logger = baseLogger.child({ module: "api-key-logging" });

// Create Prometheus metrics
const apiKeyUsageCounter = new promClient.Counter({
  name: "api_key_usage_total",
  help: "Count of API key usage",
  labelNames: ["keyId", "accountId", "operation"],
});

const apiKeyRateLimitCounter = new promClient.Counter({
  name: "api_key_rate_limit_total",
  help: "Count of API key rate limit hits",
  labelNames: ["keyId", "accountId", "tier"],
});

const apiKeyErrorCounter = new promClient.Counter({
  name: "api_key_error_total",
  help: "Count of API key errors",
  labelNames: ["keyId", "accountId", "error_type"],
});

/**
 * Log API key usage
 */
export const logApiKeyUsage = (
  apiKey: ApiKey,
  operation: string,
  metadata: Record<string, unknown> = {}
) => {
  logger.info({
    message: "API key usage",
    keyId: apiKey.keyId,
    accountId: apiKey.accountId,
    operation,
    ...metadata,
  });
  
  apiKeyUsageCounter.inc({
    keyId: apiKey.keyId,
    accountId: apiKey.accountId,
    operation,
  });
};

/**
 * Log API key administrative actions
 */
export const logApiKeyAdmin = (
  apiKey: ApiKey,
  action: "create" | "revoke" | "rotate",
  adminId: string,
  metadata: Record<string, unknown> = {}
) => {
  logger.info({
    message: `API key ${action}d`,
    keyId: apiKey.keyId,
    accountId: apiKey.accountId,
    adminId,
    ...metadata,
  });
};

/**
 * Log API key rate limit events
 */
export const logApiKeyRateLimit = (
  apiKey: ApiKey,
  tier: string,
  endpoint?: string
) => {
  logger.warn({
    message: "API key rate limited",
    keyId: apiKey.keyId,
    accountId: apiKey.accountId,
    tier,
    endpoint,
  });
  
  apiKeyRateLimitCounter.inc({
    keyId: apiKey.keyId,
    accountId: apiKey.accountId,
    tier,
  });
};

/**
 * Monitor for suspicious API key activity
 */
export const monitorApiKeyUsage = async (
  apiKey: ApiKey,
  ip: string,
  userAgent: string
) => {
  // Log suspicious activity (new IP, unusual pattern, etc)
  const isNewIp = !apiKey.metadata?.knownIps?.includes(ip);
  
  if (isNewIp) {
    logger.warn({
      message: "API key used from new IP",
      keyId: apiKey.keyId,
      accountId: apiKey.accountId,
      ip,
      userAgent,
    });
    
    // Update known IPs (in background)
    ApiKeyModel.updateOne(
      { _id: apiKey._id },
      { $addToSet: { "metadata.knownIps": ip } }
    ).catch(error => {
      logger.error({
        message: "Failed to update known IPs",
        keyId: apiKey.keyId,
        error,
      });
    });
  }
};

/**
 * Log API key errors
 */
export const logApiKeyError = (
  keyId: string,
  accountId: string,
  errorType: string,
  error: any
) => {
  logger.error({
    message: `API key error: ${errorType}`,
    keyId,
    accountId,
    error,
  });
  
  apiKeyErrorCounter.inc({
    keyId,
    accountId,
    error_type: errorType,
  });
};
```

### Step 2: Create GraphQL Plugin for Logging API Key Usage

Create file: `src/graphql/plugins/api-key-logging.ts`

```typescript
import { ApolloServerPlugin } from "apollo-server-core";
import { GraphQLPublicContext } from "@graphql/index.types";
import { logApiKeyUsage, monitorApiKeyUsage } from "@services/api-key/logging";
import { ApiKeyService } from "@services/api-key";

/**
 * Apollo plugin to track API key usage in GraphQL operations
 */
export const apiKeyLoggingPlugin = (): ApolloServerPlugin<GraphQLPublicContext> => {
  return {
    async requestDidStart(ctx) {
      return {
        async didResolveOperation(requestContext) {
          const { context, request, operation } = requestContext;
          
          // Only log for API key authentication
          if (context.auth?.type === "apiKey" && context.apiKey) {
            // Get operation name and type
            const operationType = operation?.operation || "unknown";
            const operationName = request.operationName || "anonymous";
            const operationId = `${operationType}:${operationName}`;
            
            // Log the API key usage
            logApiKeyUsage(
              context.apiKey, 
              operationId,
              {
                operation: operationName,
                type: operationType,
              }
            );
            
            // Add usage log
            const apiKeyService = ApiKeyService();
            apiKeyService.addUsageLog(context.apiKey.keyId, {
              timestamp: new Date(),
              operation: operationId,
              ip: context.req?.ip || "unknown",
              userAgent: context.req?.headers["user-agent"] || "unknown",
              success: true
            }).catch(console.error);
            
            // Monitor for suspicious activity
            const ip = context.req?.ip || "unknown";
            const userAgent = context.req?.headers["user-agent"] || "unknown";
            monitorApiKeyUsage(context.apiKey, ip, userAgent).catch(console.error);
          }
        },
        
        async didEncounterErrors(requestContext) {
          const { context, errors } = requestContext;
          
          // Only log for API key authentication
          if (context.auth?.type === "apiKey" && context.apiKey) {
            // Log API key errors
            const apiKeyService = ApiKeyService();
            apiKeyService.addUsageLog(context.apiKey.keyId, {
              timestamp: new Date(),
              operation: requestContext.request.operationName || "anonymous",
              ip: context.req?.ip || "unknown",
              userAgent: context.req?.headers["user-agent"] || "unknown",
              success: false,
              errorType: errors[0]?.message || "GRAPHQL_ERROR"
            }).catch(console.error);
          }
        }
      };
    },
  };
};
```

## Testing Strategy

### Step 1: Create Unit Tests for API Key Service

Create file: `test/flash/unit/services/api-key.spec.ts`

```typescript
import { ApiKeyService, generateApiKey } from "@services/api-key";
import { ApiKeyModel, ApiKeyScope, ApiKeyStatus } from "@services/mongoose/api-keys";
import { validateIpConstraints } from "@services/api-key/ip-validator";
import { timingSafeEqual } from "crypto";
import mongoose from "mongoose";

// Mock crypto for timing-safe comparison
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  timingSafeEqual: jest.fn().mockImplementation((a, b) => a.toString() === b.toString()),
  createHash: jest.fn().mockImplementation(() => ({
    update: jest.fn().mockReturnThis(),
    digest: jest.fn().mockReturnValue('hashed_value')
  }))
}));

// Mock the ApiKeyModel
jest.mock("@services/mongoose/api-keys", () => ({
  ApiKeyModel: {
    hashKey: jest.fn((key) => `hashed_${key}`),
    findOne: jest.fn(),
    find: jest.fn(),
  },
  ApiKeyScope: {
    READ_WALLET: "read:wallet",
    WRITE_WALLET: "write:wallet",
    ADMIN: "admin",
  },
  ApiKeyStatus: {
    ACTIVE: "active",
    REVOKED: "revoked",
    EXPIRED: "expired",
  },
}));

describe("API Key Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("generateApiKey", () => {
    it("should generate a key in the correct format", () => {
      const { keyId, key } = generateApiKey();
      
      expect(keyId).toBeDefined();
      expect(keyId.length).toBe(8);
      
      const parts = key.split("_");
      expect(parts.length).toBe(3);
      expect(parts[0]).toBe("fk");
      expect(parts[1]).toBe(keyId);
      expect(parts[2].length).toBe(64); // 32 bytes = 64 hex chars
    });
  });

  describe("verify", () => {
    it("should return null for invalid key format", async () => {
      const apiKeyService = ApiKeyService();
      const result = await apiKeyService.verify("invalid-key");
      
      expect(result).toBeNull();
      expect(ApiKeyModel.findOne).not.toHaveBeenCalled();
    });

    it("should verify a valid key using timing-safe comparison", async () => {
      const mockApiKey = {
        keyId: "12345678",
        hashedKey: "hashed_fk_12345678_secret",
        accountId: "account123",
        scopes: [ApiKeyScope.READ_WALLET],
        status: ApiKeyStatus.ACTIVE,
        updateLastUsed: jest.fn().mockResolvedValue({}),
      };
      
      (ApiKeyModel.findOne as jest.Mock).mockResolvedValue(mockApiKey);
      
      const apiKeyService = ApiKeyService();
      const result = await apiKeyService.verify("fk_12345678_secret");
      
      expect(result).toBe(mockApiKey);
      expect(ApiKeyModel.hashKey).toHaveBeenCalledWith("fk_12345678_secret");
      expect(ApiKeyModel.findOne).toHaveBeenCalledWith({
        keyId: "12345678",
        status: ApiKeyStatus.ACTIVE,
      });
      
      // Verify timing-safe comparison is used
      expect(timingSafeEqual).toHaveBeenCalled();
      expect(mockApiKey.updateLastUsed).toHaveBeenCalled();
    });

    it("should check required scopes", async () => {
      const mockApiKey = {
        keyId: "12345678",
        hashedKey: "hashed_fk_12345678_secret",
        accountId: "account123",
        scopes: [ApiKeyScope.READ_WALLET],
        status: ApiKeyStatus.ACTIVE,
        updateLastUsed: jest.fn().mockResolvedValue({}),
      };
      
      (ApiKeyModel.findOne as jest.Mock).mockResolvedValue(mockApiKey);
      (timingSafeEqual as jest.Mock).mockReturnValue(true);
      
      const apiKeyService = ApiKeyService();
      
      // Should pass with matching scope
      let result = await apiKeyService.verify(
        "fk_12345678_secret", 
        [ApiKeyScope.READ_WALLET]
      );
      expect(result).toBe(mockApiKey);
      
      // Should fail with non-matching scope
      result = await apiKeyService.verify(
        "fk_12345678_secret", 
        [ApiKeyScope.WRITE_WALLET]
      );
      expect(result).toBeNull();
      
      // Should pass with admin scope
      mockApiKey.scopes = [ApiKeyScope.ADMIN];
      result = await apiKeyService.verify(
        "fk_12345678_secret", 
        [ApiKeyScope.WRITE_WALLET]
      );
      expect(result).toBe(mockApiKey);
    });
  });

  describe("create", () => {
    it("should enforce at least one scope", async () => {
      const apiKeyService = ApiKeyService();
      
      await expect(apiKeyService.create({
        name: "Test Key",
        accountId: "account123",
        scopes: [],
        createdBy: "user123"
      })).rejects.toThrow("API key must have at least one scope");
    });
    
    // Add more tests for create, revoke, etc.
  });
});

describe("IP Validation", () => {
  it("should validate IP constraints correctly", () => {
    // No constraints - allow all
    expect(validateIpConstraints("192.168.1.1")).toBe(true);
    
    // Direct IP match
    expect(validateIpConstraints(
      "192.168.1.1", 
      { allowedIps: ["192.168.1.1"], allowCidrs: [] }
    )).toBe(true);
    
    // Direct IP mismatch
    expect(validateIpConstraints(
      "192.168.1.2", 
      { allowedIps: ["192.168.1.1"], allowCidrs: [] }
    )).toBe(false);
    
    // CIDR match
    expect(validateIpConstraints(
      "192.168.1.5", 
      { allowedIps: [], allowCidrs: ["192.168.1.0/24"] }
    )).toBe(true);
    
    // CIDR mismatch
    expect(validateIpConstraints(
      "192.168.2.5", 
      { allowedIps: [], allowCidrs: ["192.168.1.0/24"] }
    )).toBe(false);
    
    // Mixed constraints - match IP
    expect(validateIpConstraints(
      "192.168.1.1", 
      { allowedIps: ["192.168.1.1"], allowCidrs: ["10.0.0.0/8"] }
    )).toBe(true);
    
    // Mixed constraints - match CIDR
    expect(validateIpConstraints(
      "10.1.2.3", 
      { allowedIps: ["192.168.1.1"], allowCidrs: ["10.0.0.0/8"] }
    )).toBe(true);
    
    // Mixed constraints - no match
    expect(validateIpConstraints(
      "172.16.1.1", 
      { allowedIps: ["192.168.1.1"], allowCidrs: ["10.0.0.0/8"] }
    )).toBe(false);
  });
});
```

### Step 2: Create Integration Tests

Create file: `test/flash/integration/api-key.spec.ts`

```typescript
import { ApiKeyModel, ApiKeyScope } from "@services/mongoose/api-keys";
import { ApiKeyService } from "@services/api-key";
import mongoose from "mongoose";
import { AccountsRepository } from "@services/mongoose";

describe("API Key Integration", () => {
  let testApiKey;
  let testKey;
  let testAccountId;

  beforeAll(async () => {
    // Create a test account
    const testAccount = await AccountsRepository().create({
      // Account properties as needed for testing
    });
    testAccountId = testAccount.id;
  });

  afterAll(async () => {
    // Clean up test data
    await ApiKeyModel.deleteMany({ accountId: testAccountId });
    await AccountsRepository().removeById(testAccountId);
  });

  it("should create an API key", async () => {
    const apiKeyService = ApiKeyService();
    
    const { apiKey, key } = await apiKeyService.create({
      name: "Test Key",
      accountId: testAccountId,
      scopes: [ApiKeyScope.READ_WALLET],
      createdBy: "test",
    });
    
    testApiKey = apiKey;
    testKey = key;
    
    expect(apiKey.name).toBe("Test Key");
    expect(apiKey.accountId).toBe(testAccountId);
    expect(apiKey.scopes).toContain(ApiKeyScope.READ_WALLET);
    expect(key).toMatch(/^fk_[a-f0-9]{8}_[a-f0-9]{64}$/);
  });

  it("should verify the created API key", async () => {
    const apiKeyService = ApiKeyService();
    const verifiedKey = await apiKeyService.verify(testKey);
    
    expect(verifiedKey).not.toBeNull();
    expect(verifiedKey?.keyId).toBe(testApiKey.keyId);
  });

  it("should reject empty scope arrays", async () => {
    const apiKeyService = ApiKeyService();
    
    await expect(apiKeyService.create({
      name: "Empty Scope Key",
      accountId: testAccountId,
      scopes: [],
      createdBy: "test",
    })).rejects.toThrow(/API key must have at least one scope/);
  });

  it("should add and retrieve usage logs", async () => {
    const apiKeyService = ApiKeyService();
    
    // Add a usage log
    await apiKeyService.addUsageLog(testApiKey.keyId, {
      timestamp: new Date(),
      operation: "test:operation",
      ip: "127.0.0.1",
      userAgent: "test-agent",
      success: true
    });
    
    // Get the logs
    const logs = await apiKeyService.getAuditLogs(testApiKey.keyId, testAccountId);
    
    expect(logs).toBeDefined();
    expect(logs?.length).toBeGreaterThan(0);
    expect(logs?.[0].operation).toBe("test:operation");
    expect(logs?.[0].ip).toBe("127.0.0.1");
    expect(logs?.[0].success).toBe(true);
  });

  it("should revoke an API key", async () => {
    const apiKeyService = ApiKeyService();
    const result = await apiKeyService.revoke(testApiKey.keyId);
    
    expect(result).toBe(true);
    
    // Verify key no longer works
    const verifiedKey = await apiKeyService.verify(testKey);
    expect(verifiedKey).toBeNull();
  });

  it("should list keys for an account", async () => {
    const apiKeyService = ApiKeyService();
    
    // Create a few more keys
    await apiKeyService.create({
      name: "Test Key 2",
      accountId: testAccountId,
      scopes: [ApiKeyScope.READ_WALLET],
      createdBy: "test",
    });
    
    await apiKeyService.create({
      name: "Test Key 3",
      accountId: testAccountId,
      scopes: [ApiKeyScope.WRITE_WALLET],
      createdBy: "test",
    });
    
    const keys = await apiKeyService.listForAccount(testAccountId);
    
    expect(keys.length).toBe(3); // Including the revoked one
    expect(keys[0].name).toBe("Test Key 3");
    expect(keys[1].name).toBe("Test Key 2");
    expect(keys[2].name).toBe("Test Key");
  });
});
```

### Step 3: Create API E2E Tests

Create file: `test/flash/e2e/api-key.spec.ts`

```typescript
import { gql } from "@apollo/client";
import { client } from "../helpers";
import { ApiKeyScope } from "@services/mongoose/api-keys";

// Test queries
const CREATE_API_KEY = gql`
  mutation CreateApiKey($input: CreateApiKeyInput!) {
    createApiKey(input: $input) {
      apiKey {
        keyId
        name
        scopes
        status
      }
      secret
    }
  }
`;

const LIST_API_KEYS = gql`
  query ApiKeys {
    apiKeys {
      keyId
      name
      scopes
      status
      createdAt
    }
  }
`;

const REVOKE_API_KEY = gql`
  mutation RevokeApiKey($keyId: String!) {
    revokeApiKey(keyId: $keyId)
  }
`;

const API_KEY_AUDIT_LOGS = gql`
  query ApiKeyAuditLogs($keyId: ID!, $limit: Int, $offset: Int) {
    apiKeyAuditLogs(keyId: $keyId, limit: $limit, offset: $offset) {
      timestamp
      operation
      ip
      userAgent
      success
      errorType
    }
  }
`;

describe("API Key GraphQL", () => {
  let testApiKey;
  let testSecret;

  it("should create an API key", async () => {
    const { data } = await client.mutate({
      mutation: CREATE_API_KEY,
      variables: {
        input: {
          name: "E2E Test Key",
          scopes: [ApiKeyScope.READ_WALLET, ApiKeyScope.READ_TRANSACTIONS],
        },
      },
    });
    
    testApiKey = data.createApiKey.apiKey;
    testSecret = data.createApiKey.secret;
    
    expect(testApiKey.name).toBe("E2E Test Key");
    expect(testApiKey.scopes).toContain(ApiKeyScope.READ_WALLET);
    expect(testApiKey.scopes).toContain(ApiKeyScope.READ_TRANSACTIONS);
    expect(testApiKey.status).toBe("ACTIVE");
    expect(testSecret).toMatch(/^fk_[a-f0-9]{8}_[a-f0-9]{64}$/);
  });

  it("should reject empty scope arrays", async () => {
    try {
      await client.mutate({
        mutation: CREATE_API_KEY,
        variables: {
          input: {
            name: "Empty Scope Key",
            scopes: [],
          },
        },
      });
      fail("Should have thrown an error");
    } catch (error) {
      expect(error.message).toContain("API key must have at least one scope");
    }
  });

  it("should list API keys", async () => {
    const { data } = await client.query({
      query: LIST_API_KEYS,
    });
    
    const apiKeys = data.apiKeys;
    expect(apiKeys.length).toBeGreaterThan(0);
    
    const createdKey = apiKeys.find(k => k.keyId === testApiKey.keyId);
    expect(createdKey).toBeDefined();
    expect(createdKey.name).toBe("E2E Test Key");
  });

  it("should authenticate using the API key", async () => {
    // Create a new Apollo client with the API key
    const apiKeyClient = client.createNew({
      headers: {
        Authorization: `Bearer ${testSecret}`,
      },
    });
    
    // Try a query that requires authentication
    const { data } = await apiKeyClient.query({
      query: gql`
        query CurrentAccount {
          me {
            id
            username
          }
        }
      `,
    });
    
    expect(data.me).toBeDefined();
  });

  it("should fetch audit logs for an API key", async () => {
    // First, make some authenticated requests to generate logs
    const apiKeyClient = client.createNew({
      headers: {
        Authorization: `Bearer ${testSecret}`,
      },
    });
    
    await apiKeyClient.query({
      query: gql`
        query TestQuery {
          me { id }
        }
      `,
    });
    
    // Now fetch the audit logs
    const { data } = await client.query({
      query: API_KEY_AUDIT_LOGS,
      variables: {
        keyId: testApiKey.keyId,
        limit: 10
      },
    });
    
    expect(data.apiKeyAuditLogs).toBeDefined();
    expect(data.apiKeyAuditLogs.length).toBeGreaterThan(0);
    
    const log = data.apiKeyAuditLogs[0];
    expect(log.timestamp).toBeDefined();
    expect(log.operation).toBeDefined();
    expect(log.ip).toBeDefined();
    expect(log.success).toBe(true);
  });

  it("should revoke an API key", async () => {
    const { data } = await client.mutate({
      mutation: REVOKE_API_KEY,
      variables: {
        keyId: testApiKey.keyId,
      },
    });
    
    expect(data.revokeApiKey).toBe(true);
    
    // Check the key is now revoked
    const { data: listData } = await client.query({
      query: LIST_API_KEYS,
    });
    
    const revokedKey = listData.apiKeys.find(k => k.keyId === testApiKey.keyId);
    expect(revokedKey.status).toBe("REVOKED");
    
    // Verify the key no longer works
    const apiKeyClient = client.createNew({
      headers: {
        Authorization: `Bearer ${testSecret}`,
      },
    });
    
    try {
      await apiKeyClient.query({
        query: gql`
          query CurrentAccount {
            me {
              id
              username
            }
          }
        `,
      });
      
      // Should not reach here
      expect(false).toBe(true);
    } catch (error) {
      expect(error.message).toContain("Not authenticated");
    }
  });
});
```

## Security Considerations

### Step 1: Key Format and Storage

The API key format `fk_{keyId}_{randomSecret}` provides several security benefits:

1. The `fk_` prefix helps identify the token as a Flash API key
2. The `keyId` component (8 chars) is used for database lookups, not sensitive
3. The `randomSecret` component (64 chars) provides 256 bits of entropy
4. Keys are stored as SHA-256 hashes in the database, never in plaintext
5. Timing-safe comparison protects against timing attacks

### Step 2: Security Audit Considerations

Add to your security documentation:

```markdown
## API Key Security Audit Checklist

### Key Generation and Storage
- [x] API keys have at least 256 bits of entropy
- [x] API keys follow a standard format for easy identification
- [x] API keys are stored as cryptographic hashes
- [x] Database access to hashed keys is properly restricted
- [x] Keys are compared using timing-safe comparison to prevent timing attacks

### Authentication Flow
- [x] API key header extraction uses constant-time comparison
- [x] Failed authentication attempts are logged
- [x] API keys must have at least one permission scope
- [x] IP address is checked against constraints
- [x] Rate limiting is applied to prevent brute force

### Authorization
- [x] Keys have minimal scopes by default
- [x] Each endpoint/query enforces scope requirements
- [x] Admin operations require additional verification

### Operational Security
- [x] Keys can be revoked immediately
- [x] Key rotation does not cause service disruption
- [x] Expiration is enforced for all keys
- [x] Usage is logged for audit purposes
- [x] API provides access to detailed audit logs
- [x] Suspicious activity triggers alerts

### Incident Response
- [ ] Process defined for compromised key response
- [ ] Ability to revoke all keys for an account immediately
- [ ] Monitoring for unusual access patterns
```

## Deployment Plan

### Step 1: Database Migration

Create a new migration file: `src/migrations/YYYYMMDDHHMMSS-add-api-keys-collection.ts`

```typescript
export const up = async (db) => {
  await db.createCollection("apikeys");
  
  await db.collection("apikeys").createIndex({ keyId: 1 }, { unique: true });
  await db.collection("apikeys").createIndex({ accountId: 1 });
  await db.collection("apikeys").createIndex({ status: 1 });
  await db.collection("apikeys").createIndex({ expiresAt: 1 });
};

export const down = async (db) => {
  await db.collection("apikeys").drop();
};
```

### Step 2: Deployment Checklist

1. Run database migrations
2. Deploy code with feature flag to enable/disable API key authentication
3. Monitor for errors in authentication middleware
4. Enable for internal users first
5. Roll out gradually to all users

### Step 3: Rollback Plan

If issues are detected:

1. Disable API key authentication via feature flag
2. Fix issues in development
3. Deploy fixes
4. Re-enable API key authentication

## Future Enhancements

### OAuth2 Integration

Future integration with OAuth2 will allow third-party applications to access the API on behalf of users:

1. Implement OAuth2 server functionality
2. Add consent screens for scope approval
3. Issue access and refresh tokens
4. Link tokens to specific API keys

### Developer Dashboard

A dedicated developer dashboard will provide:

1. API key management UI
2. Usage statistics and graphs
3. Rate limit monitoring
4. Documentation and examples
5. Support for webhook endpoints

### Enhanced Rate Limiting

Advanced rate limiting features:

1. Per-endpoint throttling based on resource intensity
2. Dynamic rate limits based on account history
3. Burst allowances for periodic high-volume operations
4. Rate limit sharing across multiple keys

### Webhook Support

Add support for webhooks:

1. Register webhook endpoints
2. Sign webhook payloads with API keys
3. Receive real-time event notifications
4. Retry logic for failed deliveries

### Metrics and Analytics

Enhance the analytics capabilities:

1. Usage dashboards by endpoint
2. Anomaly detection for security
3. Performance tracking by API key
4. Cost allocation for resources used