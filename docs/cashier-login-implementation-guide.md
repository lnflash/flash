# Cashier Login Implementation Guide

## Integration with Existing Flash Authentication

### Overview
This guide details how to implement the cashier PIN login feature while leveraging Flash's existing authentication infrastructure (Kratos, JWT, Session Management).

### Architecture Integration Points

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│   Client    │────▶│   GraphQL    │────▶│   Kratos    │
│  (Web/App)  │     │   Server     │     │  Identity   │
└─────────────┘     └──────────────┘     └─────────────┘
                            │                     │
                            ▼                     ▼
                    ┌──────────────┐     ┌─────────────┐
                    │   Session    │     │   Account   │
                    │  Middleware  │     │  Database   │
                    └──────────────┘     └─────────────┘
                            │
                            ▼
                    ┌──────────────┐
                    │     New:     │
                    │ PIN Service  │
                    └──────────────┘
```

### Phase 1: Extend Account Model

#### 1.1 Update Domain Types
```typescript
// src/domain/accounts/index.types.d.ts

export type CashierAuthMethod = "pin" | "sms" | "email"

export type CashierPinStatus = {
  isSetup: boolean
  lastChanged: Date | null
  expiresAt: Date | null
  failedAttempts: number
  isLocked: boolean
  lockedUntil: Date | null
}

// Extend existing Account type
export type AccountWithCashierAuth = Account & {
  pinHash?: string
  pinSalt?: string
  pinCreatedAt?: Date
  pinFailedAttempts: number
  pinLockedUntil?: Date | null
  lastCashierLoginMethod?: CashierAuthMethod
}
```

#### 1.2 Update Mongoose Schema
```typescript
// src/services/mongoose/schema.ts

// Add to AccountSchema
const CashierAuthSchema = {
  pinHash: { type: String },
  pinSalt: { type: String },
  pinCreatedAt: { type: Date },
  pinLastUsedAt: { type: Date },
  pinFailedAttempts: { type: Number, default: 0 },
  pinLockedUntil: { type: Date },
  lastCashierLoginMethod: {
    type: String,
    enum: ["pin", "sms", "email"],
  },
  pinHistory: [{
    hash: String,
    createdAt: Date,
  }],
}

// Merge with existing AccountSchema
AccountSchema.add(CashierAuthSchema)
```

### Phase 2: Create PIN Service

#### 2.1 PIN Service Implementation
```typescript
// src/services/cashier-auth/pin-service.ts

import bcrypt from "bcrypt"
import { randomBytes } from "crypto"

export const PinService = {
  // PIN validation rules
  validatePinFormat: (pin: string): ValidationResult => {
    if (pin.length < 4 || pin.length > 6) {
      return { valid: false, error: "PIN must be 4-6 digits" }
    }
    
    if (!/^\d+$/.test(pin)) {
      return { valid: false, error: "PIN must contain only digits" }
    }
    
    // Check for sequential
    if (isSequential(pin)) {
      return { valid: false, error: "PIN cannot be sequential" }
    }
    
    // Check for repetitive
    if (isRepetitive(pin)) {
      return { valid: false, error: "PIN cannot be repetitive" }
    }
    
    return { valid: true }
  },

  // Hash PIN with salt
  hashPin: async (pin: string): Promise<{ hash: string; salt: string }> => {
    const salt = randomBytes(16).toString("hex")
    const hash = await bcrypt.hash(pin + salt, 10)
    return { hash, salt }
  },

  // Verify PIN
  verifyPin: async (
    pin: string,
    hash: string,
    salt: string
  ): Promise<boolean> => {
    return bcrypt.compare(pin + salt, hash)
  },

  // Check PIN expiry (90 days)
  isPinExpired: (pinCreatedAt: Date): boolean => {
    const expiryDays = 90
    const expiryTime = expiryDays * 24 * 60 * 60 * 1000
    return Date.now() - pinCreatedAt.getTime() > expiryTime
  },
}
```

#### 2.2 Cashier Session Service
```typescript
// src/services/cashier-auth/session-service.ts

