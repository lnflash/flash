import { ApiKeyScope, ApiKeyStatus } from "@services/mongoose/api-keys";
import { randomBytes } from "crypto";

/**
 * VerifiableEnvironment for API Key enhancements following the AZ-RSP methodology
 * This class provides utilities to verify the correctness of API key related operations
 */
export class ApiKeyVerifiableEnvironment {
  /**
   * Simulated database for testing
   */
  private apiKeys: Map<string, any> = new Map();
  private usageLogs: Map<string, any[]> = new Map();
  private rateLimits: Map<string, any> = new Map();

  constructor() {
    // Initialize with some test data
    this.seedTestData();
  }

  /**
   * Validates an API key format
   * @param apiKey The API key to validate
   * @returns ValidationResult with success and error message
   */
  validateApiKeyFormat(apiKey: string): ValidationResult {
    // Format should be: fk_{keyId}_{randomSecret}
    const parts = apiKey.split('_');
    
    if (parts.length !== 3) {
      return { 
        success: false, 
        error: 'Invalid API key format: should contain exactly two underscores' 
      };
    }
    
    if (parts[0] !== 'fk') {
      return { 
        success: false, 
        error: 'Invalid API key prefix: should start with "fk_"' 
      };
    }
    
    if (parts[1].length !== 8) {
      return { 
        success: false, 
        error: 'Invalid keyId portion: should be exactly 8 characters' 
      };
    }
    
    if (parts[2].length !== 64) {
      return { 
        success: false, 
        error: 'Invalid secret portion: should be exactly 64 characters' 
      };
    }

    return { success: true };
  }

  /**
   * Validates scope requirements
   * @param scopes Array of scopes to validate
   * @returns ValidationResult with success and error message
   */
  validateScopes(scopes: string[]): ValidationResult {
    if (!scopes || scopes.length === 0) {
      return {
        success: false,
        error: 'API key must have at least one scope'
      };
    }

    const validScopes = Object.values(ApiKeyScope);
    const invalidScopes = scopes.filter(scope => !validScopes.includes(scope as ApiKeyScope));
    
    if (invalidScopes.length > 0) {
      return {
        success: false,
        error: `Invalid scopes provided: ${invalidScopes.join(', ')}`
      };
    }

    return { success: true };
  }

  /**
   * Validates a key creation operation
   * @param params Parameters for key creation
   * @returns ValidationResult with success and error message
   */
  validateKeyCreation(params: {
    name: string;
    accountId: string;
    scopes: string[];
    ipConstraints?: { allowedIps: string[]; allowCidrs: string[] };
    expiresAt?: Date;
  }): ValidationResult {
    if (!params.name || params.name.trim() === '') {
      return {
        success: false,
        error: 'API key name is required'
      };
    }

    if (!params.accountId) {
      return {
        success: false,
        error: 'Account ID is required'
      };
    }

    const scopeValidation = this.validateScopes(params.scopes);
    if (!scopeValidation.success) {
      return scopeValidation;
    }

    if (params.ipConstraints) {
      if (params.ipConstraints.allowedIps && !Array.isArray(params.ipConstraints.allowedIps)) {
        return {
          success: false,
          error: 'allowedIps must be an array'
        };
      }

      if (params.ipConstraints.allowCidrs && !Array.isArray(params.ipConstraints.allowCidrs)) {
        return {
          success: false,
          error: 'allowCidrs must be an array'
        };
      }

      // Validate IP formats if provided
      if (params.ipConstraints.allowedIps && params.ipConstraints.allowedIps.length > 0) {
        const ipRegex = /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/;
        const invalidIps = params.ipConstraints.allowedIps.filter(ip => !ipRegex.test(ip));
        
        if (invalidIps.length > 0) {
          return {
            success: false,
            error: `Invalid IP addresses: ${invalidIps.join(', ')}`
          };
        }
      }
    }

    return { success: true };
  }

