import fs from "fs"

import path from "path"

import Ajv from "ajv"
import { load as loadYaml } from "js-yaml"
import { I18n } from "i18n"
import { getCountries, getCountryCallingCode } from "libphonenumber-js"

import { baseLogger } from "@services/logger"
import { checkedToScanDepth } from "@domain/bitcoin/onchain"
import { toSats } from "@domain/bitcoin"
import { toCents } from "@domain/fiat"

import { WithdrawalFeePriceMethod } from "@domain/wallets"

import { toDays, toSeconds } from "@domain/primitives"

import { BigIntConversionError, JMDAmount, WalletCurrency } from "@domain/shared"

import { AccountLevel } from "@domain/accounts"
import { DAILY_INVITE_LIMIT, TARGET_INVITE_LIMIT } from "@domain/invite"

import mergeWith from "lodash.mergewith"

import yargs from "yargs"

import { configSchema } from "./schema"
import { ConfigError } from "./error"

const argv =
  // .help()
  yargs(process.argv.slice(2)).option("configPath", {
    alias: "c",
    type: "array",
    description: "Paths to YAML configuration files",
    demandOption: true,
  }).argv as { configPath: string[] }

// replaces array with override
const merge = (defaultConfig: unknown, customConfig: unknown) =>
  mergeWith(defaultConfig, customConfig, (a, b) => (Array.isArray(b) ? b : undefined))

export const mergeYamls = (filePaths: string[]): Record<string, unknown> => {
  const mergedConfig: Record<string, unknown> = {}

  filePaths.forEach((filePath) => {
    try {
      const resolvedPath = path.resolve(filePath)
      const fileContent = fs.readFileSync(resolvedPath, "utf8")
      const parsedConfig = loadYaml(fileContent) as Record<string, unknown>

      merge(mergedConfig, parsedConfig)

      baseLogger.info(`Successfully loaded config from ${resolvedPath}`)
    } catch (err) {
      baseLogger.warn({ err, filePath }, `Failed to load config from ${filePath}`)
    }
  })

  return mergedConfig
}

const paths = argv.configPath.map((p: string) => path.resolve(p))
const yamlConfigInit = mergeYamls(paths)

// TODO: fix errors
// const ajv = new Ajv({ allErrors: true, strict: "log" })
const ajv = new Ajv({ useDefaults: true })
const validate = ajv.compile<YamlSchema>(configSchema)

const valid = validate(yamlConfigInit)

if (!valid) {
  baseLogger.error({ validationErrors: validate.errors }, "Invalid yaml configuration")
  throw new ConfigError("Invalid yaml configuration", validate.errors)
}
export const yamlConfig = yamlConfigInit as YamlSchema

export const RATIO_PRECISION: number = yamlConfig.ratioPrecision

export const MEMO_SHARING_SATS_THRESHOLD = yamlConfig.spamLimits
  .memoSharingSatsThreshold as Satoshis
export const MEMO_SHARING_CENTS_THRESHOLD = yamlConfig.spamLimits
  .memoSharingCentsThreshold as UsdCents

// how many block are we looking back for getChainTransactions
const getOnChainScanDepth = (val: number): ScanDepth => {
  const scanDepth = checkedToScanDepth(val)
  if (scanDepth instanceof Error) throw scanDepth
  return scanDepth
}

export const ONCHAIN_MIN_CONFIRMATIONS = getOnChainScanDepth(
  yamlConfig.onChainWallet.minConfirmations,
)

export const ONCHAIN_SCAN_DEPTH = getOnChainScanDepth(yamlConfig.onChainWallet.scanDepth)
export const ONCHAIN_SCAN_DEPTH_OUTGOING = getOnChainScanDepth(
  yamlConfig.onChainWallet.scanDepthOutgoing,
)
export const ONCHAIN_SCAN_DEPTH_CHANNEL_UPDATE = getOnChainScanDepth(
  yamlConfig.onChainWallet.scanDepthChannelUpdate,
)

export const USER_ACTIVENESS_MONTHLY_VOLUME_THRESHOLD = toCents(
  yamlConfig.userActivenessMonthlyVolumeThreshold,
)

