# Cashier Login Flow Diagrams

## Login Decision Flow

```mermaid
graph TD
    A[Cashier Opens App] --> B{Has Active Session?}
    B -->|Yes| C{Session Valid?}
    B -->|No| D[Enter Phone Number]
    
    C -->|Yes| E[Show Dashboard]
    C -->|No| F{PIN Enabled?}
    
    F -->|Yes| G[Show PIN Entry]
    F -->|No| D
    
    D --> H{Has PIN Setup?}
    H -->|Yes| I[Choose Auth Method]
    H -->|No| J[Send SMS Code]
    
    I --> K[Login with SMS]
    I --> L[Login with PIN]
    
    K --> J
    L --> G
    
    J --> M[Enter SMS Code]
    M --> N{Code Valid?}
    N -->|Yes| O{First Time Cashier?}
    N -->|No| P[Show Error]
    P --> M
    
    O -->|Yes| Q[Prompt PIN Setup]
    O -->|No| E
    
    Q --> R[Set PIN]
    R --> E
    
    G --> S{PIN Valid?}
    S -->|Yes| E
    S -->|No| T{Attempts < 3?}
    T -->|Yes| U[Show Error]
    T -->|No| V[Lock PIN 15min]
    U --> G
    V --> D
```

## PIN Setup Flow

```mermaid
graph TD
    A[Cashier Logged In] --> B{Has Cashier Role?}
    B -->|No| C[Regular Dashboard]
    B -->|Yes| D{PIN Setup?}
    
    D -->|Yes| C
    D -->|No| E[Show PIN Setup Modal]
    
    E --> F[Enter 4-6 Digit PIN]
    F --> G{PIN Valid?}
    
    G -->|No| H[Show Requirements]
    H --> F
    
    G -->|Yes| I[Confirm PIN]
    I --> J{PINs Match?}
    
    J -->|No| K[Show Mismatch Error]
    K --> F
    
    J -->|Yes| L[Save Encrypted PIN]
    L --> M[Show Success]
    M --> C
    
    H --> |Requirements|N[
        - 4-6 digits
        - Not sequential
        - Not repetitive
        - Not phone digits
    ]
```

## Daily Workflow States

```mermaid
stateDiagram-v2
    [*] --> LoggedOut: Start
    
    LoggedOut --> Authenticating: Enter Credentials
    Authenticating --> FullyAuthenticated: SMS Success
    Authenticating --> PINAuthenticated: PIN Success
    Authenticating --> LoggedOut: Failed
    
    FullyAuthenticated --> Active: Setup Complete
    PINAuthenticated --> Active: Valid Session
    
    Active --> ScreenLocked: Inactivity 30min
    Active --> ShiftExpired: 8 hours passed
    Active --> LoggedOut: Manual Logout
    
    ScreenLocked --> Active: PIN Unlock
    ScreenLocked --> LoggedOut: Forgot PIN
    
    ShiftExpired --> LoggedOut: Automatic
    
    note right of FullyAuthenticated
        Can setup/change PIN
        Full access to all features
    end note
    
    note right of PINAuthenticated
        Quick access mode
        Limited to shift duration
    end note
    
    note right of ScreenLocked
        Only PIN unlock available
        No SMS option
    end note
```

## Security State Machine

```mermaid
graph LR
    A[Normal] --> B{Failed PIN}
    B --> |1st Attempt|C[Warning State]
    C --> |Success|A
    C --> |2nd Fail|D[Critical State]
    D --> |Success|A
    D --> |3rd Fail|E[Locked 15min]
    E --> |Timeout|F[Reset Counter]
    F --> A
    
    E --> |5 Total Fails|G[Account Flag]
    G --> |Admin Review|H[Require Full Auth]
    H --> |SMS Login|A
```

## Database Interaction Flow

```mermaid
sequenceDiagram
    participant C as Cashier
    participant UI as Frontend
    participant API as GraphQL API
    participant Auth as Auth Service
    participant DB as Database
    participant Cache as Redis Cache
    
    C->>UI: Enter Phone + PIN
    UI->>API: cashierLoginWithPin(phone, pin)
    
    API->>DB: Get Account by Phone
    API->>API: Check Cashier Role
    
    alt Has Cashier Role
        API->>DB: Get PIN Hash
        API->>Auth: Validate PIN
        
        alt PIN Valid
            API->>Cache: Create Session
            API->>DB: Update lastLoginMethod
            API->>DB: Log Audit Entry
            API->>UI: Return Session Token
            UI->>C: Show Dashboard
        else PIN Invalid
            API->>DB: Increment Failed Attempts
            API->>DB: Check Lock Status
            API->>UI: Return Error
            UI->>C: Show Error/Lockout
        end
    else No Cashier Role
        API->>UI: Return Unauthorized
        UI->>C: Redirect to SMS Login
    end
```

## Terminal Binding Flow (Optional Feature)

```mermaid
graph TD
    A[Cashier Login Attempt] --> B{Terminal ID Provided?}
    B -->|No| C[Standard Login]
    B -->|Yes| D{Terminal Registered?}
    
    D -->|No| E[Register Terminal]
    D -->|Yes| F{Cashier Authorized?}
    
    E --> G[Admin Approval Required]
    G --> H[Pending State]
    
    F -->|Yes| I{IP Whitelist Check}
    F -->|No| J[Access Denied]
    
    I -->|Pass| K[Allow Login]
    I -->|Fail| L[Security Alert]
    
    L --> M[Notify Admin]
    M --> J
    
    K --> N[Bind Session to Terminal]
    N --> O[Track Terminal Usage]
```

## Error Handling Flows

```mermaid
graph TD
    A[Error Occurs] --> B{Error Type}
    
    B -->|Invalid PIN| C[Increment Counter]
    C --> D{Counter >= 3?}
    D -->|Yes| E[Lock Account 15min]
    D -->|No| F[Show Error Message]
    
    B -->|Session Expired| G[Check Shift Duration]
    G --> H{Within 8 hours?}
    H -->|Yes| I[Allow PIN Re-auth]
    H -->|No| J[Require Full Login]
    
    B -->|Network Error| K[Check Cache]
    K --> L{Cached Session?}
    L -->|Yes| M[Use Offline Mode]
    L -->|No| N[Show Retry Option]
    
    B -->|Account Locked| O[Show Lockout Timer]
    O --> P[Offer SMS Alternative]
    
    B -->|PIN Not Setup| Q[Redirect to Setup]
    Q --> R[Guide Through Process]
```

## Implementation Priority Matrix

| Feature | Priority | Complexity | Security Impact |
|---------|----------|------------|-----------------|
| Basic PIN Login | High | Medium | High |
| PIN Setup Flow | High | Low | High |
| Session Management | High | Medium | High |
| Rate Limiting | High | Low | Critical |
| Audit Logging | High | Low | High |
| Screen Lock | Medium | Low | Medium |
| Terminal Binding | Low | High | Medium |
| Biometric Support | Low | High | Low |
| Offline Mode | Low | High | Medium |

## Success Criteria Visualization

```mermaid
graph LR
    A[Current State] --> B[Target State]
    
    subgraph "Current Metrics"
        C[Login Time: 45s]
        D[Daily Logins: 15-20]
        E[Support Tickets: High]
        F[User Satisfaction: 3/5]
    end
    
    subgraph "Target Metrics"
        G[Login Time: 5s]
        H[Daily Logins: 2-3]
        I[Support Tickets: Low]
        J[User Satisfaction: 4.5/5]
    end
    
    C --> G
    D --> H
    E --> I
    F --> J
```