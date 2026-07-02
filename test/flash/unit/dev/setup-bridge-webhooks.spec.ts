import {
  buildWebhookDefinitions,
  extractNgrokHttpsUrl,
  mergeDevOverrides,
  reconcileBridgeWebhooks,
} from "../../../../dev/setup-bridge-webhooks"

describe("setup-bridge-webhooks", () => {
  it("builds one Bridge webhook definition per local route", () => {
    const definitions = buildWebhookDefinitions("https://flash-dev.ngrok-free.app")

    expect(definitions).toEqual({
      kyc: {
        url: "https://flash-dev.ngrok-free.app/kyc",
        eventCategories: ["customer", "kyc_link"],
      },
      deposit: {
        url: "https://flash-dev.ngrok-free.app/deposit",
        eventCategories: ["virtual_account.activity", "bridge_wallet.activity"],
      },
      transfer: {
        url: "https://flash-dev.ngrok-free.app/transfer",
        eventCategories: ["transfer"],
      },
      external_account: {
        url: "https://flash-dev.ngrok-free.app/external-account",
        eventCategories: ["external_account"],
      },
    })
  })

  it("extracts the HTTPS ngrok public URL", () => {
    const url = extractNgrokHttpsUrl({
      tunnels: [
        { proto: "http", public_url: "http://example.ngrok-free.app" },
        { proto: "https", public_url: "https://example.ngrok-free.app" },
      ],
    })

    expect(url).toBe("https://example.ngrok-free.app")
  })

  it("merges Bridge secrets and webhook public keys into existing dev overrides", () => {
    const merged = mergeDevOverrides(
      {
        ibex: { environment: "sandbox" },
        bridge: { webhook: { replaySecret: "keep-me" } },
      },
      {
        apiKey: "sk-test-123",
        baseUrl: "https://api.sandbox.bridge.xyz/v0",
        webhookBaseUrl: "https://example.ngrok-free.app",
        publicKeys: {
          kyc: "kyc-pem",
          deposit: "deposit-pem",
          transfer: "transfer-pem",
          external_account: "external-account-pem",
        },
      },
    )

    expect(merged).toEqual({
      ibex: { environment: "sandbox" },
      bridge: {
        apiKey: "sk-test-123",
        baseUrl: "https://api.sandbox.bridge.xyz/v0",
        webhook: {
          replaySecret: "keep-me",
          uri: "https://example.ngrok-free.app",
          publicKeys: {
            kyc: "kyc-pem",
            deposit: "deposit-pem",
            transfer: "transfer-pem",
            external_account: "external-account-pem",
          },
        },
      },
    })
  })

  it("deletes old webhooks, creates new disabled webhooks, then enables them", async () => {
    const calls: string[] = []
    const definitions = buildWebhookDefinitions("https://fresh.ngrok-free.app")
    const api = {
      listWebhooks: jest.fn().mockResolvedValue([
        { id: "wep_old_1", status: "active", url: "https://old.example/kyc" },
        { id: "wep_old_2", status: "disabled", url: "https://old.example/deposit" },
        { id: "wep_deleted", status: "deleted", url: "https://old.example/deleted" },
      ]),
      deleteWebhook: jest.fn(async (id: string) => {
        calls.push(`delete:${id}`)
      }),
      createWebhook: jest.fn(async ({ key }: { key: string }) => {
        calls.push(`create:${key}`)
        return {
          id: `wep_${key}`,
          public_key: `${key}-public-key`,
        }
      }),
      enableWebhook: jest.fn(async (id: string) => {
        calls.push(`enable:${id}`)
      }),
    }

    const result = await reconcileBridgeWebhooks(api, definitions)

    expect(calls).toEqual([
      "delete:wep_old_1",
      "delete:wep_old_2",
      "create:kyc",
      "enable:wep_kyc",
      "create:deposit",
      "enable:wep_deposit",
      "create:transfer",
      "enable:wep_transfer",
      "create:external_account",
      "enable:wep_external_account",
    ])
    expect(result.publicKeys).toEqual({
      kyc: "kyc-public-key",
      deposit: "deposit-public-key",
      transfer: "transfer-public-key",
      external_account: "external_account-public-key",
    })
  })
})
