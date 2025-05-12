import { GT } from "@graphql/index"
import { ApiKeyStatus, ApiKeyType } from "@domain/api-keys"

export const ApiKeyStatusType = GT.Enum({
  name: "ApiKeyStatus",
  description: "Status of an API key",
  values: {
    ACTIVE: { value: ApiKeyStatus.Active },
    REVOKED: { value: ApiKeyStatus.Revoked },
    EXPIRED: { value: ApiKeyStatus.Expired },
    ROTATING: { value: ApiKeyStatus.Rotating },
  },
})

export const ApiKeyTypeType = GT.Enum({
  name: "ApiKeyType",
  description: "Type of an API key",
  values: {
    TEST: { value: ApiKeyType.Test },
    LIVE: { value: ApiKeyType.Live },
  },
})

export const ApiKeyObjectType = GT.Object({
  name: "ApiKey",
  description: "API key for accessing the Flash API",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description: "Unique identifier for the API key",
    },
    name: {
      type: GT.NonNull(GT.String),
      description: "Name of the API key",
    },
    type: {
      type: GT.NonNull(ApiKeyTypeType),
      description: "Type of the API key (test or live)",
    },
    scopes: {
      type: GT.NonNullList(GT.String),
      description: "Permissions granted to the API key",
    },
    status: {
      type: GT.NonNull(ApiKeyStatusType),
      description: "Status of the API key",
    },
    createdAt: {
      type: GT.NonNull(GT.String),
      description: "When the API key was created",
    },
    expiresAt: {
      type: GT.String,
      description: "When the API key expires (if applicable)",
    },
    lastUsedAt: {
      type: GT.String,
      description: "When the API key was last used",
    },
    tier: {
      type: GT.NonNull(GT.String),
      description: "Service tier for the API key",
    },
  }),
})

export const ApiKeyWithSecretType = GT.Object({
  name: "ApiKeyWithSecret",
  description: "API key with secret for accessing the Flash API",
  fields: () => ({
    id: {
      type: GT.NonNullID,
      description: "Unique identifier for the API key",
    },
    name: {
      type: GT.NonNull(GT.String),
      description: "Name of the API key",
    },
    type: {
      type: GT.NonNull(ApiKeyTypeType),
      description: "Type of the API key (test or live)",
    },
    scopes: {
      type: GT.NonNullList(GT.String),
      description: "Permissions granted to the API key",
    },
    status: {
      type: GT.NonNull(ApiKeyStatusType),
      description: "Status of the API key",
    },
    createdAt: {
      type: GT.NonNull(GT.String),
      description: "When the API key was created",
    },
    expiresAt: {
      type: GT.String,
      description: "When the API key expires (if applicable)",
    },
    lastUsedAt: {
      type: GT.String,
      description: "When the API key was last used",
    },
    tier: {
      type: GT.NonNull(GT.String),
      description: "Service tier for the API key",
    },
    apiKey: {
      type: GT.NonNull(GT.String),
      description: "The API key value (only returned once when created)",
    },
  }),
})

export const ApiKeyRotationStatusType = GT.Enum({
  name: "ApiKeyRotationStatus",
  description: "Status of an API key rotation",
  values: {
    PENDING: { value: "pending" },
    IN_PROGRESS: { value: "in_progress" },
    COMPLETED: { value: "completed" },
    FAILED: { value: "failed" },
  },
})

export const ApiKeyRotationType = GT.Object({
  name: "ApiKeyRotation",
  description: "Information about an API key rotation",
  fields: () => ({
    originalKeyId: {
      type: GT.NonNull(GT.String),
      description: "ID of the original API key",
    },
    newKeyId: {
      type: GT.NonNull(GT.String),
      description: "ID of the new API key",
    },
    status: {
      type: GT.NonNull(ApiKeyRotationStatusType),
      description: "Status of the rotation",
    },
    startedAt: {
      type: GT.NonNull(GT.String),
      description: "When the rotation was started",
    },
    completedAt: {
      type: GT.String,
      description: "When the rotation was completed (if applicable)",
    },
    transitionPeriod: {
      type: GT.NonNull(GT.Int),
      description: "Transition period in days",
    },
  }),
})

// Input types for creating and updating API keys
export const CreateApiKeyInput = GT.Input({
  name: "CreateApiKeyInput",
  fields: {
    name: {
      type: GT.NonNull(GT.String),
      description: "Name of the API key",
    },
    type: {
      type: GT.NonNull(ApiKeyTypeType),
      description: "Type of the API key (test or live)",
    },
    scopes: {
      type: GT.NonNullList(GT.String),
      description: "Permissions to grant to the API key",
    },
    expiresAt: {
      type: GT.String,
      description: "When the API key should expire (ISO string)",
    },
    tier: {
      type: GT.String,
      description: "Service tier for the API key",
    },
    metadata: {
      type: GT.String,
      description: "JSON string of additional metadata",
    },
  },
})

export const UpdateApiKeyInput = GT.Input({
  name: "UpdateApiKeyInput",
  fields: {
    name: {
      type: GT.String,
      description: "New name for the API key",
    },
    scopes: {
      type: GT.List(GT.NonNull(GT.String)),
      description: "New permissions to grant to the API key",
    },
    expiresAt: {
      type: GT.String,
      description: "New expiration date (ISO string, null to remove expiration)",
    },
    tier: {
      type: GT.String,
      description: "New service tier for the API key",
    },
    metadata: {
      type: GT.String,
      description: "JSON string of additional metadata",
    },
  },
})

export const RotateApiKeyInput = GT.Input({
  name: "RotateApiKeyInput",
  fields: {
    transitionPeriodDays: {
      type: GT.Int,
      description: "Transition period in days (defaults to 7)",
    },
  },
})