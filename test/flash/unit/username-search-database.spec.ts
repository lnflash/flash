import {
  assertUsernameSearchTestDatabase,
  usernameSearchTestUri,
} from "../username-search/test-database"

describe("destructive directory-test database guard", () => {
  it.each([
    "mongodb://127.0.0.1:27017/username_search_test",
    "mongodb://localhost:27017/username_search_test?appName=review",
    "mongodb://[::1]:27017/username_search_test",
  ])("accepts an isolated local database: %s", (uri) => {
    expect(usernameSearchTestUri(uri)).toBe(uri)
  })
  it.each([
    undefined,
    "not a URI",
    "mongodb://127.0.0.1:27017/application",
    "mongodb://127.0.0.1:27017/application?appName=/username_search_test",
    "mongodb://127.0.0.1:27017/application?appName=/username_search_test?",
    "mongodb://127.0.0.1:27017/username_search_test/other",
    "mongodb://127.0.0.1:27017/application#/username_search_test",
    "mongodb://example.com/username_search_test",
    "mongodb+srv://example.com/username_search_test",
  ])("refuses an unsafe database before connecting: %s", (uri) => {
    expect(() => usernameSearchTestUri(uri)).toThrow("isolated local")
  })
  it("requires the driver's actual database name before any drop", () => {
    expect(() => assertUsernameSearchTestDatabase("username_search_test")).not.toThrow()
    for (const name of [undefined, "application", "admin", "test"])
      expect(() => assertUsernameSearchTestDatabase(name)).toThrow("Refusing to drop")
  })
})
