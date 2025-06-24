# Smart Router Security Specification

## Overview

This document outlines the comprehensive security measures for the Smart Router implementation, covering token storage, transmission, validation, and operational security.

## Threat Model

### Primary Threats

1. **Token Theft**
   - Unauthorized access to stored eCash tokens
   - Man-in-the-middle attacks during transmission
   - Malicious app cloning vault data

2. **Token Replay**
   - Double-spending of tokens
   - Reuse of spent tokens
   - Race condition attacks

3. **Mint Compromise**
   - Malicious mint operators
   - Compromised mint keys
   - Mint impersonation attacks

4. **Data Corruption**
   - Vault corruption leading to token loss
   - Backup tampering
   - State desynchronization

5. **Privacy Leaks**
   - Transaction correlation
   - Balance disclosure
   - Metadata exposure

## Security Architecture

### 1. Token Storage Security

#### Encryption at Rest

```typescript
class SecureVault {
  private async encryptToken(token: CashuToken): Promise<EncryptedToken> {
    // Derive encryption key from user password + device key
    const salt = await this.generateSalt()
    const key = await this.deriveKey(this.userPassword, salt)
    
    // Encrypt token data
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const encrypted = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: iv,
        tagLength: 128
      },
      key,
      new TextEncoder().encode(JSON.stringify(token))
    )
    
    return {
      encrypted,
      iv,
      salt,
      algorithm: 'AES-GCM-256',
      version: 1
    }
  }
}
```

#### Platform-Specific Storage

**iOS Implementation**
```swift
// Use iOS Keychain with Secure Enclave
class iOSVaultStorage {
  func storeToken(_ encryptedToken: Data) throws {
    let query: [String: Any] = [
      kSecClass: kSecClassGenericPassword,
      kSecAttrService: "me.flashapp.cashu",
      kSecAttrAccount: tokenId,
      kSecValueData: encryptedToken,
      kSecAttrAccessible: kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
      kSecAttrAccessControl: SecAccessControlCreateWithFlags(
        nil,
        kSecAttrAccessibleWhenUnlockedThisDeviceOnly,
        [.userPresence, .privateKeyUsage],
        nil
      )
    ]
    
    SecItemAdd(query as CFDictionary, nil)
  }
}
```

**Android Implementation**
```kotlin
// Use Android Keystore
class AndroidVaultStorage {
  fun storeToken(encryptedToken: ByteArray) {
    val keyAlias = "FlashCashuVault"
    
    // Generate or retrieve key from Android Keystore
    val keyGenerator = KeyGenerator.getInstance(
      KeyProperties.KEY_ALGORITHM_AES, 
      "AndroidKeyStore"
    )
    
    val keyGenParameterSpec = KeyGenParameterSpec.Builder(
      keyAlias,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setUserAuthenticationRequired(true)
      .setUserAuthenticationValidityDurationSeconds(300)
      .build()
    
    keyGenerator.init(keyGenParameterSpec)
    val secretKey = keyGenerator.generateKey()
    
    // Encrypt and store
    val cipher = Cipher.getInstance("AES/GCM/NoPadding")
    cipher.init(Cipher.ENCRYPT_MODE, secretKey)
    val encryptedData = cipher.doFinal(encryptedToken)
    
    // Store in encrypted SharedPreferences
    EncryptedSharedPreferences.create(
      "flash_cashu_vault",
      keyAlias,
      context,
      EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
      EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    ).edit().putString(tokenId, Base64.encode(encryptedData)).apply()
  }
}
```

### 2. Token Validation

#### Cryptographic Validation

