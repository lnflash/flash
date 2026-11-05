# Device-login App Check gate · 2026-10-23

This is a read-only production configuration and one deliberately incomplete
request acceptance check. It is evidence about the current deployed route, not
proof that the staged durable Basic bootstrap is released or that a real user
account can be created safely.

The public `POST /auth/create/device-account` request enters the ingress auth
subrequest before Express. The deployed Oathkeeper device-login rule is the sole
matching rule for this method/path. It requires a JWT in the `Appcheck` header,
trusts the Firebase App Check issuer for project `806646140435`, accepts the
project number/name audiences, and uses Google's App Check JWKS. Its production
rule has no local development signing key or anonymous fallback. Oathkeeper
v0.40.6 defaults the omitted JWT algorithm allowlist to RS256. The ingress
overwrites method, protocol, host, URI and client-IP forwarding headers used
for the decision, so caller-supplied versions cannot select another rule.
There is no second Firebase verifier inside the Express device handler; the
gateway decision is the enforcement boundary.

Read-only decision probes through the deployed gate returned 401 for missing
and malformed App Check proof. The registered physical iOS app
`com.islandbitcoin.flashnative` is in that Firebase project. On SuperMax, an
opt-in native test obtained its real App Attest-backed App Check token, sent
`POST` to the device route with that token and **no Basic Authorization or
body**, and observed HTTP 422. The deployed handler checks for Basic
credentials and returns 422 before calling account login or any provider.
This proves the physical native token passed the current route's App Check
decision without creating an account. The test inspected only status and
exact response URL; it did not log the token, response body, rule contents or
private credentials. The original build 6 app was restored afterward.

The rule is project-scoped and does not select an individual Firebase app ID.
The new native registration can pass because it belongs to the trusted project.
Whether production should impose a narrower app-specific policy is an operator
decision and would need coordinated RN/native rollout. The gate must be
rechecked when releasing this candidate. Its acceptance says nothing about
Kratos identity setup, Mongo journal/index durability, IBEX creation semantics,
App Check token theft resistance beyond Firebase's attestation guarantee, or
real-device Basic login outcomes.