export const getBriaPartialConfigFromYaml = () => ({
  hotWalletName: yamlConfig.bria.hotWalletName,
  queueNames: yamlConfig.bria.queueNames,
  coldStorage: yamlConfig.bria.coldStorage,
})

export const getLightningAddressDomain = (): string => yamlConfig.lightningAddressDomain
export const getLightningAddressDomainAliases = (): string[] =>
  yamlConfig.lightningAddressDomainAliases
export const getLocale = (): UserLanguage => yamlConfig.locale as UserLanguage

export const getValuesToSkipProbe = (): SkipFeeProbeConfig => {
  return {
    pubkey: (yamlConfig.skipFeeProbeConfig.pubkey || []) as Pubkey[],
    chanId: (yamlConfig.skipFeeProbeConfig.chanId || []) as ChanId[],
  }
}

const i18n = new I18n()
i18n.configure({
  objectNotation: true,
  updateFiles: false,
  locales: ["en", "es"],
  defaultLocale: "en",
  retryInDefaultLocale: true,
  directory: path.join(__dirname, "locales"),
})

export const getI18nInstance = (): I18n => i18n

export const getDisplayCurrencyConfig = (): {
  code: DisplayCurrency
  symbol: string
} => ({
  code: yamlConfig.displayCurrency.code as DisplayCurrency,
  symbol: yamlConfig.displayCurrency.symbol,
})

export const getDealerConfig = () => yamlConfig.dealer

export const getFeesConfig = (feesConfig = yamlConfig.fees): FeesConfig => {
  const method = feesConfig.withdraw.method as WithdrawalFeePriceMethod
  const depositRatioAsBasisPoints = BigInt(
    feesConfig.deposit.ratioAsBasisPoints,
  ) as DepositFeeRatioAsBasisPoints
  const withdrawRatioAsBasisPoints =
    method === WithdrawalFeePriceMethod.flat
      ? 0n
      : BigInt(feesConfig.withdraw.ratioAsBasisPoints)

  return {
    depositDefaultMin: {
      amount: BigInt(feesConfig.deposit.defaultMin),
      currency: WalletCurrency.Btc,
    },
    depositThreshold: {
      amount: BigInt(feesConfig.deposit.threshold),
      currency: WalletCurrency.Btc,
    },
    depositRatioAsBasisPoints,
    withdrawMethod: method,
    withdrawRatioAsBasisPoints,
    withdrawThreshold: toSats(feesConfig.withdraw.threshold),
    withdrawDaysLookback: toDays(feesConfig.withdraw.daysLookback),
    withdrawDefaultMin: toSats(feesConfig.withdraw.defaultMin),
  }
}

export const getAccountLimits = ({
  level,
  accountLimits = yamlConfig.accountLimits,
}: AccountLimitsArgs): IAccountLimits => {
  return {
    intraLedgerLimit: toCents(accountLimits.intraLedger.level[level]),
    withdrawalLimit: toCents(accountLimits.withdrawal.level[level]),
    tradeIntraAccountLimit: toCents(accountLimits.tradeIntraAccount.level[level]),
  }
}

const getRateLimits = (config: RateLimitInput): RateLimitOptions => {
  /**
   * Returns a subset of the required parameters for the
   * 'rate-limiter-flexible.RateLimiterRedis' object.
   */
  return {
    points: config.points,
    duration: toSeconds(config.duration),
    blockDuration: toSeconds(config.blockDuration),
  }
}

export const getRequestCodePerLoginIdentifierLimits = () =>
  getRateLimits(yamlConfig.rateLimits.requestCodePerLoginIdentifier)

export const getRequestCodePerIpLimits = () =>
  getRateLimits(yamlConfig.rateLimits.requestCodePerIp)

