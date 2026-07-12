import { yamlConfig } from "./yaml"

export const getApiKeyConfig = () => {
  return {
    maxKeysPerAccount: yamlConfig.apiKeys?.maxKeysPerAccount ?? 10,
  }
}
