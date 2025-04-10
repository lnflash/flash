import fs from "fs"

import path from "path"

import Ajv from "ajv"
import yaml from "js-yaml"
import { I18n } from "i18n"

import { baseLogger } from "@services/logger"
import { checkedToScanDepth } from "@domain/bitcoin/onchain"
import { toSats } from "@domain/bitcoin"
import { toCents } from "@domain/fiat"

import { WithdrawalFeePriceMethod } from "@domain/wallets"

import { toDays, toSeconds } from "@domain/primitives"

import { WalletCurrency } from "@domain/shared"

import { AccountLevel } from "@domain/accounts"

import mergeWith from "lodash.mergewith"

import { configSchema } from "./schema"
import { ConfigError } from "./error"

// replaces array with override
const merge = (defaultConfig: unknown, customConfig: unknown) =>
  mergeWith(defaultConfig, customConfig, (a, b) => (Array.isArray(b) ? b : undefined))

const mergeYamls = (filePaths: string[]): Record<string, unknown> => {
  const mergedConfig: Record<string, unknown> = {};

  filePaths.forEach((filePath) => {
    try {
      const resolvedPath = path.resolve(filePath);
      const fileContent = fs.readFileSync(resolvedPath, "utf8");
      const parsedConfig = yaml.load(fileContent) as Record<string, unknown>;

      merge(mergedConfig, parsedConfig)

      baseLogger.info(`Successfully loaded config from ${resolvedPath}`);
    } catch (err) {
      baseLogger.warn({ err, filePath }, `Failed to load config from ${filePath}`);
    }
  });

  return mergedConfig;
};


const DEFAULT_CONFIG_PATH = "/var/yaml/custom.yaml"
const getYamlPaths = () => {
  if (process.argv.length > 2)
    return process.argv.slice(2).map(p => path.resolve(p))
  else 
    return [DEFAULT_CONFIG_PATH]
}
const paths = getYamlPaths()
const yamlConfigInit = mergeYamls(paths) // merge(defaultConfig, customConfig)

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

export const getCaptcha = (config = yamlConfig): CaptchaConfig => config.captcha

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

export const getSmsAuthUnsupportedCountries = (): CountryCode[] => {
  return yamlConfig.smsAuthUnsupportedCountries as CountryCode[]
}

export const getWhatsAppAuthUnsupportedCountries = (): CountryCode[] => {
  return yamlConfig.whatsAppAuthUnsupportedCountries as CountryCode[]
}

export const JmdPrice = {
  ...yamlConfig.exchangeRates["USD"]["JMD"]
} as PriceSpread

export const Cashout = {
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
  }

}

export const MailgunConfig = yamlConfig.mailgun as MailgunConfig

export const IbexConfig = yamlConfig.ibex as IbexConfig