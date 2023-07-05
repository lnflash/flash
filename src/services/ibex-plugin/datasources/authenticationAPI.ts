import { Redis } from "ioredis"

import getSecondsUntilExpiry from "../utils/math"

import BaseAPI from "./baseAPI"

const redis = new Redis()

// Define the response shapes
interface ExternalWalletSignInResponse {
  accessToken: string
  accessTokenExpiresAt: number
  refreshToken: string
  refreshTokenExpiresAt: number
}

interface ExternalWalletAuthRefreshResponse {
  accessToken: string
  expiresAt: number
}

class AuthenticationAPI extends BaseAPI {
  async getAuthToken(
    email: string,
    password: string,
  ): Promise<ExternalWalletSignInResponse> {
    const url = "https://ibexhub.ibexmercado.com/auth/signin"
    const options = {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    }
    try {
      const data: ExternalWalletSignInResponse = await this.makeRequest(
        url,
        options,
        null,
      )
      const secondsUntilAccessTokenExpiry = getSecondsUntilExpiry(
        data.accessTokenExpiresAt,
      )
      const secondsUntilRefreshTokenExpiry = getSecondsUntilExpiry(
        data.refreshTokenExpiresAt,
      )

      // Store auth token
      await redis.set(
        `authToken:ibexMain`,
        data.accessToken,
        "EX",
        secondsUntilAccessTokenExpiry,
      )
      await redis.set(
        `refreshToken:ibexMain`,
        data.refreshToken,
        "EX",
        secondsUntilRefreshTokenExpiry,
      )
      return data
    } catch (err) {
      console.error(err)
      throw err // re-throw the error so it can be caught and handled by GraphQL
    }
  }

  async refreshAuthToken(
    refreshToken: string,
  ): Promise<ExternalWalletAuthRefreshResponse> {
    const url = "https://ibexhub.ibexmercado.com/auth/refresh-access-token"
    const options = {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify({ refreshToken }),
    }
    try {
      const data: ExternalWalletAuthRefreshResponse = await this.makeRequest(
        url,
        options,
        null,
      )
      const secondsUntilAccessTokenExpiry = getSecondsUntilExpiry(data.expiresAt)
      // Store auth token
      await redis.set(
        `authToken:ibexMain`,
        data.accessToken,
        "EX",
        secondsUntilAccessTokenExpiry,
      )
      return data
    } catch (err) {
      console.error(err)
      throw err // re-throw the error so it can be caught and handled by GraphQL
    }
  }

  getSignInAuth(email: string, password: string) {
    return this.getAuthToken(email, password)
  }
}

export default AuthenticationAPI
