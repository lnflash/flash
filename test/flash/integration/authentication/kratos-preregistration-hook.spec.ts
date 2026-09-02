/**
 * The unit specs around the pre-persist registration hook each mock the other
 * side: the route spec mocks the app, the app spec mocks Mongo, the flow-error
 * spec hand-builds the Kratos 400. None of them executes the one claim the
 * hook exists for — that a rejected sign-up leaves no Kratos identity behind —
 * and that claim hinges on Kratos internals: `response.parse: true` running
 * the hook BEFORE persist (selfservice/hook/web_hook.go), and the rejection
 * messages landing where kratosHookMessageIdsFromFlow reads them.
 *
 * This drives the real self-service registration flow against the compose
 * Kratos (v1.0.0, dev/ory mounted) with the api's hook routes served from this
 * process on the port dev/ory/kratos.yml targets, so it can return "no" about:
 *
 *  - a phone already bound to a users document (the DuplicateKey source) is
 *    refused as PhoneAlreadyRegisteredError and no identity exists afterwards;
 *  - carrier metadata the api does not accept — carried through Kratos'
 *    transient_payload and body.jsonnet — is refused as
 *    PhoneNotAllowedForRegistrationError, again with nothing persisted;
 *  - an accepted sign-up still gets its account from the post-persist hook.
 */
import { Server } from "http"

import axios from "axios"
import express from "express"

import { GALOY_API_PORT, KRATOS_PUBLIC_API } from "@config"
import {
  PhoneAlreadyRegisteredError,
  PhoneNotAllowedForRegistrationError,
} from "@domain/authentication/errors"
import { CouldNotFindUserFromPhoneError } from "@domain/errors"
import { CarrierType } from "@domain/phone-provider"
import kratosCallback from "@servers/event-handlers/kratos"
import { AuthWithPhonePasswordlessService } from "@services/kratos"
import { kratosAdmin } from "@services/kratos/private"
import { AccountsRepository, UsersRepository } from "@services/mongoose"

import { randomPhone, randomUserId } from "test/galoy/helpers"

const validMetadata: PhoneMetadata = {
  carrier: {
    error_code: "",
    mobile_country_code: "310",
    mobile_network_code: "260",
    name: "T-Mobile USA",
    type: CarrierType.Mobile,
  },
  countryCode: "US",
}

// Raw admin lookup, independent of the api's IdentityRepository, so the
// assertion is about what Kratos stored and not about how the api reads it.
const identityIdsFor = async (phone: PhoneNumber): Promise<string[]> => {
  const { data } = await kratosAdmin.listIdentities({ credentialsIdentifier: phone })
  return data.map((identity) => identity.id)
}

// Kratos migrates its schema on first boot; depends_on only waits for the
// container to start.
const waitForKratos = async (): Promise<void> => {
  const deadline = Date.now() + 120_000
  let lastError: unknown
  while (Date.now() < deadline) {
    try {
      await axios.get(`${KRATOS_PUBLIC_API}/health/ready`, { timeout: 2000 })
      return
    } catch (err) {
      lastError = err
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`Kratos at ${KRATOS_PUBLIC_API} never became ready: ${lastError}`)
}

// dev/ory/kratos.yml calls http://bats-tests:4012/kratos/{preregistration,
// registration}. Locally that name is the host gateway; in the integration
// container it is a network alias for this container. Either way the hooks
// must be answered by the code under test, from this process.
const serveHooks = (): Promise<Server> =>
  new Promise((resolve, reject) => {
    const app = express()
    app.use("/kratos", kratosCallback)
    const server = app.listen(GALOY_API_PORT, "0.0.0.0")
    server.once("listening", () => resolve(server))
    server.once("error", (err: NodeJS.ErrnoException) => {
      reject(
        err.code === "EADDRINUSE"
          ? new Error(
              `port ${GALOY_API_PORT} is already bound (a running api?). Kratos would ` +
                "call that process instead of this suite; stop it and re-run.",
            )
          : err,
      )
    })
  })

describe("Kratos self-service registration through the pre-persist hook", () => {
  const authService = AuthWithPhonePasswordlessService()
  let hooks: Server

  beforeAll(async () => {
    await waitForKratos()
    hooks = await serveHooks()
  }, 150_000)

  afterAll(async () => {
    if (hooks) await new Promise<void>((resolve) => hooks.close(() => resolve()))
  })

  it("persists the identity and the post-persist hook creates the account when nothing rejects", async () => {
    const phone = randomPhone()

    const result = await authService.createIdentityWithSession({
      phone,
      phoneMetadata: validMetadata,
    })
    if (result instanceof Error) throw result

    expect(result.authToken).toEqual(expect.any(String))
    expect(await identityIdsFor(phone)).toStrictEqual([result.kratosUserId])

    const user = await UsersRepository().findByPhone(phone)
    if (user instanceof Error) throw user
    expect(user.id).toBe(result.kratosUserId)
    // transient_payload survived body.jsonnet into the post-persist hook. Only
    // countryCode is asserted: the users schema's `carrier.type: { types, enum }`
    // (a pre-existing typo for `type`) stores carrier as `{ _id, enum: [] }`,
    // which is a schema defect outside this hook's scope.
    expect(user.phoneMetadata?.countryCode).toBe(validMetadata.countryCode)

    const account = await AccountsRepository().findByUserId(result.kratosUserId)
    expect(account).not.toBeInstanceOf(Error)
  })

  it("refuses a phone already bound to a users document and leaves no identity behind", async () => {
    const phone = randomPhone()
    const stale = await UsersRepository().update({
      id: randomUserId(),
      phone,
      deviceTokens: [] as DeviceToken[],
    })
    if (stale instanceof Error) throw stale

    const result = await authService.createIdentityWithSession({
      phone,
      phoneMetadata: validMetadata,
    })

    expect(result).toBeInstanceOf(PhoneAlreadyRegisteredError)
    expect(await identityIdsFor(phone)).toStrictEqual([])

    // The stale document was read, not rewritten: still the seeded id.
    const user = await UsersRepository().findByPhone(phone)
    if (user instanceof Error) throw user
    expect(user.id).toBe(stale.id)
  })

  it("refuses carrier metadata the api does not accept and leaves nothing behind on either side", async () => {
    const phone = randomPhone()
    const phoneMetadata = {
      ...validMetadata,
      carrier: { ...validMetadata.carrier, type: "" },
    } as unknown as PhoneMetadata

    const result = await authService.createIdentityWithSession({ phone, phoneMetadata })

    expect(result).toBeInstanceOf(PhoneNotAllowedForRegistrationError)
    expect(await identityIdsFor(phone)).toStrictEqual([])
    // No identity means the post-persist hook never ran either.
    expect(await UsersRepository().findByPhone(phone)).toBeInstanceOf(
      CouldNotFindUserFromPhoneError,
    )
  })
})
