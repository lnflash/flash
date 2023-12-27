import axios from "axios";
import { BASE_URL } from "../env"

type GenerateBitcoinAddressParams = {
    accountId: string;
    webhookUrl: string; // optional
    webhooksecret: string; // optional
}

type GeneratetcoinAddressResponse = {
    address: string
}

// Move headers to args?
// { headers: { Authorization: authCache.accessToken } }
export const generateBitcoinAddress = async (params: GenerateBitcoinAddressParams): Promise<GeneratetcoinAddressResponse> => {
    return await axios.post(
        `${BASE_URL}/onchain/address`,
        params,
      )
}