export const CashierSessionService = {
  // Create cashier session with PIN auth
  createPinSession: async ({
    accountId,
    terminalId,
    ipAddress,
    userAgent,
  }: CreateSessionInput): Promise<CashierSession> => {
    const sessionId = crypto.randomUUID()
    const shiftDuration = 8 * 60 * 60 * 1000 // 8 hours
    
    const session: CashierSession = {
      id: sessionId,
      accountId,
      terminalId,
      shiftStartTime: new Date(),
      lastActivityTime: new Date(),
      pinEnabled: true,
      expiresAt: new Date(Date.now() + shiftDuration),
      ipAddress,
      userAgent,
    }
    
    // Store in Redis with expiry
    await redis.setex(
      `cashier:session:${sessionId}`,
      shiftDuration / 1000,
      JSON.stringify(session)
    )
    
    return session
  },

  // Validate and refresh session
  validateSession: async (
    sessionId: string
  ): Promise<CashierSession | null> => {
    const sessionData = await redis.get(`cashier:session:${sessionId}`)
    if (!sessionData) return null
    
    const session = JSON.parse(sessionData) as CashierSession
    
    // Check expiry
    if (new Date(session.expiresAt) < new Date()) {
      await redis.del(`cashier:session:${sessionId}`)
      return null
    }
    
    // Check inactivity timeout (30 minutes)
    const inactivityTimeout = 30 * 60 * 1000
    const lastActivity = new Date(session.lastActivityTime)
    if (Date.now() - lastActivity.getTime() > inactivityTimeout) {
      await redis.del(`cashier:session:${sessionId}`)
      return null
    }
    
    // Update last activity
    session.lastActivityTime = new Date()
    await redis.setex(
      `cashier:session:${sessionId}`,
      Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000),
      JSON.stringify(session)
    )
    
    return session
  },
}
```

### Phase 3: GraphQL Implementation

#### 3.1 New Mutations
```typescript
// src/graphql/public/root/mutation/cashier-auth.ts

export const cashierSetupPin = async (
  _parent,
  { pin },
  { domainAccount }: GraphQLContextForUser
) => {
  // Verify cashier role
  if (!RoleChecker.isCashier(domainAccount)) {
    return new GraphQLError("Unauthorized: Cashier role required")
  }
  
  // Validate PIN format
  const validation = PinService.validatePinFormat(pin)
  if (!validation.valid) {
    return new GraphQLError(validation.error)
  }
  
  // Check PIN not in history
  const account = await Accounts.findById(domainAccount.id)
  if (await isPinInHistory(pin, account.pinHistory)) {
    return new GraphQLError("PIN was recently used")
  }
  
  // Hash and store PIN
  const { hash, salt } = await PinService.hashPin(pin)
  
  await Accounts.updateOne(
    { _id: domainAccount.id },
    {
      $set: {
        pinHash: hash,
        pinSalt: salt,
        pinCreatedAt: new Date(),
        pinFailedAttempts: 0,
        pinLockedUntil: null,
      },
      $push: {
        pinHistory: {
          $each: [{ hash, createdAt: new Date() }],
          $slice: -5, // Keep last 5 PINs
        },
      },
    }
  )
  
  // Log audit event
  await recordAuditEvent({
    accountId: domainAccount.id,
    action: "CASHIER_PIN_SETUP",
    metadata: { method: "initial_setup" },
  })
  
  return { success: true }
}

