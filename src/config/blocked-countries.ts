// Destinations whose auth-code traffic we refuse to pay for.
//
// Every country here sent us auth-code traffic with zero conversions over the
// full Twilio retention window, and each was a source of the 2026-08-25
// SMS-pumping attack. Countries with even one real signup (JM, US, NG, IN, GB,
// CA, DE, GH, KY, BJ, RW, SD, CD, MV, BD, BE, UG, TT, ML, CO, SK) are absent by
// design: this is a fraud control, not a market policy. SN was removed on
// 2026-09-02: Senegal (Dakar) is a served market for the US virtual account.
//
// INVARIANT — no entry may share a calling code with a region that is NOT
// blocked. `checkAuthCodeDestination` cannot always name the region of a number
// it parses (~340 assigned NANP area codes are missing from the pinned
// libphonenumber-js metadata), so it falls back to gating such a number against
// EVERY region its calling code could denote, and blocks if any of them is
// blocked. Adding DO (+1 809/829/849) or any other NANP region to this list
// would therefore reject ordinary US numbers on those overlays — silently, from
// a routine configmap edit. `reportAmbiguousBlockedCountries` in
// src/config/yaml.ts re-checks the merged configmap at startup and LOGS AT
// ERROR LEVEL for a NANP entry — it does not throw, so a bad configmap entry
// ships and a Ready pod quietly rejects those numbers; the log line is the only
// backstop. Only the defaults below are pinned hard, by
// test/flash/unit/config/schema.spec.ts.
//
// This list lives in its own file so typos.toml can exclude the ISO 3166-1
// alpha-2 codes ("BA" is read as a misspelling of "BY"/"BE", and BY is itself
// an entry here) without either opening a repo-global spell-check hole or
// dropping the live config file src/config/schema.ts from spell checking.
export const SMS_PUMPING_HIGH_RISK_COUNTRIES = [
  "TR",
  "UZ",
  "RU",
  "IL",
  "AM",
  "UA",
  "TZ",
  "EC",
  "BY",
  "ZM",
  "MR",
  "BA",
  "TN",
  "CI",
  "BI",
  "TG",
  "VE",
  "XK",
  "GN",
  "SL",
  "CM",
  "MZ",
  "CF",
  "LB",
]
