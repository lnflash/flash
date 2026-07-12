import { yamlConfig } from "./yaml"

export const getApiKeyConfig = () => {
  return {
    maxKeysPerAccount: yamlConfig.apiKeys?.maxKeysPerAccount ?? 10,
    // Requests/minute applied to keys without a per-key rateLimitPerMinute
    defaultRequestsPerMinute: yamlConfig.apiKeys?.defaultRequestsPerMinute ?? 120,
  }
}
