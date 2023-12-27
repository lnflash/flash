import axios from "axios";
import { BASE_URL } from "../env";

interface AuthenticationDetails {
    accessToken: string;
    accessTokenExpiresAt: number;
    refreshToken: string;
    refreshTokenExpiresAt: number;
  }
  
// TODO: consider concurrency
class AuthCache {
    cache: AuthenticationDetails | undefined

    constructor() {
        this.cache = undefined
    }

    set(authDetails: AuthenticationDetails) {
        this.cache = authDetails
    }

    clear() {
        this.cache = undefined // mutable. return new AuthCache for functional
    }

    accessToken(): string | undefined {
        return this.cache?.accessToken
    }

    refreshToken(): string | undefined {
        return this.cache?.refreshToken
    }

    isValid() {
        if (!this.cache) return false
        const currentTime = Date.now()
        if (currentTime > this.cache.accessTokenExpiresAt && currentTime > this.cache.accessTokenExpiresAt) return false
        return true
    }
}
  
  let authCache: AuthCache = new AuthCache()
  
  // accessToken = accessToken || (await Ibex.signIn()).accessToken
  const signIn = async (): Promise<any> => {
    return axios.post(
      `${BASE_URL}/auth/signin`,
      {
        email: process.env.IBEX_EMAIL,
        password: process.env.IBEX_PASSWORD,
      },
    //   { headers }
    )
    .then(r => {
      authCache.set(r.data)
      // r.data
    }); 
  }
  
  const refreshAccessToken = async (): Promise<any> => {
    return axios.post(
      `${BASE_URL}/auth/refresh-access-token`,
      {
        refreshToken: authCache.refreshToken
      },
    //   { headers }
    )
    .then(r => r.data); 
  }
  
  const revokeAccessToken = async (): Promise<any> => {
    authCache.clear()
  }
  
  const handleAuth = async (ibexResp) => {
    // procedural pseudocode
    if (ibexResp.StatusCode === 401) {
      const refreshResp = await refreshAccessToken();
      if (refreshResp.StatusCode === 401) {
        const revoke = await revokeAccessToken();
        signIn()
      }
    }
  }