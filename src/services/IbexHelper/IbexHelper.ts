import axios, { isAxiosError, AxiosError, AxiosRequestConfig } from "axios"

// import IBEX_TOKEN from .env file
const IBEX_TOKEN =
  "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJleHAiOjE2OTcyNTM0MjksImp0aSI6ImM2NjMyNWQ1LWMzNjgtNGRhZC1iNTUzLWJkM2I1OThlMWVhMyIsImlhdCI6MTY5NzI0OTgyOSwiaXNzIjoiSUJFWF9IVUIiLCJzdWIiOiIxZGQ3MWZmYS01MThlLTQyY2UtOWRlZC1mZTI1NGM5YjQ0YmIiLCJ0cGUiOiJhY2Nlc3MiLCJwcm0iOnsiYWNjIjoxNSwiY3VyIjoxNSwibG5hIjoxNSwibG5wIjoxNSwibG5yIjoxNSwibG5zIjoxNSwibG53IjoxNSwibWV0IjoxNSwib25yIjoxNSwib25zIjoxNSwidHhzIjoxNSwidXNyIjoxNX19.dTyHVZNGMiQTsAll-V9wWqUgpNOLbouZd6qdsYivUbLWbfgtJlNw9FKPOn50c-nErJsERL4I7AudOEYXW22GpCJo4td9H0cV5wZL52EYuG_k_P1c6FUFnStiCtDKuOEwTQ65yx5LSDAId5o9i4Hg-BehO0gdwVQ7Aabp3pGWNzB60Ng8CJbAkLRSulhkfxFZgpOf9PslBaFTlm_bbjRWDMz6QQ4pnKefTwYffOGFjSyVqV1CgVQyPgLPLhoSX25fsdoqRvJI26sod4LXwuLrtr7S-yT3wNLKotcj_6evzplKqVr8zn2xXyJt5gRzuCyaUH5z3qOCKfJOzIMuylz6cJPKKcEaZ2fPQDcfYpyn9Drv6gh2N86KVdgVR01NdInYJdMkClQSZq6a61vlIvc7TA5bHz0OIjScXvfqWNwuzDQrTeIbvA19Uvye_JS1c4Bmx9fuyJJrhSyItJJyZMLNeoFJuRCTSMcjLfOEJAonFTKpZ76_QULR9XH_sN6RzvgIYuge6mgfVvUKMjnmbZvZoahdQdAuamM2Z4pWueRLRG_i3G52XYaIa-A4sE4dfAx43DRYjfPPpx59xSSAQptbh3-w05HjLEZy9jXqWRgpoDpHVGc82W8JU_h8fe0GHBHW5g7AvCjRRE6yWqbbyaKEU-bw9N7dfLDU97QXWFWx_3I"
const IBexPluginBaseURL = "http://development.flashapp.me:8760/api/v1"
const token = IBEX_TOKEN

const defaultHeaders: AxiosRequestConfig["headers"] = {
  "Authorization": token,
  "Content-Type": "application/json",
}

export async function requestIBexPlugin(
  methodType: string,
  endpoint: string,
  params: object,
  body: object,
) {
  const result = {
    status: 400,
    data: null,
    error: "",
  }

  try {
    let response = { status: 200, data: null, error: "" }
    const requestOptions: AxiosRequestConfig = {
      headers: defaultHeaders,
    }

    switch (methodType) {
      case "GET":
        response = await axios.get(`${IBexPluginBaseURL}${endpoint}`, requestOptions)
        break
      case "PUT":
        response = await axios.put(
          `${IBexPluginBaseURL}${endpoint}`,
          body,
          requestOptions,
        )
        break
      case "POST":
        response = await axios.post(
          `${IBexPluginBaseURL}${endpoint}`,
          body,
          requestOptions,
        )
        break
      case "DELETE":
        response = await axios.delete(`${IBexPluginBaseURL}${endpoint}`, requestOptions)
        break
    }

    result.status = response.status
    result.data = response.data
  } catch (error) {
    console.log("error>>>", error)
    if (isAxiosError(error)) {
      const axiosError = error as AxiosError
      if (axiosError.response) {
        result.status = axiosError.response.status
        result.error = axiosError.message
      }
    }
  }

  console.log(result)
  return result
}
