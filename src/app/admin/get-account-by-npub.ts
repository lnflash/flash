/**
 * `Admin.getAccountByNpub` is `Accounts.findByNpub` under the admin barrel's
 * name — same validation, same normalisation rationale, same repository call.
 * A re-export rather than a copy so a fix (e.g. a bech32 validation upgrade)
 * cannot land in one and not the other. The admin unit spec stays pointed at
 * this module so registration coverage of the re-export survives.
 */
export { findByNpub as getAccountByNpub } from "@app/accounts/find-by-npub"
