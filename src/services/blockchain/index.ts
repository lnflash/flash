import axios from "axios"

export const BlockchainService = {
  getCurrentBlockHeight: async (): Promise<number | Error> => {
    try {
      // Using mempool.space API to get current block height
      const response = await axios.get("https://mempool.space/api/blocks/tip/height")
      return response.data as number
    } catch (error) {
      return new Error(`Failed to fetch block height: ${error}`)
    }
  },
}
