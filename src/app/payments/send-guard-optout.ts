/**
 * ENG-573: the explicit opt-out from the send guard.
 *
 * `authorize` is REQUIRED on every arg type that carries it (see
 * `SendGuardHook` in @app/wallets/index.types.d.ts). Optional meant a send path
 * that forgot the hook compiled, passed its tests and shipped unguarded — and
 * two such paths are already sitting in the tree with their bodies commented
 * out, waiting for someone to re-enable them. Requiring the field turns that
 * silent omission into a compile error.
 *
 * System credits are the legitimate exception: quiz rewards, referral payouts,
 * card top-up credits and operator reimbursements are not user-initiated sends.
 * They move money OUT of a Flash-owned funding wallet on our own instruction,
 * so an account-scoped attempt budget and a per-account daily cap describe
 * nothing about them — a 30-payment referral batch would rate-limit itself.
 * They opt out by name, which is also the grep that answers "what still sends
 * without the guard".
 *
 * Deliberately dependency-free: the callers below lazy-import the send
 * functions specifically to keep the IBEX client and the Redis-backed rate
 * limiter out of unrelated module graphs, and importing this must not undo it.
 */
export const SEND_GUARD_NOT_APPLICABLE: SendGuardHook = async () => true