```typescript
class TokenValidator {
  async validateToken(token: CashuToken): Promise<ValidationResult> {
    // 1. Verify token structure
    if (!this.isValidStructure(token)) {
      return { valid: false, reason: 'Invalid token structure' }
    }
    
    // 2. Verify mint signature
    const mint = await this.mintRegistry.getMint(token.mint)
    if (!mint) {
      return { valid: false, reason: 'Unknown mint' }
    }
    
    // 3. Verify each proof
    for (const proof of token.proofs) {
      const isValid = await this.verifyProof(proof, mint.keys)
      if (!isValid) {
        return { valid: false, reason: 'Invalid proof signature' }
      }
    }
    
    // 4. Check if token is already spent
    const isSpent = await this.checkSpentStatus(token, mint)
    if (isSpent) {
      return { valid: false, reason: 'Token already spent' }
    }
    
    return { valid: true }
  }
  
  private async verifyProof(proof: Proof, mintKeys: MintKeys): Promise<boolean> {
    // Implement BDHKE signature verification
    const Y = await this.unblindSignature(proof.C, proof.secret, mintKeys[proof.id])
    return this.verifyDLEQ(proof, Y, mintKeys[proof.id])
  }
}
```

#### Anti-Replay Protection

```typescript
class AntiReplayGuard {
  private spentTokens: BloomFilter
  private pendingTokens: Map<string, Date>
  
  async checkAndMarkToken(token: CashuToken): Promise<boolean> {
    const tokenId = this.computeTokenId(token)
    
    // Check if already spent
    if (this.spentTokens.has(tokenId)) {
      throw new Error('Token already spent')
    }
    
    // Check if pending (prevents race conditions)
    if (this.pendingTokens.has(tokenId)) {
      const pendingSince = this.pendingTokens.get(tokenId)
      if (Date.now() - pendingSince.getTime() < 30000) { // 30 second timeout
        throw new Error('Token spending in progress')
      }
    }
    
    // Mark as pending
    this.pendingTokens.set(tokenId, new Date())
    
    return true
  }
  
  async confirmSpent(token: CashuToken): Promise<void> {
    const tokenId = this.computeTokenId(token)
    this.spentTokens.add(tokenId)
    this.pendingTokens.delete(tokenId)
    
    // Persist to database
    await this.persistSpentToken(tokenId)
  }
}
```

### 3. Communication Security

#### Mint Communication

```typescript
class SecureMintClient {
  private async validateMintCertificate(url: string): Promise<boolean> {
    const mintInfo = await fetch(`${url}/info`)
    const certificate = mintInfo.headers.get('X-SSL-Cert')
    
    // Verify certificate chain
    const isValid = await this.verifyCertificateChain(certificate)
    if (!isValid) return false
    
    // Certificate pinning for known mints
    if (this.isPinnedMint(url)) {
      const expectedFingerprint = this.getPinnedFingerprint(url)
      const actualFingerprint = this.computeFingerprint(certificate)
      return expectedFingerprint === actualFingerprint
    }
    
    return true
  }
  
  private async secureRequest(url: string, data: any): Promise<any> {
    // Validate mint certificate
    if (!await this.validateMintCertificate(url)) {
      throw new Error('Invalid mint certificate')
    }
    
    // Use TLS 1.3 minimum
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Flash-Version': APP_VERSION,
        'X-Request-ID': generateRequestId()
      },
      body: JSON.stringify(data),
      // Force TLS 1.3
      agent: new https.Agent({
        minVersion: 'TLSv1.3',
        rejectUnauthorized: true
      })
    })
    
    return response.json()
  }
}
```

#### Token Transmission

```typescript
class SecureTokenTransmission {
  // Encrypt tokens for backup/sharing
  async encryptForTransmission(
    tokens: CashuToken[],
    recipientPublicKey?: string
  ): Promise<string> {
    const payload = JSON.stringify(tokens)
    
    if (recipientPublicKey) {
      // End-to-end encryption for sharing
      return this.encryptWithPublicKey(payload, recipientPublicKey)
    } else {
      // Symmetric encryption for backup
      const key = await this.generateBackupKey()
      const encrypted = await this.encryptSymmetric(payload, key)
      return this.encodeBackup(encrypted, key)
    }
  }
  
  // QR code security
  generateSecureQR(token: CashuToken): QRCodeData {
    // Add expiration timestamp
    const expiryTime = Date.now() + (5 * 60 * 1000) // 5 minutes
    
    // Create signed payload
    const payload = {
      token,
      expiry: expiryTime,
      nonce: crypto.randomBytes(16).toString('hex')
    }
    
    const signature = this.signPayload(payload)
    
    return {
      data: this.encode(payload),
      signature,
      version: 1
    }
  }
}
```