  /**
   * Validates key verification with timing attack protection
   * @param params Parameters for key verification
   * @returns ValidationResult with success and error message
   */
  validateKeyVerification(params: {
    key: string;
    expectedKeyId: string;
    expectedHash: string;
    actualHash: string;
    useTimingSafeEqual: boolean;
  }): ValidationResult {
    const formatValidation = this.validateApiKeyFormat(params.key);
    if (!formatValidation.success) {
      return formatValidation;
    }

    // Extract keyId from format fk_keyId_randomBits
    const keyId = params.key.split('_')[1];
    
    if (keyId !== params.expectedKeyId) {
      return {
        success: false,
        error: 'Key ID mismatch'
      };
    }

    if (!params.useTimingSafeEqual) {
      return {
        success: false,
        error: 'Timing-safe comparison must be used for key verification'
      };
    }

    return { success: true };
  }

  /**
   * Validates API key rate limiting logic
   * @param params Rate limiting parameters
   * @returns ValidationResult with success and error message
   */
  validateRateLimiting(params: {
    keyId: string;
    tier: string;
    limit: number;
    window: number;
    currentUsage: number;
    remainingPoints: number;
  }): ValidationResult {
    if (params.limit <= 0) {
      return {
        success: false,
        error: 'Rate limit must be positive'
      };
    }

    if (params.window <= 0) {
      return {
        success: false,
        error: 'Rate limit window must be positive'
      };
    }

    if (params.currentUsage < 0) {
      return {
        success: false,
        error: 'Current usage cannot be negative'
      };
    }

    if (params.remainingPoints < 0) {
      return {
        success: false,
        error: 'Remaining points cannot be negative'
      };
    }

    if (params.currentUsage + params.remainingPoints !== params.limit) {
      return {
        success: false,
        error: 'Current usage plus remaining points must equal the limit'
      };
    }

    return { success: true };
  }

  /**
   * Validates API key usage logging
   * @param params Logging parameters
   * @returns ValidationResult with success and error message
   */
  validateUsageLogging(params: {
    keyId: string;
    operation: string;
    ip: string;
    userAgent: string;
    success: boolean;
    errorType?: string;
  }): ValidationResult {
    if (!params.keyId) {
      return {
        success: false,
        error: 'Key ID is required for logging'
      };
    }

    if (!params.operation) {
      return {
        success: false,
        error: 'Operation name is required for logging'
      };
    }

    if (!params.ip) {
      return {
        success: false,
        error: 'IP address is required for logging'
      };
    }

    if (params.success === undefined) {
      return {
        success: false,
        error: 'Success status is required for logging'
      };
    }

    if (!params.success && !params.errorType) {
      return {
        success: false,
        error: 'Error type is required when success is false'
      };
    }

    // Record log entry for inspection
    if (!this.usageLogs.has(params.keyId)) {
      this.usageLogs.set(params.keyId, []);
    }
    
    this.usageLogs.get(params.keyId)?.push({
      timestamp: new Date(),
      ...params
    });

    return { success: true };
  }

  /**
   * Creates a test API key for verification purposes
   * @returns Generated test API key with metadata
   */
  generateTestApiKey() {
    const keyId = randomBytes(4).toString('hex');
    const secretPart = randomBytes(32).toString('hex');
    const key = `fk_${keyId}_${secretPart}`;
    
    const apiKey = {
      id: `test_${keyId}`,
      keyId,
      name: `Test Key ${keyId}`,
      hashedKey: `hashed_${key}`,
      accountId: 'test_account',
      scopes: [ApiKeyScope.READ_WALLET],
      status: ApiKeyStatus.ACTIVE,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    
    this.apiKeys.set(keyId, apiKey);
    
    return {
      apiKey,
      key
    };
  }

  /**
   * Creates test data for the verification environment
   */
  private seedTestData() {
    // Generate a few test keys
    for (let i = 0; i < 3; i++) {
      this.generateTestApiKey();
    }
  }

  /**
   * Finds a test API key by ID
   * @param keyId The key ID to find
   * @returns The found API key or null
   */
  findApiKey(keyId: string) {
    return this.apiKeys.get(keyId) || null;
  }

  /**
   * Gets usage logs for a key
   * @param keyId The key ID to get logs for
   * @returns Array of usage logs
   */
  getUsageLogs(keyId: string) {
    return this.usageLogs.get(keyId) || [];
  }
}

/**
 * Validation result interface
 */
export interface ValidationResult {
  success: boolean;
  error?: string;
}