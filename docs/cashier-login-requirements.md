# Cashier Login Feature Requirements

## Overview
This document outlines the requirements for implementing an optimized login flow for cashiers using the Flash Bitcoin Banking Platform. The goal is to provide a secure yet convenient authentication method that allows cashiers to quickly access the system during their work shifts.

## Current State Analysis

### Existing Authentication Methods
1. **Phone-based (Primary)**: SMS code verification
2. **Email-based**: Email code verification  
3. **Device-based**: Username/password with device ID (legacy)

### Pain Points for Cashiers
- Repeated SMS/Email verification throughout the day is time-consuming
- Session timeouts interrupt workflow
- No quick re-authentication method for temporary lockouts
- Multiple cashiers may share terminals in some locations

## Proposed Solution: Hybrid Authentication with PIN

### Primary Features

#### 1. Initial Authentication (Start of Shift)
- Cashiers use standard phone/email authentication for initial login
- After successful authentication, option to set up a 4-6 digit PIN
- PIN setup is mandatory for accounts with cashier role
- PIN must meet security requirements:
  - Not sequential (1234, 4321)
  - Not repetitive (1111, 2222)
  - Not match phone number digits
  - Changed every 90 days

#### 2. Quick Re-authentication (During Shift)
- After initial login, cashiers can use PIN for quick access
- PIN authentication available for:
  - Screen lock/unlock during active shift
  - Quick re-login after brief timeouts
  - Terminal switching (with additional verification)
- PIN sessions expire after:
  - 8 hours (configurable shift length)
  - 30 minutes of inactivity
  - Manual logout

#### 3. Session Management
```typescript
interface CashierSession {
  id: string
  accountId: string
  terminalId: string
  shiftStartTime: Date
  lastActivityTime: Date
  pinEnabled: boolean
  pinExpiresAt: Date
  ipAddress: string
  userAgent: string
}
```

### Implementation Design

#### 1. Database Schema Updates
```typescript
// Add to Account schema
interface AccountCashierAuth {
  pinHash?: string
  pinSalt?: string
  pinCreatedAt?: Date
  pinLastUsedAt?: Date
  pinFailedAttempts: number
  pinLockedUntil?: Date
  lastLoginMethod: 'phone' | 'email' | 'pin'
  terminalId?: string // For terminal-bound sessions
}
```

#### 2. GraphQL API Extensions

##### Mutations
```graphql
extend type Mutation {
  # Set up PIN after initial authentication
  cashierSetupPin(pin: String!): CashierAuthPayload! 
    @requiresRole(role: CASHIER)
    @requiresAuth
  
  # Change existing PIN
  cashierChangePin(oldPin: String!, newPin: String!): CashierAuthPayload!
    @requiresRole(role: CASHIER)
    @requiresAuth
  
  # Login with PIN (quick access)
  cashierLoginWithPin(
    phone: String!
    pin: String!
    terminalId: String
  ): AuthSessionPayload!
  
  # Disable PIN (admin action)
  adminDisableCashierPin(cashierId: ID!): SuccessPayload!
    @requiresRole(role: ADMIN)
}
```

##### Queries
```graphql
extend type Query {
  # Check if PIN is set up
  cashierPinStatus: CashierPinStatus!
    @requiresRole(role: CASHIER)
    @requiresAuth
  
  # Get active cashier sessions
  activeCashierSessions: [CashierSession!]!
    @requiresRole(role: ADMIN)
}

type CashierPinStatus {
  isSetup: Boolean!
  lastChanged: Timestamp
  expiresAt: Timestamp
  failedAttempts: Int!
  isLocked: Boolean!
}
```

#### 3. Security Measures

##### PIN Security
- Stored using bcrypt with salt (same as existing password hashing)
- Rate limiting: 3 failed attempts locks PIN for 15 minutes
- After 5 cumulative failures, require full re-authentication
- PIN history to prevent reuse of last 5 PINs

##### Session Security
```typescript
interface CashierSecurityConfig {
  pinLength: { min: 4, max: 6 }
  maxFailedAttempts: 3
  lockoutDuration: 15 * 60 * 1000 // 15 minutes
  sessionTimeout: 30 * 60 * 1000 // 30 minutes
  shiftDuration: 8 * 60 * 60 * 1000 // 8 hours
  pinRotationDays: 90
  requirePinForCashiers: true
}
```

##### Audit Requirements
- Log all PIN authentication attempts
- Track terminal IDs for location-based auditing
- Record authentication method for each session
- Alert on suspicious patterns (multiple terminals, unusual hours)

### User Experience Flow

