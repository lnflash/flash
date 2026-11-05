# Device account authenticator policy

This source slice is based on integrated backend `94d009004` and RN
`2afeece8ac74e663376c483018011f30d89fd227`. It makes no provider calls in tests
and does not configure or release an identity provider.

## The recovery gap

The active RN account screen (`app/screens/settings-screen/account-screen.tsx`)
shows the TOTP row to beta users with `enabled: true`, without checking identity
schema or a usable phone login. Its TOTP initiate/validate screens use the current
session token. Native account security similarly offers enrollment to an
authenticated user. Account tier and a Mongo phone field are not proof of an
identity-provider phone login.

The Basic device REST route returns only `{ result: authToken }`. Its new durable
bootstrap intentionally rejects device identities that already have TOTP with
`DEVICE_BOOTSTRAP_INCOMPATIBLE_IDENTITY`; it has no `totpRequired` continuation.
Phone/email login already supports a provisional token followed by real TOTP
elevation. Adding TOTP to a device-only identity can therefore leave the user
without a supported login route after their current session stops working.

Normal email/phone registration is not a workaround: the Kratos helpers in
`auth-email-no-password.ts` accept only the existing phone/email schemas, not
`username_password_deviceid_v0`. `kratosRemoveTotp` also refreshes with only
`traits.phone || traits.email`, so a device-only identity cannot depend on that
method to undo enrollment. Local credential regeneration, removing a factor
without its required authority, or accepting an AAL1 Basic bearer as completed
TOTP authentication would be unsafe continuations.

## Narrow server boundary

Both Flash enrollment entry points now require `authorizeTotpEnrollment` before
creating a settings flow/revealing a secret or validating/enabling a factor:

1. Resolve the input token to a fresh active Kratos session and bind its identity
   to the authenticated GraphQL user.
2. Read that exact identity through the admin API, requesting no credential
   material, and require an active identity.
3. Refuse the device schema with `DEVICE_TOTP_REQUIRES_PHONE_UPGRADE` and fixed
   text: “Verify your phone before setting up an authenticator.” Allow the three
   existing phone/email schemas; unknown schemas/provider failures fail closed
   as `TOTP_ENROLLMENT_UNAVAILABLE`, without forwarding provider details.

The initiate resolver now passes its context user ID internally. The public
GraphQL input, successful payload and SDL are unchanged. Validation retains its
existing post-effect token-owner/readback checks. Checking validation as well
as initiation blocks pending device settings flows issued before this patch.
An owner mismatch is rejected before either settings effect; previously
validation performed the effect before checking token ownership.

The guard intentionally does not use account level, wallet readiness, an
arbitrary rollout flag, or a caller-supplied phone. Existing phone/email
enrollment, TOTP login elevation and factor deletion keep their existing
contracts. This protects Flash's application/GraphQL enrollment paths; it is
not a claim that direct public Kratos settings endpoints have a global
schema-specific policy. Operators must audit that exposure separately.

## Supported migration and existing affected accounts

A user with a usable authenticated device session can explicitly complete the
existing OTP-backed `userLoginUpgrade` path, which migrates the same Kratos
identity to the phone schema. The app must freshly observe that migration
before retrying enrollment. Phone collisions are rejected by the existing
upgrade implementation; this change does not merge accounts or move funds.
The new native Basic credential pair must remain stored until an authoritative
same-owner, exact-phone verified upgrade is observed.

An already-enrolled device identity without a usable authenticated session has
no complete self-service recovery in these source contracts. Preserve its
pair and direct the user to support or a separately audited stronger login
continuation. Do not automatically repeat bootstrap, clear TOTP, fabricate a
phone registration, or erase/recreate the account. A cached token alone is not
proof of usability: checked-in Kratos `session.whoami.required_aal` is
`highest_available`, so an AAL1 token may already be insufficient.

## Offline validation

Three focused suites cover fresh schema/owner/session checks, device rejection
before both settings effects, rejection of old pending flows, successful
phone/email contracts, safe provider failure text, post-effect owner binding,
single failed verification dispatch, GraphQL context propagation and closed
payload error codes. All Ory and repository effects are mocked; the isolated
runner environment and network guard reject accidental external I/O.

Validation completed: 23 assertions in the three new suites, and 66 assertions
across seven suites including existing device bootstrap, identity, phone-upgrade
and error-map regressions. Whole-tree, production and declaration TypeScript
checks, changed-file ESLint, Prettier and `git diff --check` pass. The regression
log is `/tmp/flash-device-totp-policy-regressions.log` in the review workspace.
