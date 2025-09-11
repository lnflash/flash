import { yamlConfig } from "./yaml"

export const getApiTokenConfig = () => {
  return {
    maxTokensPerAccount: yamlConfig.apiTokens?.maxTokensPerAccount || 10,
    defaultExpirationDays: yamlConfig.apiTokens?.defaultExpirationDays || 90,
    tokenPrefix: yamlConfig.apiTokens?.tokenPrefix || "flash_"
  }
}