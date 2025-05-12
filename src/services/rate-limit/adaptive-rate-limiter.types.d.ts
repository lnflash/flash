export enum RateLimitLevel {
  DEFAULT = "DEFAULT",
  PREMIUM = "PREMIUM",
  UNLIMITED = "UNLIMITED",
}

export type RateLimitConfig = {
  keyPrefix: string
  defaultPointsPerPeriod: {
    [key in RateLimitLevel]: number
  }
  defaultPeriod: number // in seconds
  maxPatternLength?: number
  suspiciousThreshold?: number
  throttleFactor?: number // e.g., 0.5 reduces limits by 50%
  throttleDuration?: number // in seconds
}

export type AdaptiveRateLimitResult = {
  limited: boolean
  limit: number
  remaining: number
  resetTime: number
  throttled: boolean
  adaptiveFactor: number
}

export type UsagePattern = {
  lastTimestamps: number[]
  intervalAverage: number | null
  standardDeviation: number | null
  adaptiveFactor: number
  throttled: boolean
  throttledUntil: number | null
}