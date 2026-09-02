/**
 * Kratos runs a registration web_hook with `response.parse: true` BEFORE the
 * identity is persisted and one with `parse: false` after it. The api leans
 * on that order: /kratos/preregistration refuses a sign-up while nothing has
 * been written yet, /kratos/registration creates the account once the
 * identity exists. Both dev configs must wire it that way — the root
 * dev/ory/kratos.yml (integration suite, hooks served at bats-tests:4012) and
 * the vendir-synced quickstart/dev/ory/kratos.yml (Quickstart CI and the smoke
 * stack, hooks at flash:4012).
 *
 * The quickstart copy is regenerated from upstream galoy, which ships the
 * pre-persist hook commented out, so quickstart/bin/re-render.sh splices it
 * in. This spec is what turns a re-render that lost the splice into a red
 * build instead of a stack that quietly mints orphaned identities again.
 */
import { spawnSync } from "child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { load as loadYaml } from "js-yaml"

const repoRoot = join(__dirname, "..", "..", "..", "..")

type WebHook = {
  hook: "web_hook"
  config: {
    url: string
    method: string
    response?: { parse?: boolean; ignore?: boolean }
    body: string
    auth: unknown
  }
}
type Hook = WebHook | { hook: string }

const isWebHook = (hook: Hook): hook is WebHook => hook.hook === "web_hook"

const registrationHooks = (yamlText: string): Hook[] => {
  const doc = loadYaml(yamlText) as {
    selfservice: { flows: { registration: { after: { password: { hooks: Hook[] } } } } }
  }
  return doc.selfservice.flows.registration.after.password.hooks
}

const expectPrePersistThenPostPersist = (hooks: Hook[], host: string) => {
  const webHooks = hooks.filter(isWebHook)
  expect(webHooks.map((hook) => hook.config.url)).toEqual([
    `http://${host}:4012/kratos/preregistration`,
    `http://${host}:4012/kratos/registration`,
  ])

  const [prePersist, postPersist] = webHooks
  // parse: true is what moves the hook ahead of persist (web_hook.go,
  // ExecutePostRegistrationPrePersistHook); ignore: true would discard the 4xx
  // the api answers with.
  expect(prePersist.config.response).toEqual({ parse: true })
  expect(postPersist.config.response).toEqual({ parse: false })

  // Same transport on both, or the api's callback auth rejects one of them.
  expect(prePersist.config.method).toBe("POST")
  expect(postPersist.config.method).toBe("POST")
  expect(prePersist.config.body).toBe(postPersist.config.body)
  expect(prePersist.config.auth).toEqual(postPersist.config.auth)

  // The session is issued only once both hooks have run.
  expect(hooks[hooks.length - 1]).toEqual({ hook: "session" })
}

describe("registration hooks in the dev Kratos configs", () => {
  it("dev/ory/kratos.yml (integration suite) runs the pre-persist hook before the post-persist one", () => {
    const text = readFileSync(join(repoRoot, "dev/ory/kratos.yml"), "utf8")
    const hooks = registrationHooks(text)

    expect(hooks).toHaveLength(3)
    expectPrePersistThenPostPersist(hooks, "bats-tests")
  })

  it("quickstart/dev/ory/kratos.yml (Quickstart CI, smoke stack) does too", () => {
    const text = readFileSync(join(repoRoot, "quickstart/dev/ory/kratos.yml"), "utf8")
    const hooks = registrationHooks(text)

    expect(hooks).toHaveLength(3)
    expectPrePersistThenPostPersist(hooks, "flash")
  })
})

