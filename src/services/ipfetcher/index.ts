import axios from "axios"
import { UnknownIpFetcherServiceError } from "@domain/ipfetcher"
import { PROXY_CHECK_APIKEY } from "@config"
import {
  addAttributesToCurrentSpan,
  recordExceptionInCurrentSpan,
} from "@services/tracing"

type Params = {
  vpn: string
  asn: string
  time: string
  risk: string
  key?: string
}

export const IpFetcher = (): IIpFetcherService => {
  const fetchIPInfo = async (ip: string): Promise<IPInfo | IpFetcherServiceError> => {
    const params: Params = {
      vpn: "1",
      asn: "1",
      time: "1",
      risk: "1",
    }

    let keyIsPresent = true

    if (PROXY_CHECK_APIKEY) {
      params["key"] = PROXY_CHECK_APIKEY
    } else {
      keyIsPresent = false
    }

    try {
      const { data } = await axios.request({
        url: `https://proxycheck.io/v2/${ip}`,
        params,
        timeout: 500, // ms
      })

      const proxy = !!(data[ip] && data[ip].proxy && data[ip].proxy === "yes")
      const isoCode = data[ip] && data[ip].isocode

      // Provider metadata is untrusted and may contain the queried IP or
      // arbitrary text. Only closed booleans belong in an exported span.
      addAttributesToCurrentSpan({ proxy, keyIsPresent })
      return { ...data[ip], isoCode, proxy, status: data.status }
    } catch {
      const failure = new UnknownIpFetcherServiceError("IP metadata lookup failed")
      recordExceptionInCurrentSpan({ error: failure, attributes: { keyIsPresent } })
      return failure
    }
  }
  return {
    fetchIPInfo,
  }
}
