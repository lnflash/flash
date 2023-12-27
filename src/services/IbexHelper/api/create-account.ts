import axios from "axios";
import { NotImplementedError } from "@domain/errors";
export type CreateAccountParams = { 
    name: string
    currencyId: number // optional
}
// export class CreateAccountParams { 
//   name: string
//   currencyId: number // optional

//   constructor({ name, currencyId }) {
//     if (!(typeof name === "string" && typeof currencyId === "number")) {
//       return InvalidInputError()
//     }
//     return new 
//   }
// }

type CreateAccountResp = { id: string, userId: string, name: string, currencyId: number }

export const createAccount = async (params: CreateAccountParams): Promise<CreateAccountResp> => { // | IbexApiError
    throw new NotImplementedError()
    //   return await axios.post(
    //     `${BASE_URL}account/create`,
    //     params,
    //     { headers: { Authorization: authCache.accessToken } }
    //   )
    //   .then(handleAuth)

}