### 4. Access Control

#### Authentication Gates

```typescript
class VaultAccessControl {
  private failedAttempts: number = 0
  private lockedUntil?: Date
  
  async authenticateAccess(method: AuthMethod): Promise<boolean> {
    // Check if temporarily locked
    if (this.lockedUntil && new Date() < this.lockedUntil) {
      throw new Error(`Vault locked until ${this.lockedUntil}`)
    }
    
    let authenticated = false
    
    switch (method.type) {
      case 'biometric':
        authenticated = await this.verifyBiometric()
        break
      case 'pin':
        authenticated = await this.verifyPIN(method.value)
        break
      case 'password':
        authenticated = await this.verifyPassword(method.value)
        break
    }
    
    if (!authenticated) {
      this.failedAttempts++
      if (this.failedAttempts >= 3) {
        // Lock for increasing durations
        const lockMinutes = Math.pow(2, this.failedAttempts - 3) * 5
        this.lockedUntil = new Date(Date.now() + lockMinutes * 60000)
      }
      throw new Error('Authentication failed')
    }
    
    // Reset on success
    this.failedAttempts = 0
    this.lockedUntil = undefined
    
    return true
  }
}
```

#### Permission Model

```typescript
enum VaultPermission {
  READ_BALANCE = 'READ_BALANCE',
  SEND_TOKENS = 'SEND_TOKENS',
  RECEIVE_TOKENS = 'RECEIVE_TOKENS',
  BACKUP_VAULT = 'BACKUP_VAULT',
  RESTORE_VAULT = 'RESTORE_VAULT',
  MANAGE_MINTS = 'MANAGE_MINTS'
}

class PermissionManager {
  async checkPermission(
    user: User,
    permission: VaultPermission,
    context?: any
  ): Promise<boolean> {
    // Always require authentication
    if (!user.isAuthenticated) return false
    
    // Check specific permissions
    switch (permission) {
      case VaultPermission.SEND_TOKENS:
        // Require recent authentication for sending
        if (!this.hasRecentAuth(user, 300)) { // 5 minutes
          throw new Error('Re-authentication required')
        }
        
        // Check daily limits
        if (await this.exceedsDailyLimit(user, context.amount)) {
          throw new Error('Daily limit exceeded')
        }
        break
        
      case VaultPermission.RESTORE_VAULT:
        // Require strong authentication
        if (user.authMethod !== 'password' && user.authMethod !== 'biometric') {
          throw new Error('Strong authentication required')
        }
        break
    }
    
    return true
  }
}
```

### 5. Backup Security

#### Encrypted Backup Format

```typescript
interface EncryptedBackup {
  version: number
  algorithm: 'AES-GCM-256'
  kdf: 'PBKDF2' | 'Argon2id'
  kdfParams: {
    iterations?: number
    memory?: number
    parallelism?: number
    salt: string
  }
  encryptedData: string
  checksum: string
  createdAt: number
  metadata: {
    tokenCount: number
    totalValue: number
    deviceId: string
  }
}

class BackupManager {
  async createBackup(password: string): Promise<EncryptedBackup> {
    const tokens = await this.vault.getAllTokens()
    const data = {
      tokens,
      mints: await this.mintRegistry.getAllMints(),
      settings: await this.getSettings()
    }
    
    // Use Argon2id for key derivation
    const salt = crypto.randomBytes(32)
    const key = await argon2id(password, salt, {
      memory: 65536,
      iterations: 3,
      parallelism: 4,
      tagLength: 32
    })
    
    // Encrypt with AES-GCM
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
    
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(data)),
      cipher.final()
    ])
    
    const authTag = cipher.getAuthTag()
    
    return {
      version: 1,
      algorithm: 'AES-GCM-256',
      kdf: 'Argon2id',
      kdfParams: {
        memory: 65536,
        iterations: 3,
        parallelism: 4,
        salt: salt.toString('base64')
      },
      encryptedData: Buffer.concat([iv, authTag, encrypted]).toString('base64'),
      checksum: this.computeChecksum(encrypted),
      createdAt: Date.now(),
      metadata: {
        tokenCount: tokens.length,
        totalValue: this.sumTokenValues(tokens),
        deviceId: await this.getDeviceId()
      }
    }
  }
}
```

