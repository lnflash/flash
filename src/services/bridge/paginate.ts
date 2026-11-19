// Reads a Bridge list endpoint that returns newest first and pages with
// `starting_after` (the last id of the previous page). Stops at the first
// short page, or after `maxPages`, when `onPageCap` is told how many items were
// read. A thrown error is returned, never thrown.
export const paginateNewestFirst = async <T extends { id?: string }>({
  fetchPage,
  pageSize,
  maxPages,
  onPageCap,
}: {
  fetchPage: (args: { limit: number; startingAfter?: string }) => Promise<{ data: T[] }>
  pageSize: number
  maxPages: number
  onPageCap: (fetched: number) => void
}): Promise<T[] | Error> => {
  const all: T[] = []
  let startingAfter: string | undefined
  try {
    for (let page = 0; page < maxPages; page++) {
      const response = await fetchPage({ limit: pageSize, startingAfter })
      all.push(...response.data)

      const last = response.data[response.data.length - 1]
      if (response.data.length < pageSize || !last?.id) return all
      startingAfter = last.id
    }
    onPageCap(all.length)
    return all
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error))
  }
}