/**
 * Auth-code requests for a country whose destinations we refuse to pay for,
 * per IP.
 *
 * The country gate rejects these before any provider spend, which is the point
 * — but it also means probing costs the attacker nothing, and the existing-user
 * carve-out makes the response differ by whether the number holds an account.
 * That is an account-existence oracle, and the per-IP request-code budget (8/h)
 * is far too generous to bound it. Tighter than that budget: a confirmed
 * account refunds its point, so only sweeps over numbers that do NOT exist burn
 * it.
 *
 * Not tighter still. This bucket is keyed on `req.originalIp`, so it is spent
 * by mistyped numbers and shared by everyone behind one office NAT or CGNAT
 * egress. At 2 points a real UZ account holder who fat-fingers their number
 * twice is denied their own login code for an hour, and so is the second person
 * behind a shared address — no attacker involved. The bound 2 bought over 5 is
 * negligible anyway: a sweep is equally dead at 5/IP/h, and the 2026-08-25
 * attacker drove ~100 rotating IPs, so the per-IP ceiling was never the binding
 * constraint on enumeration.
 */
export const getRequestCodeBlockedCountryPerIpLimits = () => ({
  points: 5,
  duration: toSeconds(3600), // 1 hour
  // One hour, NOT the 24 used by the other auth limiters. This one is keyed on
  // `req.originalIp` (the `x-real-ip` header), and a large share of Flash's
  // users reach us from behind carrier-grade NAT — one mobile egress address
  // covers many subscribers. A 24h block means two sweep probes from that
  // address cost every real customer behind it a full day of their own login
  // codes. The bound that actually limits a sweep is `points` probes/IP/hour;
  // the shorter block only decides how fast a shared-IP false positive heals.
  blockDuration: toSeconds(3600), // 1 hour
})

export const getFailedLoginAttemptPerLoginIdentifierLimits = () =>
  getRateLimits(yamlConfig.rateLimits.failedLoginAttemptPerLoginIdentifier)

export const getFailedLoginAttemptPerIpLimits = () =>
  getRateLimits(yamlConfig.rateLimits.failedLoginAttemptPerIp)

export const getInvoiceCreateAttemptLimits = () =>
  getRateLimits(yamlConfig.rateLimits.invoiceCreateAttempt)

export const getInvoiceCreateForRecipientAttemptLimits = () =>
  getRateLimits(yamlConfig.rateLimits.invoiceCreateForRecipientAttempt)

export const getOnChainAddressCreateAttemptLimits = () =>
  getRateLimits(yamlConfig.rateLimits.onChainAddressCreateAttempt)

export const getInviteCreateAttemptLimits = () => ({
  points: DAILY_INVITE_LIMIT,
  duration: toSeconds(86400), // 24 hours
  blockDuration: toSeconds(86400), // 24 hours
})

export const getInviteTargetAttemptLimits = () => ({
  points: TARGET_INVITE_LIMIT,
  duration: toSeconds(86400), // 24 hours
  blockDuration: toSeconds(86400), // 24 hours
})

/**
 * Card top-up checkout links, per account.
 *
 * Every call runs an ERPNext list query for the trailing-24h history — the same
 * read every other top-up depends on, and one whose failure mode refuses card
 * top-ups for EVERY user. Amounts below the minimum do not short-circuit before
 * it (that gate sits after the history gate), so an unbounded mutation is an
 * unbounded ERPNext load an authenticated client can point at a shared
 * dependency. Generous against real use: minting more than a few links a minute
 * is not a customer topping up.
 */
export const getFygaroCheckoutCreateAttemptLimits = () => ({
  points: 10,
  duration: toSeconds(60), // 1 minute
  blockDuration: toSeconds(300), // 5 minutes
})

/**
 * The card top-up allowance READ, per account.
 *
 * Cheaper to abuse than the mutation it sits next to, not dearer: it takes no
 * amount, so none of the deterministic gates can short-circuit it, and every
 * single call reaches the trailing-24h ERPNext list query — the read whose
 * failure refuses card top-ups for EVERY user. Both fields are blocked for API
 * keys, so every caller is a Kratos session, and the API-key limiter waves
 * those straight through; without this there is no request-rate limit on the
 * path at all.
 *
 * Looser than the mutation because the honest client behaviour is different: a
 * screen renders this, and a customer editing an amount or backgrounding and
 * reopening the app can legitimately ask several times a minute. Minting links
 * that often is not.
 */
