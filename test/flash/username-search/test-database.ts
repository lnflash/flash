export const USERNAME_SEARCH_TEST_DATABASE = "username_search_test"

/** Test setup drops this database. A matching string inside URI options is insufficient. */
export const usernameSearchTestUri = (uri: string | undefined): string => {
  const message =
    "USERNAME_SEARCH_TEST_URI must name the isolated local username_search_test database"
  if (!uri) throw new Error(message)
  let parsed: URL
  try {
    parsed = new URL(uri)
  } catch {
    throw new Error(message)
  }
  if (
    parsed.protocol !== "mongodb:" ||
    !["127.0.0.1", "localhost", "[::1]"].includes(parsed.hostname) ||
    parsed.pathname !== `/${USERNAME_SEARCH_TEST_DATABASE}` ||
    parsed.hash
  )
    throw new Error(message)
  return uri
}

/** Check the driver's actual selection before enabling destructive setup or cleanup. */
export const assertUsernameSearchTestDatabase = (database: string | undefined): void => {
  if (database !== USERNAME_SEARCH_TEST_DATABASE)
    throw new Error("Refusing to drop a database other than username_search_test")
}
