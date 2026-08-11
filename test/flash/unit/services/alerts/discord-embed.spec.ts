jest.mock("axios", () => ({
  post: jest.fn(),
  isAxiosError: (error: unknown) =>
    Boolean((error as { isAxiosError?: boolean })?.isAxiosError),
}))

jest.mock("@services/tracing", () => ({
  recordExceptionInCurrentSpan: jest.fn(),
}))

import axios from "axios"

import { recordExceptionInCurrentSpan } from "@services/tracing"

import {
  DiscordEmbed,
  MAX_EMBED_TOTAL,
  MAX_FIELDS,
  MAX_FIELD_VALUE,
  MAX_TITLE,
  clampEmbedToBudget,
  makeFieldBuilder,
  postEmbed,
  truncate,
} from "@services/alerts/discord-embed"

const mockPost = axios.post as jest.Mock
const mockRecord = recordExceptionInCurrentSpan as jest.Mock

const embedSize = (embed: DiscordEmbed): number =>
  (embed.author?.name.length ?? 0) +
  embed.title.length +
  (embed.description?.length ?? 0) +
  embed.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0)

const baseEmbed = (over: Partial<DiscordEmbed> = {}): DiscordEmbed => ({
  title: "Alert",
  color: 0x000000,
  fields: [],
  timestamp: "2026-01-01T00:00:00.000Z",
  ...over,
})

beforeEach(() => {
  jest.clearAllMocks()
  mockPost.mockResolvedValue({ status: 204 })
})

describe("truncate", () => {
  it("leaves a string at or under the cap unchanged", () => {
    expect(truncate("abc", 3)).toBe("abc")
    expect(truncate("ab", 3)).toBe("ab")
  })

  it("trims an over-length string to exactly the cap, ending with an ellipsis", () => {
    const out = truncate("x".repeat(MAX_TITLE + 50), MAX_TITLE)
    expect(out.length).toBe(MAX_TITLE)
    expect(out.endsWith("…")).toBe(true)
  })

  it("caps a field value at exactly the value limit", () => {
    const out = truncate("y".repeat(MAX_FIELD_VALUE + 1), MAX_FIELD_VALUE)
    expect(out.length).toBe(MAX_FIELD_VALUE)
    expect(out.endsWith("…")).toBe(true)
  })
})

describe("makeFieldBuilder", () => {
  it("skips undefined, null and empty values", () => {
    const fields: DiscordEmbed["fields"] = []
    const field = makeFieldBuilder(fields)
    field("a", undefined)
    field("b", null)
    field("c", "")
    field("d", "kept")
    expect(fields).toEqual([{ name: "d", value: "kept", inline: true }])
  })

  it("truncates over-long names and values as it builds", () => {
    const fields: DiscordEmbed["fields"] = []
    makeFieldBuilder(fields)("N".repeat(300), "V".repeat(2000))
    expect(fields[0].name.length).toBe(MAX_TITLE)
    expect(fields[0].value.length).toBe(MAX_FIELD_VALUE)
  })
})

describe("clampEmbedToBudget", () => {
  it("returns the same embed untouched when it is already under budget", () => {
    const embed = baseEmbed({
      fields: [{ name: "a", value: "b", inline: true }],
    })
    expect(clampEmbedToBudget(embed)).toBe(embed)
  })

  it("drops trailing fields so the aggregate stays under the 6000 limit", () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      value: "x".repeat(MAX_FIELD_VALUE),
      inline: true,
    }))
    const clamped = clampEmbedToBudget(baseEmbed({ fields }))

    expect(embedSize(clamped)).toBeLessThanOrEqual(MAX_EMBED_TOTAL)
    expect(clamped.fields.length).toBeGreaterThan(0)
    expect(clamped.fields.length).toBeLessThan(10)
  })

  it("caps the field count at Discord's 25-field limit", () => {
    // Many tiny fields: nowhere near the 6000-char aggregate, so only the
    // field-count cap can bound them. An over-25-field embed would otherwise be
    // rejected wholesale by Discord (400) and silently dropped by postEmbed.
    const fields = Array.from({ length: MAX_FIELDS + 10 }, (_, i) => ({
      name: `f${i}`,
      value: "x",
      inline: true,
    }))
    const clamped = clampEmbedToBudget(baseEmbed({ fields }))

    expect(clamped.fields.length).toBe(MAX_FIELDS)
    expect(embedSize(clamped)).toBeLessThanOrEqual(MAX_EMBED_TOTAL)
  })

  it("truncates the description when it alone would blow the budget", () => {
    const clamped = clampEmbedToBudget(
      baseEmbed({
        description: "d".repeat(6000),
        fields: [{ name: "a", value: "b", inline: true }],
      }),
    )
    expect(embedSize(clamped)).toBeLessThanOrEqual(MAX_EMBED_TOTAL)
    expect((clamped.description as string).endsWith("…")).toBe(true)
  })
})

describe("postEmbed", () => {
  it("posts once on success with the default 5s timeout", async () => {
    await postEmbed("https://discord.test/webhook", baseEmbed())
    expect(mockPost).toHaveBeenCalledTimes(1)
    const [url, body, opts] = mockPost.mock.calls[0]
    expect(url).toBe("https://discord.test/webhook")
    expect(body.embeds).toHaveLength(1)
    expect(opts.timeout).toBe(5000)
  })

  it("honors a caller-supplied timeout", async () => {
    await postEmbed("https://discord.test/webhook", baseEmbed(), 3000)
    expect(mockPost.mock.calls[0][2].timeout).toBe(3000)
  })

  it("clamps the embed to the aggregate limit before posting", async () => {
    const fields = Array.from({ length: 10 }, (_, i) => ({
      name: `f${i}`,
      value: "x".repeat(MAX_FIELD_VALUE),
      inline: true,
    }))
    await postEmbed("https://discord.test/webhook", baseEmbed({ fields }))
    const posted = mockPost.mock.calls[0][1].embeds[0]
    expect(embedSize(posted)).toBeLessThanOrEqual(MAX_EMBED_TOTAL)
  })

  it("retries once after a 429, honoring retry_after", async () => {
    mockPost
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 429, data: { retry_after: 0.01 }, headers: {} },
      })
      .mockResolvedValueOnce({ status: 204 })

    const started = Date.now()
    await postEmbed("https://discord.test/webhook", baseEmbed())

    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(Date.now() - started).toBeGreaterThanOrEqual(9)
    expect(mockRecord).not.toHaveBeenCalled()
  })

  it("records a Warn and does not retry on a non-429 failure", async () => {
    mockPost.mockRejectedValue(new Error("boom"))
    await postEmbed("https://discord.test/webhook", baseEmbed())
    expect(mockPost).toHaveBeenCalledTimes(1)
    expect(mockRecord).toHaveBeenCalledTimes(1)
  })

  it("records a Warn when the 429 retry also fails", async () => {
    mockPost
      .mockRejectedValueOnce({
        isAxiosError: true,
        response: { status: 429, data: { retry_after: 0.01 }, headers: {} },
      })
      .mockRejectedValueOnce(new Error("still down"))
    await postEmbed("https://discord.test/webhook", baseEmbed())
    expect(mockPost).toHaveBeenCalledTimes(2)
    expect(mockRecord).toHaveBeenCalledTimes(1)
  })
})