export const getFygaroTopupAllowanceAttemptLimits = () => ({
  points: 30,
  duration: toSeconds(60), // 1 minute
  blockDuration: toSeconds(60), // 1 minute
})

export const getOnChainWalletConfig = () => ({
  dustThreshold: yamlConfig.onChainWallet.dustThreshold,
})

export const getColdStorageConfig = (): ColdStorageConfig => {
  const config = yamlConfig.coldStorage

  return {
    minOnChainHotWalletBalance: toSats(config.minOnChainHotWalletBalance),
    maxHotWalletBalance: toSats(config.maxHotWalletBalance),
    minRebalanceSize: toSats(config.minRebalanceSize),
  }
}

export const getBuildVersions = (): {
  minBuildNumberAndroid: number
  lastBuildNumberAndroid: number
  minBuildNumberIos: number
  lastBuildNumberIos: number
} => {
  const { android, ios } = yamlConfig.buildVersion

  return {
    minBuildNumberAndroid: android.minBuildNumber,
    lastBuildNumberAndroid: android.lastBuildNumber,
    minBuildNumberIos: ios.minBuildNumber,
    lastBuildNumberIos: ios.lastBuildNumber,
  }
}

export const getIpConfig = (config = yamlConfig): IpConfig => ({
  ipRecordingEnabled: config.ipRecording.enabled,
  proxyCheckingEnabled: config.ipRecording.proxyChecking.enabled,
})

export const LND_SCB_BACKUP_BUCKET_NAME = yamlConfig.lndScbBackupBucketName

export const getAdminAccounts = (config = yamlConfig): AdminAccount[] =>
  config.admin_accounts.map((account) => ({
    role: account.role as AdminRole,
    phone: account.phone as PhoneNumber,
  }))

export const getTestAccounts = (config = yamlConfig): TestAccount[] =>
  config.test_accounts.map((account) => ({
    phone: account.phone as PhoneNumber,
    code: account.code as PhoneCode,
  }))

export const getCronConfig = (config = yamlConfig): CronConfig => config.cronConfig

export const getDefaultFCMTopics = (config = yamlConfig): string[] =>
  config.fcmTopics.filter((t) => t.default).map((t) => t.name)
export const getFCMTopics = (config = yamlConfig): string[] =>
  config.fcmTopics.map((t) => t.name)

export const getCaptcha = (config = yamlConfig): CaptchaConfig => config.captcha

export const getReferralRewardConfig = (): {
  enabled: boolean
  tiers: { upToCount: number; amountCents: number }[]
} => ({
  enabled: yamlConfig.referralReward?.enabled ?? false,
  tiers: yamlConfig.referralReward?.tiers ?? [],
})

export const getRewardsConfig = (): RewardsConfig => {
  const denyPhoneCountries = yamlConfig.rewards.denyPhoneCountries || []
  const allowPhoneCountries = yamlConfig.rewards.allowPhoneCountries || []
  const denyIPCountries = yamlConfig.rewards.denyIPCountries || []
  const allowIPCountries = yamlConfig.rewards.allowIPCountries || []
  const denyASNs = yamlConfig.rewards.denyASNs || []
  const allowASNs = yamlConfig.rewards.allowASNs || []

  return {
    phoneMetadataValidationSettings: {
      denyCountries: denyPhoneCountries.map((c) => c.toUpperCase()),
      allowCountries: allowPhoneCountries.map((c) => c.toUpperCase()),
    },
    ipMetadataValidationSettings: {
      denyCountries: denyIPCountries.map((c) => c.toUpperCase()),
      allowCountries: allowIPCountries.map((c) => c.toUpperCase()),
      denyASNs: denyASNs.map((c) => c.toUpperCase()),
      allowASNs: allowASNs.map((c) => c.toUpperCase()),
      checkProxy: yamlConfig.rewards.enableIpProxyCheck,
    },
  }
}

