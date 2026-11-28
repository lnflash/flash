import { parseLiveSettings, parseScopes } from "@services/pos-usdt-checkout/live-config"

const base = {
  POS_USDT_LIVE_UPDATES_ENABLED: "true",
  POS_USDT_LIVE_APNS_ENVIRONMENT: "sandbox",
  POS_USDT_LIVE_SCOPES: "https://api.test.flashapp.me/graphql",
}

it("is off unless explicitly enabled", () => {
  expect(parseLiveSettings({}).ok).toBe(false)
  expect(parseLiveSettings({ ...base, POS_USDT_LIVE_UPDATES_ENABLED: "1" }).ok).toBe(
    false,
  )
})

it.each([[undefined], ["production"], ["Sandbox"], ["development"]])(
  "never turns on for APNs environment %p",
  (environment) => {
    const parsed = parseLiveSettings({
      ...base,
      POS_USDT_LIVE_APNS_ENVIRONMENT: environment,
    })
    expect(parsed).toEqual({
      ok: false,
      reason: "POS_USDT_LIVE_APNS_ENVIRONMENT is not sandbox",
    })
  },
)

it("defaults to a one-hour follow window, bounded by ActivityKit's eight hours", () => {
  expect(parseLiveSettings(base)).toEqual({
    ok: true,
    value: { scopes: ["https://api.test.flashapp.me/graphql"], followMs: 3_600_000 },
  })
  expect(parseLiveSettings({ ...base, POS_USDT_LIVE_FOLLOW_MINUTES: "480" }).ok).toBe(
    true,
  )
  for (const minutes of ["481", "0", "1.5", "-5", "abc"])
    expect(parseLiveSettings({ ...base, POS_USDT_LIVE_FOLLOW_MINUTES: minutes }).ok).toBe(
      false,
    )
})

it("accepts the endpoints the app hashes, exactly", () => {
  expect(
    parseScopes(
      "https://api.test.flashapp.me/graphql,http://mlod.local:18588/simulation",
    ),
  ).toEqual({
    ok: true,
    value: ["https://api.test.flashapp.me/graphql", "http://mlod.local:18588/simulation"],
  })
  for (const bad of [
    "",
    "HTTPS://API.TEST.FLASHAPP.ME/graphql",
    "https://api.test.flashapp.me",
    "https://user:pw@api.test.flashapp.me/graphql",
    "https://api.test.flashapp.me/graphql?x=1",
    "ftp://api.test.flashapp.me/graphql",
    "a,b,c,d",
  ])
    expect(parseScopes(bad).ok).toBe(false)
})