### 6. Operational Security

#### Audit Logging

```typescript
class SecurityAuditLogger {
  async logSecurityEvent(event: SecurityEvent): Promise<void> {
    const logEntry: AuditLog = {
      timestamp: new Date(),
      eventType: event.type,
      severity: event.severity,
      userId: event.userId,
      deviceId: await this.getDeviceId(),
      details: event.details,
      stackTrace: event.error?.stack,
      ipAddress: event.ipAddress,
      userAgent: event.userAgent
    }
    
    // Log locally
    await this.localLogger.log(logEntry)
    
    // Send to remote audit service (if critical)
    if (event.severity === 'CRITICAL') {
      await this.remoteLogger.log(logEntry)
    }
  }
}

enum SecurityEventType {
  VAULT_ACCESS_DENIED = 'VAULT_ACCESS_DENIED',
  INVALID_TOKEN_RECEIVED = 'INVALID_TOKEN_RECEIVED',
  MINT_CERTIFICATE_INVALID = 'MINT_CERTIFICATE_INVALID',
  BACKUP_CREATED = 'BACKUP_CREATED',
  BACKUP_RESTORED = 'BACKUP_RESTORED',
  SUSPICIOUS_ACTIVITY = 'SUSPICIOUS_ACTIVITY'
}
```

#### Monitoring and Alerting

```typescript
class SecurityMonitor {
  private rules: SecurityRule[] = [
    {
      name: 'rapid_token_spending',
      condition: (events) => {
        const recentSpends = events.filter(e => 
          e.type === 'TOKEN_SPENT' && 
          e.timestamp > Date.now() - 60000
        )
        return recentSpends.length > 10
      },
      action: 'ALERT_AND_LIMIT'
    },
    {
      name: 'multiple_failed_auth',
      condition: (events) => {
        const failedAuths = events.filter(e => 
          e.type === 'AUTH_FAILED' && 
          e.timestamp > Date.now() - 300000
        )
        return failedAuths.length >= 3
      },
      action: 'LOCK_VAULT'
    }
  ]
  
  async checkSecurityRules(): Promise<void> {
    const recentEvents = await this.getRecentEvents()
    
    for (const rule of this.rules) {
      if (rule.condition(recentEvents)) {
        await this.executeAction(rule.action)
      }
    }
  }
}
```

## Security Checklist

### Development Phase
- [ ] Code review by security team
- [ ] Static analysis tools configured
- [ ] Dependency vulnerability scanning
- [ ] Secure coding guidelines followed

### Pre-Release
- [ ] Penetration testing completed
- [ ] Cryptographic implementation audited
- [ ] Platform-specific security features utilized
- [ ] Security documentation updated

### Operations
- [ ] Security monitoring active
- [ ] Incident response plan ready
- [ ] Regular security updates scheduled
- [ ] User security education prepared

## Incident Response

### Response Plan
1. **Detection**: Automated monitoring or user report
2. **Assessment**: Determine scope and severity
3. **Containment**: Disable affected features if needed
4. **Eradication**: Fix vulnerability
5. **Recovery**: Restore normal operations
6. **Lessons Learned**: Update security measures

### Emergency Procedures
- **Token Compromise**: Remote vault lock capability
- **Mint Compromise**: Automatic mint blacklisting
- **App Compromise**: Force update mechanism
- **Data Breach**: User notification system

## Compliance Considerations

### Data Protection
- GDPR compliance for EU users
- Data minimization principles
- Right to erasure implementation
- Data portability features

### Financial Regulations
- AML/KYC requirements consideration
- Transaction reporting capabilities
- Audit trail maintenance
- Regulatory reporting interfaces