export const getDefaultAccountsConfig = (config = yamlConfig): AccountsConfig => ({
  initialStatus: config.accounts.initialStatus as AccountStatus,
  initialWallets: config.accounts.initialWallets,
  initialLevel: AccountLevel.One,
})

export const getAccountsOnboardConfig = (config = yamlConfig): AccountsOnboardConfig => {
  const { enablePhoneCheck, enableIpCheck, enableIpProxyCheck } = config.accounts

  const denyPhoneCountries = config.accounts.denyPhoneCountries || []
  const allowPhoneCountries = config.accounts.allowPhoneCountries || []
  const denyIPCountries = config.accounts.denyIPCountries || []
  const allowIPCountries = config.accounts.allowIPCountries || []
  const denyASNs = config.accounts.denyASNs || []
  const allowASNs = config.accounts.allowASNs || []

  return {
    phoneMetadataValidationSettings: {
      enabled: enablePhoneCheck,
      denyCountries: denyPhoneCountries.map((c) => c.toUpperCase()),
      allowCountries: allowPhoneCountries.map((c) => c.toUpperCase()),
    },
    ipMetadataValidationSettings: {
      enabled: enableIpCheck,
      denyCountries: denyIPCountries.map((c) => c.toUpperCase()),
      allowCountries: allowIPCountries.map((c) => c.toUpperCase()),
      denyASNs: denyASNs.map((c) => c.toUpperCase()),
      allowASNs: allowASNs.map((c) => c.toUpperCase()),
      checkProxy: enableIpProxyCheck,
    },
  }
}

export const getSwapConfig = (): SwapConfig => {
  const config = yamlConfig.swap
  return {
    loopOutWhenHotWalletLessThan: {
      amount: BigInt(config.loopOutWhenHotWalletLessThan),
      currency: WalletCurrency.Btc,
    },
    swapOutAmount: { amount: BigInt(config.swapOutAmount), currency: WalletCurrency.Btc },
    lnd1loopRestEndpoint: config.lnd1loopRestEndpoint,
    lnd2loopRestEndpoint: config.lnd2loopRestEndpoint,
    lnd1loopRpcEndpoint: config.lnd1loopRpcEndpoint,
    lnd2loopRpcEndpoint: config.lnd2loopRpcEndpoint,
    swapProviders: config.swapProviders,
    feeAccountingEnabled: config.feeAccountingEnabled,
  }
}

// Countries hidden from the client's country picker. Presentation only — a
// country listed here can never be selected in the app, so nothing in it ever
// reaches the auth-code endpoint.
export const getSmsAuthUnsupportedCountries = (): CountryCode[] => {
  return yamlConfig.smsAuthUnsupportedCountries as CountryCode[]
}

export const getWhatsAppAuthUnsupportedCountries = (): CountryCode[] => {
  return yamlConfig.whatsAppAuthUnsupportedCountries as CountryCode[]
}

// Countries whose auth-code destinations are refused server-side before any
// provider spend. Deliberately separate from the picker lists above: the
// existing-user carve-out only works if the country can still be selected.
export const getSmsAuthBlockedCountries = (): CountryCode[] => {
  return yamlConfig.smsAuthBlockedCountries as CountryCode[]
}

export const getWhatsAppAuthBlockedCountries = (): CountryCode[] => {
  return yamlConfig.whatsAppAuthBlockedCountries as CountryCode[]
}

const NANP_CALLING_CODE = "1"

/**
 * Reports blocked countries that share a calling code with a region that is NOT
 * blocked.
 *
 * `checkAuthCodeDestination` cannot always name the region of a number it
 * parses — ~340 assigned NANP area codes are absent from the pinned
 * libphonenumber-js metadata — so it falls back to gating such a number against
 * EVERY region its calling code could denote, and fails closed if any of them
 * is blocked. Every entry on the list therefore blocks its unattributable
 * siblings too.
 *
 * `+1` is a different order of severity from the rest, so it gets its own
 * level. Blocking any NANP region (DO's 809/829/849, say) rejects ordinary US
 * numbers on +1 983 / +1 738 / +1 924 / +1 472 — a core market, broken silently
 * by a one-line configmap edit. Any other shared calling code costs a market we
 * did not choose to block (today: KZ, behind RU on +7), which is worth a
 * warning but is a deliberate trade.
 *
 * Checked here, against the MERGED config, because the list is operator-tunable
 * from the ops feed: a configmap can break this without touching the schema
 * default that test/flash/unit/config/schema.spec.ts pins. Logged, not thrown —
 * a bad entry must be loud, but must not wedge every pod in a crash loop at 3am.
 */