export const cashierLoginWithPin = async (
  _parent,
  { phone, pin, terminalId },
  { ip, userAgent }: GraphQLContext
) => {
  // Find account by phone
  const account = await Accounts.findOne({ phone })
  if (!account) {
    return new GraphQLError("Invalid credentials")
  }
  
  // Verify cashier role
  if (account.role !== AccountRole.Cashier) {
    return new GraphQLError("PIN login not available")
  }
  
  // Check if PIN is set up
  if (!account.pinHash || !account.pinSalt) {
    return new GraphQLError("PIN not configured")
  }
  
  // Check if account is locked
  if (account.pinLockedUntil && account.pinLockedUntil > new Date()) {
    const minutesLeft = Math.ceil(
      (account.pinLockedUntil.getTime() - Date.now()) / 60000
    )
    return new GraphQLError(`Account locked. Try again in ${minutesLeft} minutes`)
  }
  
  // Check PIN expiry
  if (PinService.isPinExpired(account.pinCreatedAt)) {
    return new GraphQLError("PIN expired. Please reset your PIN")
  }
  
  // Verify PIN
  const isValid = await PinService.verifyPin(
    pin,
    account.pinHash,
    account.pinSalt
  )
  
  if (!isValid) {
    // Increment failed attempts
    const newFailedAttempts = (account.pinFailedAttempts || 0) + 1
    const updates: any = {
      pinFailedAttempts: newFailedAttempts,
    }
    
    // Lock after 3 attempts
    if (newFailedAttempts >= 3) {
      updates.pinLockedUntil = new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
    }
    
    await Accounts.updateOne({ _id: account._id }, { $set: updates })
    
    // Log failed attempt
    await recordAuditEvent({
      accountId: account.id,
      action: "CASHIER_PIN_LOGIN_FAILED",
      metadata: {
        attempts: newFailedAttempts,
        locked: newFailedAttempts >= 3,
        ip,
      },
    })
    
    return new GraphQLError("Invalid credentials")
  }
  
  // Success - Reset failed attempts
  await Accounts.updateOne(
    { _id: account._id },
    {
      $set: {
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        pinLastUsedAt: new Date(),
        lastCashierLoginMethod: "pin",
      },
    }
  )
  
  // Create cashier session
  const session = await CashierSessionService.createPinSession({
    accountId: account.id,
    terminalId,
    ipAddress: ip,
    userAgent,
  })
  
  // Create JWT token for the session
  const token = await createSessionToken({
    accountId: account.id,
    sessionId: session.id,
    sessionType: "cashier_pin",
  })
  
  // Log successful login
  await recordAuditEvent({
    accountId: account.id,
    action: "CASHIER_PIN_LOGIN_SUCCESS",
    metadata: {
      sessionId: session.id,
      terminalId,
      ip,
    },
  })
  
  return {
    authToken: token,
    sessionId: session.id,
    expiresAt: session.expiresAt,
  }
}
```

#### 3.2 Update Session Middleware
```typescript
// src/servers/middlewares/session.ts

// Add to existing session validation
const validateCashierPinSession = async (
  sessionId: string,
  accountId: string
): Promise<boolean> => {
  const session = await CashierSessionService.validateSession(sessionId)
  if (!session) return false
  
  return session.accountId === accountId
}

// Extend existing middleware
export const sessionMiddleware = async (req, res, next) => {
  // ... existing code ...
  
  // Check for cashier PIN session
  if (tokenPayload.sessionType === "cashier_pin") {
    const isValidCashierSession = await validateCashierPinSession(
      tokenPayload.sessionId,
      tokenPayload.accountId
    )
    
    if (!isValidCashierSession) {
      return res.status(401).json({ error: "Invalid session" })
    }
    
    // Add cashier context
    req.context.isCashierPinSession = true
    req.context.sessionType = "cashier_pin"
  }
  
  // ... rest of existing code ...
}
```

### Phase 4: Rate Limiting Integration

```typescript
// src/app/authentication/cashier-ratelimits.ts

export const CashierRateLimits = {
  // PIN attempts per account
  pinAttempts: consumeLimiter({
    rateLimitConfig: {
      points: 3,
      duration: 15 * 60, // 15 minutes
      blockDuration: 15 * 60, // 15 minutes
    },
    keyPrefix: "pin_attempt",
  }),
  
  // PIN logins per IP
  pinLoginsPerIp: consumeLimiter({
    rateLimitConfig: {
      points: 20,
      duration: 60, // 1 minute
      blockDuration: 5 * 60, // 5 minutes
    },
    keyPrefix: "pin_login_ip",
  }),
}
```

### Phase 5: Migration Scripts

```typescript
// src/migrations/[timestamp]-add-cashier-pin-support.ts