describe("quickstart/bin/splice-kratos-preregistration-hook.sh", () => {
  const script = join(repoRoot, "quickstart/bin/splice-kratos-preregistration-hook.sh")

  // What vendir sync hands re-render.sh once the hosts are rewritten: upstream
  // galoy's registration section, pre-persist hook still commented out.
  const upstream = `selfservice:
  flows:
    login:
      ui_url: http://localhost:3000/login
      lifespan: 10m

      # this below make phone authentication fails even if there is no email in the schema
      # after:
      #   password:
      #     hooks:
      #     - hook: require_verified_address

    registration:
      lifespan: 10m
      ui_url: http://localhost:3000/register
      after:
        password:
          hooks:
            # we are not sure if we need this hook yet.
            # this could be used to check if the user is already registered in the backend
            # before creating the user in kratos
            # otherwise response: parse: false happens after kratos user creation
            #
            #
            # - hook: web_hook
            #   config:
            #     url: http://flash:4012/kratos/preregistration
            #     method: POST
            #     response:
            #       parse: true
            #     body: file:///home/ory/body.jsonnet # TODO: use a base64 encoding instead
            #     auth:
            #       type: api_key
            #       config:
            #         name: Authorization
            #         value: The-Value-of-My-Key
            #         in: header
            - hook: web_hook
              config:
                url: http://flash:4012/kratos/registration
                method: POST
                response:
                  parse: false
                body: file:///home/ory/body.jsonnet # TODO: use a base64 encoding instead
                auth:
                  type: api_key
                  config:
                    name: Authorization
                    value: The-Value-of-My-Key
                    in: header
            - hook: session

log:
  level: debug
`

  const runOn = (text: string) => {
    const file = join(mkdtempSync(join(tmpdir(), "kratos-splice-")), "kratos.yml")
    writeFileSync(file, text)
    const result = spawnSync("bash", [script, file], { encoding: "utf8" })
    return { result, output: readFileSync(file, "utf8") }
  }

  it("splices the pre-persist hook ahead of /registration and retires upstream's commented-out draft", () => {
    const { result, output } = runOn(upstream)

    expect(result.status).toBe(0)
    expectPrePersistThenPostPersist(registrationHooks(output), "flash")

    expect(output).not.toMatch(/we are not sure if we need this hook yet/)
    expect(output).not.toMatch(/^\s*#.*kratos\/preregistration/m)
    expect(
      output.match(/^\s*url: http:\/\/flash:4012\/kratos\/preregistration$/gm),
    ).toHaveLength(1)

    // Unrelated comments and everything around the hooks list stay untouched.
    expect(output).toMatch(/this below make phone authentication fails/)
    expect(output).toMatch(/- hook: require_verified_address/)
    expect(output.endsWith("- hook: session\n\nlog:\n  level: debug\n")).toBe(true)
  })

  it("leaves a file that already carries the hook alone", () => {
    const spliced = runOn(upstream).output

    const { result, output } = runOn(spliced)

    expect(result.status).toBe(0)
    expect(output).toBe(spliced)
  })

  it("refuses a file whose /kratos/preregistration hook is not pre-persist, and leaves it as it was", () => {
    const spliced = runOn(upstream).output
    // Flip the config line of the spliced hook itself, not the comment above it.
    const postPersist = spliced.replace(
      /(url: http:\/\/flash:4012\/kratos\/preregistration[\s\S]*?parse: )true/,
      "$1false",
    )
    expect(postPersist).not.toBe(spliced)

    const { result, output } = runOn(postPersist)

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("not pre-persist")
    expect(output).toBe(postPersist)
  })

  it("refuses a file it cannot find the /registration anchor in, and leaves it as it was", () => {
    const unrewritten = upstream.replace(
      "http://flash:4012/kratos/registration",
      "http://bats-tests:4012/kratos/registration",
    )

    const { result, output } = runOn(unrewritten)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/expected exactly one/)
    expect(output).toBe(unrewritten)
  })

  it("refuses when the /registration hook is not laid out the way it anchors on", () => {
    const reordered = upstream.replace(
      "              config:\n                url: http://flash:4012/kratos/registration\n                method: POST\n",
      "              config:\n                method: POST\n                url: http://flash:4012/kratos/registration\n",
    )
    expect(reordered).not.toBe(upstream)

    const { result, output } = runOn(reordered)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/not laid out/)
    expect(output).toBe(reordered)
  })
})