#### Initial Setup (First Time)
1. Cashier logs in with phone/SMS
2. System prompts: "Set up your cashier PIN for quick access"
3. Cashier enters and confirms 4-6 digit PIN
4. Success message with PIN guidelines

#### Daily Login Flow
1. **Start of Shift**:
   - Enter phone number
   - Choose: "Login with SMS" or "Login with PIN"
   - If PIN: Enter PIN directly
   - If SMS: Standard verification flow

2. **During Shift**:
   - Screen locks after inactivity
   - Unlock with PIN only (no SMS needed)
   - PIN pad UI for quick entry

3. **End of Shift**:
   - Manual logout clears PIN session
   - Next login requires full authentication

#### Error Handling
- Clear error messages for wrong PIN
- Countdown timer for lockout periods
- Option to "Forgot PIN?" → SMS verification
- Admin support for locked accounts

### Terminal Management (Optional Enhancement)

For environments with shared terminals:

```typescript
interface TerminalConfig {
  terminalId: string
  location: string
  allowedCashiers: string[]
  requireTerminalBinding: boolean
  ipWhitelist?: string[]
}
```

- Cashiers can be bound to specific terminals
- PIN only works on authorized terminals
- Admin dashboard to manage terminal assignments

### Migration Strategy

1. **Phase 1**: Implement PIN infrastructure without requiring it
2. **Phase 2**: Enable PIN for volunteer cashiers (beta testing)
3. **Phase 3**: Require PIN for all new cashier accounts
4. **Phase 4**: Migrate existing cashiers with grace period

### Configuration Options

```yaml
# Environment variables
CASHIER_PIN_ENABLED: true
CASHIER_PIN_MIN_LENGTH: 4
CASHIER_PIN_MAX_LENGTH: 6
CASHIER_SESSION_TIMEOUT_MINUTES: 30
CASHIER_SHIFT_DURATION_HOURS: 8
CASHIER_PIN_ROTATION_DAYS: 90
CASHIER_PIN_MAX_FAILURES: 3
CASHIER_PIN_LOCKOUT_MINUTES: 15
```

### Success Metrics

- Average login time reduced by 80% for returning sessions
- Cashier satisfaction score > 4.5/5
- Security incidents: 0 increase
- Support tickets for login issues: 50% reduction

### Alternative Considerations

#### Biometric Authentication (Future Enhancement)
- WebAuthn support for fingerprint/face recognition
- Device-specific biometric binding
- Fallback to PIN when biometric fails

#### Hardware Token Support (Future Enhancement)
- YubiKey or similar hardware token support
- NFC badge integration for physical locations
- Requires additional infrastructure

## Technical Implementation Notes

### Reuse Existing Components
- Leverage existing Kratos authentication flows
- Extend current session management
- Use existing rate limiting infrastructure
- Build on current audit logging system

### New Components Required
- PIN management service
- Cashier session cache (Redis)
- PIN validation middleware
- Quick-access UI components

### Database Migrations
```sql
-- Add PIN fields to accounts table
ALTER TABLE accounts ADD COLUMN pin_hash VARCHAR(255);
ALTER TABLE accounts ADD COLUMN pin_salt VARCHAR(255);
ALTER TABLE accounts ADD COLUMN pin_created_at TIMESTAMP;
ALTER TABLE accounts ADD COLUMN pin_failed_attempts INT DEFAULT 0;
ALTER TABLE accounts ADD COLUMN pin_locked_until TIMESTAMP;

-- Create cashier sessions table
CREATE TABLE cashier_sessions (
  id UUID PRIMARY KEY,
  account_id UUID REFERENCES accounts(id),
  terminal_id VARCHAR(100),
  shift_start_time TIMESTAMP NOT NULL,
  last_activity_time TIMESTAMP NOT NULL,
  pin_enabled BOOLEAN DEFAULT true,
  expires_at TIMESTAMP NOT NULL,
  ip_address INET,
  user_agent TEXT
);

-- Index for quick lookups
CREATE INDEX idx_cashier_sessions_account_id ON cashier_sessions(account_id);
CREATE INDEX idx_cashier_sessions_expires_at ON cashier_sessions(expires_at);
```

## Security Review Checklist

- [ ] PIN storage uses proper hashing (bcrypt)
- [ ] Rate limiting prevents brute force attacks
- [ ] Session tokens are properly invalidated
- [ ] Audit logs capture all authentication events
- [ ] PIN rotation is enforced
- [ ] Terminal binding is secure (if implemented)
- [ ] No PIN visible in logs or error messages
- [ ] Proper HTTPS enforcement for all endpoints
- [ ] CSRF protection for web implementations
- [ ] Regular security audits scheduled