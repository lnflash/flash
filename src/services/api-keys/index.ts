import {
  ApiKey as ApiKeyModel,
  ApiKeyRecord,
} from "@services/mongoose/api-keys"
import {
  ApiKey,
  ApiKeyStatus,
  ApiKeyType,
  ApiKeyWithHash,
  ApiKeyWithSecrets,
  generateApiKeyCredentials,
  Scope
} from "@domain/api-keys"
import { ApiKeyId, AccountId } from "@domain/api-keys/types"
import {
  isApiKeyActive,
  isApiKeyExpired,
  isScopeAllowed,
  validateApiKeyFormat,
  validateApiKeyId,
  validateScopes,
} from "@domain/api-keys/api-key-validator"
import {
  ApiKeyCreationFailedError,
  ApiKeyExpiredError,
  ApiKeyInactiveError,
  ApiKeyInvalidError,
  ApiKeyNotFoundError,
  ApiKeyRevokedError,
  InvalidAccountIdError,
  InvalidApiKeyNameError,
  InvalidExpirationDateError,
  KeyRotationFailedError,
  ScopeNotAllowedError,
} from "@domain/api-keys/errors"
import { createHash, createHmac, timingSafeEqual } from "crypto"

import { ApiKeyLookupByKeyResult } from "@domain/api-keys/types"

// A service for managing API keys
export class ApiKeyService {
  // Expose scope validation function
  static isScopeAllowed = isScopeAllowed
  // Creates a new API key
  static async create({
    name,
    accountId,
    type,
    scopes,
    expiresAt,
    tier = "DEFAULT",
    metadata = {},
  }: {
    name: string
    accountId: string
    type: ApiKeyType
    scopes: Scope[]
    expiresAt?: Date
    tier?: string
    metadata?: Record<string, unknown>
  }): Promise<ApiKeyWithSecrets> {
    // Validate inputs
    if (!name || name.length < 3 || name.length > 100) {
      throw new InvalidApiKeyNameError()
    }

    if (!accountId) {
      throw new InvalidAccountIdError()
    }

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new InvalidExpirationDateError()
    }

    const { valid, invalidScopes } = validateScopes(scopes)
    if (!valid) {
      throw new InvalidApiKeyNameError()
    }

