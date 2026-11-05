# Authentication provider adapter privacy and IP failure handling

The IP metadata adapter still sends the exact IP and configured key to its
provider. Successful metadata is returned unchanged to the onboarding policy;
the exported span contains only closed booleans. On provider failure, the
adapter records and returns a fixed diagnostic. It no longer includes the
queried IP, credential-bearing request URL, response body or raw exception.

`UnknownIpFetcherServiceError` now extends `IpFetcherServiceError`. Phone and
device onboarding already check for the latter class before authorizing IP
metadata. The corrected inheritance makes an unknown provider failure take
that fail-closed path, without changing the public error name or critical
severity.

Twilio Verify retains exact phone/code/channel provider inputs and its
service-wide send-rate-limit key. HTTP 429 or known rate-limit code 60203 still
maps to `PhoneProviderRateLimitExceededError`, without claiming which Twilio
bucket rejected the request. Other known failures retain their mapped classes,
including invalid code, restricted region, unavailable provider and expired
verification. Returned messages and log fields are fixed; they contain no
provider error text, phone, code or carrier response object. Carrier lookup
still returns the exact mapped metadata to the caller.

Three guarded unit suites cover 28 tests, including private provider response
and error fixtures, exact provider inputs, both onboarding paths, rate-limit
classification and fixed returned diagnostics. Whole-tree TypeScript,
no-implicit-any, scoped lint, spelling and diff checks pass. Tests use dummy
configuration and mocks, with no provider request or account mutation.

This change does not validate production Twilio delivery or proxy-provider
accuracy. Existing historical telemetry and unrelated provider adapters need
separate operator review.
