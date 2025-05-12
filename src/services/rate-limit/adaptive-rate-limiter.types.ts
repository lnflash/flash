export enum RateLimitLevel {
  DEFAULT = "DEFAULT",
  PREMIUM = "PREMIUM",
  ENTERPRISE = "ENTERPRISE",
  UNLIMITED = "UNLIMITED",
}

export const RATE_LIMIT_POINTS = {
  [RateLimitLevel.DEFAULT]: 100,
  [RateLimitLevel.PREMIUM]: 600,
  [RateLimitLevel.ENTERPRISE]: 3000,
  [RateLimitLevel.UNLIMITED]: 10000,
};

export const RATE_LIMIT_DURATION = 60; // 1 minute