export const reportAmbiguousBlockedCountries = (
  key: string,
  blocked: readonly string[],
): void => {
  // libphonenumber's own region type, not the branded domain `CountryCode`.
  type Region = ReturnType<typeof getCountries>[number]

  const normalized = new Set(blocked.map((code) => code.toUpperCase()))

  for (const code of normalized) {
    let callingCode: string
    try {
      callingCode = getCountryCallingCode(code as Region)
    } catch {
      // Not a region libphonenumber knows (XK, say). It can never be a parsed
      // number's region, so it cannot widen a candidate set either.
      continue
    }

    const unblockedSiblings = getCountries().filter(
      (country) =>
        country !== code &&
        getCountryCallingCode(country) === callingCode &&
        !normalized.has(country),
    )
    if (unblockedSiblings.length === 0) continue

    const payload = { key, blockedCountry: code, callingCode, unblockedSiblings }

    if (callingCode === NANP_CALLING_CODE) {
      baseLogger.error(
        payload,
        `${key} blocks the NANP region ${code}: every +1 number whose region ` +
          `libphonenumber cannot identify (~340 assigned US area codes) will now ` +
          `be refused an auth code. Remove it.`,
      )
      continue
    }

    baseLogger.warn(
      payload,
      `${key} blocks ${code} (+${callingCode}), which shares that calling code ` +
        `with ${unblockedSiblings.join(", ")}: numbers on it whose region cannot ` +
        `be identified are refused for those regions too.`,
    )
  }
}

reportAmbiguousBlockedCountries(
  "smsAuthBlockedCountries",
  yamlConfig.smsAuthBlockedCountries as string[],
)
reportAmbiguousBlockedCountries(
  "whatsAppAuthBlockedCountries",
  yamlConfig.whatsAppAuthBlockedCountries as string[],
)

const { ask } = yamlConfig.exchangeRates["USD"]["JMD"]
const sellRate = JMDAmount.dollars(ask)
if (sellRate instanceof BigIntConversionError) throw sellRate
export const ExchangeRates = {
  jmd: { sell: sellRate },
}

export const Cashout = {
  Enabled: yamlConfig.cashout.enabled as boolean,
  SkipPayment: (yamlConfig.cashout.skipPayment ?? false) as boolean,
  OfferConfig: {
    fee: BigInt(yamlConfig.cashout.fee) as BasisPoints,
    duration: yamlConfig.cashout.duration as Seconds,
  } as CashoutConfig,
  validations: {
    minimum: {
      amount: BigInt(yamlConfig.cashout.minimum.amount),
      currency: yamlConfig.cashout.minimum.currency as WalletCurrency,
    },
    maximum: {
      amount: BigInt(yamlConfig.cashout.maximum.amount),
      currency: yamlConfig.cashout.maximum.currency as WalletCurrency,
    },
    accountLevel: yamlConfig.cashout.accountLevel as AccountLevel,
  },
  Email: {
    to: yamlConfig.cashout.email.to,
    from: yamlConfig.cashout.email.from,
    subject: yamlConfig.cashout.email.subject,
  },
}

export const Topup = {
  Enabled: (yamlConfig.topup?.enabled ?? false) as boolean,
}

export const SendGridConfig = yamlConfig.sendgrid as SendGridConfig

export const IbexConfig = yamlConfig.ibex as IbexConfig

export const BridgeConfig = yamlConfig.bridge as BridgeConfig

export const FygaroConfig = yamlConfig.fygaro as FygaroConfig

export const FrappeConfig = yamlConfig.frappe as FrappeConfig