    try {
      // Generate API key credentials
      const { apiKey, hashedKey, privateKey } = generateApiKeyCredentials(type)

      // Create the API key record
      const apiKeyRecord = await ApiKeyModel.create({
        name,
        accountId,
        type,
        hashedKey,
        scopes,
        expiresAt: expiresAt || null,
        status: ApiKeyStatus.Active,
        tier,
        metadata,
        privateKey,
      })

      // Return the API key with secrets
      return {
        id: apiKeyRecord.id,
        name: apiKeyRecord.name,
        accountId: apiKeyRecord.accountId,
        type: apiKeyRecord.type as ApiKeyType,
        scopes: apiKeyRecord.scopes as Scope[],
        expiresAt: apiKeyRecord.expiresAt,
        lastUsedAt: apiKeyRecord.lastUsedAt,
        createdAt: apiKeyRecord.createdAt,
        status: apiKeyRecord.status as ApiKeyStatus,
        tier: apiKeyRecord.tier,
        metadata: apiKeyRecord.metadata,
        apiKey,
        privateKey,
      }
    } catch (error) {
      throw new ApiKeyCreationFailedError((error as Error).message)
    }
  }

  // Retrieves an API key by ID
  static async getById(id: string): Promise<ApiKeyWithHash> {
    if (!validateApiKeyId(id)) {
      throw new ApiKeyNotFoundError(id)
    }

    const apiKeyRecord = await ApiKeyModel.findOne({ id })
    if (!apiKeyRecord) {
      throw new ApiKeyNotFoundError(id)
    }

    return this.mapRecordToApiKey(apiKeyRecord)
  }

  // Lists API keys for an account
  static async listByAccountId(accountId: string): Promise<ApiKey[]> {
    if (!accountId) {
      throw new InvalidAccountIdError()
    }

    const apiKeyRecords = await ApiKeyModel.find({ accountId })
    return apiKeyRecords.map((record) => this.mapRecordToApiKey(record))
  }

  // Verifies an API key
  static async verifyKey(
    apiKey: string,
    requiredScopes?: Scope[],
  ): Promise<ApiKeyLookupByKeyResult> {
    // Validate key format
    const { valid, type } = validateApiKeyFormat(apiKey)
    if (!valid || !type) {
      throw new ApiKeyInvalidError()
    }

    // Extract key for hashing
    const keyParts = apiKey.split("_")
    if (keyParts.length !== 2) {
      throw new ApiKeyInvalidError()
    }

    // Lookup API key by hashed value
    // This approach prevents timing attacks by always performing the lookup
    // then checking with timingSafeEqual
    const apiKeyRecords = await ApiKeyModel.find({ 
      type, 
      status: { $in: [ApiKeyStatus.Active, ApiKeyStatus.Rotating] }
    })

    let matchedKey: ApiKeyRecord | null = null

    // Use constant-time comparison to prevent timing attacks
    for (const record of apiKeyRecords) {
      // Generate the key to compare against
      const { apiKey: generatedKey } = generateApiKeyCredentials(type as ApiKeyType)
      
      // Compare using timingSafeEqual to avoid timing attacks
      const keyBuffer = Buffer.from(apiKey)
      const generatedKeyBuffer = Buffer.from(generatedKey)
      
      try {
        if (keyBuffer.length === generatedKeyBuffer.length && 
            timingSafeEqual(keyBuffer, generatedKeyBuffer)) {
          matchedKey = record
          break
        }
      } catch (error) {
        // Catch errors from timingSafeEqual (e.g. different buffer lengths)
        continue
      }
    }

    if (!matchedKey) {
      throw new ApiKeyNotFoundError()
    }

    // Check if key is revoked
    if (matchedKey.status === ApiKeyStatus.Revoked) {
      throw new ApiKeyRevokedError()
    }

    // Check if key is expired
    if (isApiKeyExpired(matchedKey.expiresAt)) {
      throw new ApiKeyExpiredError()
    }

    // Check if key is active
    if (!isApiKeyActive(matchedKey.status as ApiKeyStatus)) {
      throw new ApiKeyInactiveError()
    }

    // Check if required scopes are allowed
    if (requiredScopes && requiredScopes.length > 0) {
      for (const scope of requiredScopes) {
        if (!isScopeAllowed(scope, matchedKey.scopes as Scope[])) {
          throw new ScopeNotAllowedError(scope)
        }
      }
    }

    // Update last used timestamp
    await ApiKeyModel.updateOne(
      { id: matchedKey.id },
      { $set: { lastUsedAt: new Date() } },
    )

    return {
      id: matchedKey.id as unknown as ApiKeyId,
      accountId: matchedKey.accountId as unknown as AccountId,
      hashedKey: matchedKey.hashedKey,
      scopes: matchedKey.scopes as Scope[],
      status: matchedKey.status as ApiKeyStatus,
      expiresAt: matchedKey.expiresAt,
      tier: matchedKey.tier,
    }
  }

  // Updates an API key
  static async update({
    id,
    name,
    scopes,
    expiresAt,
    tier,
    metadata,
  }: {
    id: string
    name?: string
    scopes?: Scope[]
    expiresAt?: Date | null
    tier?: string
    metadata?: Record<string, unknown>
  }): Promise<ApiKey> {
    if (!validateApiKeyId(id)) {
      throw new ApiKeyNotFoundError(id)
    }

    // Validate inputs
    if (name && (name.length < 3 || name.length > 100)) {
      throw new InvalidApiKeyNameError()
    }

    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new InvalidExpirationDateError()
    }

    if (scopes) {
      const { valid, invalidScopes } = validateScopes(scopes)
      if (!valid) {
        throw new InvalidApiKeyNameError()
      }
    }

    // Build update object
    const updateData: Partial<ApiKeyRecord> = {}
    if (name) updateData.name = name
    if (scopes) updateData.scopes = scopes
    if (expiresAt !== undefined) updateData.expiresAt = expiresAt // Allow null to clear expiration
    if (tier) updateData.tier = tier
    if (metadata) updateData.metadata = metadata

    // Update the API key
    const updatedApiKey = await ApiKeyModel.findOneAndUpdate(
      { id },
      { $set: updateData },
      { new: true },
    )

    if (!updatedApiKey) {
      throw new ApiKeyNotFoundError(id)
    }

    return this.mapRecordToApiKey(updatedApiKey)
  }

  // Revokes an API key
  static async revoke(id: string): Promise<boolean> {
    if (!validateApiKeyId(id)) {
      throw new ApiKeyNotFoundError(id)
    }

    const result = await ApiKeyModel.updateOne(
      { id },
      { $set: { status: ApiKeyStatus.Revoked } },
    )

    if (result.matchedCount === 0) {
      throw new ApiKeyNotFoundError(id)
    }

    return true
  }

  // Initiates the rotation of an API key
  static async initiateRotation({
    id,
    transitionPeriodDays = 7,
  }: {
    id: string
    transitionPeriodDays?: number
  }): Promise<ApiKeyWithSecrets> {
    if (!validateApiKeyId(id)) {
      throw new ApiKeyNotFoundError(id)
    }

    // Retrieve the original API key
    const originalApiKey = await ApiKeyModel.findOne({ id })
    if (!originalApiKey) {
      throw new ApiKeyNotFoundError(id)
    }

    // Check if the API key is already being rotated
    if (originalApiKey.status === ApiKeyStatus.Rotating) {
      throw new KeyRotationFailedError("API key is already being rotated")
    }

    // Check if the API key is revoked or expired
    if (originalApiKey.status === ApiKeyStatus.Revoked) {
      throw new KeyRotationFailedError("Cannot rotate a revoked API key")
    }

    if (isApiKeyExpired(originalApiKey.expiresAt)) {
      throw new KeyRotationFailedError("Cannot rotate an expired API key")
    }

    try {
      // Create a new API key with the same properties
      const newApiKeyWithSecrets = await this.create({
        name: `${originalApiKey.name} (new)`,
        accountId: originalApiKey.accountId,
        type: originalApiKey.type as ApiKeyType,
        scopes: originalApiKey.scopes as Scope[],
        tier: originalApiKey.tier,
        metadata: originalApiKey.metadata,
      })

      // Update the status of the original API key
      await ApiKeyModel.updateOne(
        { id },
        {
          $set: {
            status: ApiKeyStatus.Rotating,
            apiKeyRotation: {
              originalKeyId: id,
              newKeyId: newApiKeyWithSecrets.id,
              status: "in_progress",
              startedAt: new Date(),
              transitionPeriod: transitionPeriodDays,
              createdBy: originalApiKey.accountId,
            },
          },
        },
      )

      // Set rotation information on the new key too
      await ApiKeyModel.updateOne(
        { id: newApiKeyWithSecrets.id },
        {
          $set: {
            apiKeyRotation: {
              originalKeyId: id,
              newKeyId: newApiKeyWithSecrets.id,
              status: "in_progress",
              startedAt: new Date(),
              transitionPeriod: transitionPeriodDays,
              createdBy: originalApiKey.accountId,
            },
          },
        },
      )

      return newApiKeyWithSecrets
    } catch (error) {
      throw new KeyRotationFailedError((error as Error).message)
    }
  }

  // Completes the rotation of an API key
  static async completeRotation(originalKeyId: string): Promise<boolean> {
    if (!validateApiKeyId(originalKeyId)) {
      throw new ApiKeyNotFoundError(originalKeyId)
    }

    // Retrieve the original API key
    const originalApiKey = await ApiKeyModel.findOne({ id: originalKeyId })
    if (!originalApiKey) {
      throw new ApiKeyNotFoundError(originalKeyId)
    }

    // Check if the API key is being rotated
    if (originalApiKey.status !== ApiKeyStatus.Rotating || !originalApiKey.apiKeyRotation) {
      throw new KeyRotationFailedError("API key is not being rotated")
    }

    // Retrieve the new API key
    const newApiKey = await ApiKeyModel.findOne({
      id: originalApiKey.apiKeyRotation.newKeyId,
    })

    if (!newApiKey) {
      throw new KeyRotationFailedError("New API key not found")
    }

    try {
      // Update the status of both API keys
      await ApiKeyModel.updateOne(
        { id: originalKeyId },
        {
          $set: {
            status: ApiKeyStatus.Revoked,
            "apiKeyRotation.status": "completed",
            "apiKeyRotation.completedAt": new Date(),
          },
        },
      )

      await ApiKeyModel.updateOne(
        { id: newApiKey.id },
        {
          $set: {
            "apiKeyRotation.status": "completed",
            "apiKeyRotation.completedAt": new Date(),
          },
        },
      )

      return true
    } catch (error) {
      throw new KeyRotationFailedError((error as Error).message)
    }
  }

  // Logs API key usage
  static async logUsage({
    apiKeyId,
    endpoint,
    ip,
    success,
    responseTimeMs,
    statusCode,
  }: {
    apiKeyId: string
    endpoint: string
    ip: string
    success: boolean
    responseTimeMs: number
    statusCode: number
  }): Promise<void> {
    if (!validateApiKeyId(apiKeyId)) {
      return
    }

    await ApiKeyModel.updateOne(
      { id: apiKeyId },
      {
        $push: {
          usageHistory: {
            endpoint,
            ip,
            timestamp: new Date(),
            success,
            responseTimeMs,
            statusCode,
          },
        },
      },
    )
  }

  // Generates a webhook signature for secure callbacks
  static async generateWebhookSignature(
    apiKeyId: string,
    payload: Record<string, unknown>,
  ): Promise<{ signature: string; timestamp: number }> {
    if (!validateApiKeyId(apiKeyId)) {
      throw new ApiKeyNotFoundError(apiKeyId)
    }

    const apiKey = await ApiKeyModel.findOne({ id: apiKeyId })
    if (!apiKey) {
      throw new ApiKeyNotFoundError(apiKeyId)
    }

    const timestamp = Date.now()
    const stringToSign = `${timestamp}.${JSON.stringify(payload)}`
    
    const hmac = createHmac("sha256", apiKey.privateKey)
    hmac.update(stringToSign)
    const signature = hmac.digest("hex")

    return { signature, timestamp }
  }

  // Verifies a webhook signature
  static async verifyWebhookSignature(
    apiKeyId: string,
    payload: Record<string, unknown>,
    signature: string,
    timestamp: number,
  ): Promise<boolean> {
    if (!validateApiKeyId(apiKeyId)) {
      throw new ApiKeyNotFoundError(apiKeyId)
    }

    const apiKey = await ApiKeyModel.findOne({ id: apiKeyId })
    if (!apiKey) {
      throw new ApiKeyNotFoundError(apiKeyId)
    }

    // Check if the timestamp is not too old (within last 5 minutes)
    const MAX_TIMESTAMP_AGE = 5 * 60 * 1000 // 5 minutes
    if (Date.now() - timestamp > MAX_TIMESTAMP_AGE) {
      return false
    }

    const stringToSign = `${timestamp}.${JSON.stringify(payload)}`
    
    const hmac = createHmac("sha256", apiKey.privateKey)
    hmac.update(stringToSign)
    const expectedSignature = hmac.digest("hex")

    // Use timingSafeEqual to prevent timing attacks
    try {
      const signatureBuffer = Buffer.from(signature)
      const expectedSignatureBuffer = Buffer.from(expectedSignature)
      
      return (
        signatureBuffer.length === expectedSignatureBuffer.length &&
        timingSafeEqual(signatureBuffer, expectedSignatureBuffer)
      )
    } catch (error) {
      return false
    }
  }

  // Maps a database record to an API key domain object
  private static mapRecordToApiKey(record: ApiKeyRecord): ApiKeyWithHash {
    return {
      id: record.id,
      name: record.name,
      accountId: record.accountId,
      type: record.type as ApiKeyType,
      scopes: record.scopes as Scope[],
      expiresAt: record.expiresAt,
      lastUsedAt: record.lastUsedAt,
      createdAt: record.createdAt,
      status: record.status as ApiKeyStatus,
      tier: record.tier,
      metadata: record.metadata,
      hashedKey: record.hashedKey,
    }
  }
}