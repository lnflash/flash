/* eslint-disable @typescript-eslint/no-explicit-any */
import fetch from "node-fetch"
import { RESTDataSource } from "apollo-datasource-rest"
import { Redis } from "ioredis"

interface WillSendRequest {
  headers: {
    set: (arg0: string, arg1: string) => void
  }
}

const getAuthTokenFromRedis = async (redis: Redis): Promise<string | null> => {
  const authToken = await redis.get("authToken:ibexMain")
  return authToken
}

const refreshAuthToken = async (redis: Redis): Promise<string> => {
  const refreshToken = await redis.get("refreshToken:ibexMain")
  if (refreshToken) {
    // Dynamically import AuthenticationAPI here
    const { default: AuthenticationAPI } = await import("./authenticationAPI")
    const authenticationAPI = new AuthenticationAPI(redis)
    const data = await authenticationAPI.refreshAuthToken(refreshToken)
    return data.accessToken
  }
  throw new Error("No refresh token found")
  // TODO: Handle the case where the refresh token has expired. Log the user out and redirect them to the login page.
}

export default class BaseAPI extends RESTDataSource {
  authToken: string | null = null
  private redis?: Redis

  constructor(redis?: Redis) {
    super()
    if (redis) {
      this.redis = redis
      this.initialize().then(() => {
        console.log("BaseAPI initialized")
      })
    }
  }

  async initialize() {
    try {
      if (this.redis) {
        this.authToken = await getAuthTokenFromRedis(this.redis)
      }
    } catch (err) {
      console.error("Error during initialization:", err)
    }
  }

  willSendRequest(request: WillSendRequest) {
    if (this.authToken) {
      request.headers.set("Authorization", `${this.authToken}`)
    }
  }

  async makeRequest(url: string, options: any, authToken: string | null): Promise<any> {
    try {
      if (authToken) {
        options.headers.Authorization = `${authToken}`
      }
      const response = await fetch(url, options)
      if (response.ok) {
        const data = await response.json()
        return data
      } else if (response.status === 401) {
        if (this.redis) {
          const refreshToken = await refreshAuthToken(this.redis)
          options.headers.Authorization = `${refreshToken}` // Update the Authorization header
          const res = await fetch(url, options)
          return await res.json()
        }
      } else {
        throw new Error(`HTTP error! status: ${response.status}`)
      }
    } catch (err) {
      console.error("Error in makeRequest:", err)
      throw err
    }
  }
}