export const up = async () => {
  // Add PIN fields to accounts
  await db.collection("accounts").updateMany(
    {},
    {
      $set: {
        pinHash: null,
        pinSalt: null,
        pinCreatedAt: null,
        pinLastUsedAt: null,
        pinFailedAttempts: 0,
        pinLockedUntil: null,
        pinHistory: [],
      },
    }
  )
  
  // Create indexes for performance
  await db.collection("accounts").createIndex({ phone: 1, pinHash: 1 })
  
  // Create cashier_sessions collection
  await db.createCollection("cashier_sessions")
  await db.collection("cashier_sessions").createIndex({ accountId: 1 })
  await db.collection("cashier_sessions").createIndex({ expiresAt: 1 })
}

export const down = async () => {
  // Remove PIN fields
  await db.collection("accounts").updateMany(
    {},
    {
      $unset: {
        pinHash: "",
        pinSalt: "",
        pinCreatedAt: "",
        pinLastUsedAt: "",
        pinFailedAttempts: "",
        pinLockedUntil: "",
        pinHistory: "",
      },
    }
  )
  
  // Drop cashier sessions
  await db.collection("cashier_sessions").drop()
}
```

### Phase 6: Testing Implementation

```typescript
// test/integration/cashier-pin-auth.spec.ts

describe("Cashier PIN Authentication", () => {
  let cashierAccount: Account
  
  beforeEach(async () => {
    cashierAccount = await createTestAccount({
      role: AccountRole.Cashier,
      phone: "+1234567890",
    })
  })
  
  describe("PIN Setup", () => {
    it("should allow cashier to set up PIN", async () => {
      const result = await graphQLClient.mutate({
        mutation: CASHIER_SETUP_PIN,
        variables: { pin: "1357" },
        context: { account: cashierAccount },
      })
      
      expect(result.data.cashierSetupPin.success).toBe(true)
    })
    
    it("should reject invalid PIN formats", async () => {
      const invalidPins = ["123", "1234567", "abcd", "1111", "1234"]
      
      for (const pin of invalidPins) {
        await expect(
          graphQLClient.mutate({
            mutation: CASHIER_SETUP_PIN,
            variables: { pin },
            context: { account: cashierAccount },
          })
        ).rejects.toThrow()
      }
    })
  })
  
  describe("PIN Login", () => {
    beforeEach(async () => {
      await setupCashierPin(cashierAccount, "1357")
    })
    
    it("should allow login with valid PIN", async () => {
      const result = await graphQLClient.mutate({
        mutation: CASHIER_LOGIN_WITH_PIN,
        variables: {
          phone: cashierAccount.phone,
          pin: "1357",
        },
      })
      
      expect(result.data.cashierLoginWithPin.authToken).toBeDefined()
      expect(result.data.cashierLoginWithPin.sessionId).toBeDefined()
    })
    
    it("should lock account after 3 failed attempts", async () => {
      // Make 3 failed attempts
      for (let i = 0; i < 3; i++) {
        await expect(
          graphQLClient.mutate({
            mutation: CASHIER_LOGIN_WITH_PIN,
            variables: {
              phone: cashierAccount.phone,
              pin: "0000",
            },
          })
        ).rejects.toThrow("Invalid credentials")
      }
      
      // 4th attempt should show locked message
      await expect(
        graphQLClient.mutate({
          mutation: CASHIER_LOGIN_WITH_PIN,
          variables: {
            phone: cashierAccount.phone,
            pin: "1357", // Even correct PIN
          },
        })
      ).rejects.toThrow(/Account locked/)
    })
  })
})
```

### Deployment Checklist

- [ ] Database migration completed
- [ ] Redis configured for session storage
- [ ] Environment variables set
- [ ] Rate limiting rules deployed
- [ ] Monitoring alerts configured
- [ ] Audit logging verified
- [ ] Load testing completed
- [ ] Security review passed
- [ ] Documentation updated
- [ ] Support team trained