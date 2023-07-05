/* eslint-disable @typescript-eslint/no-explicit-any */
import { RESTDataSource } from "apollo-datasource-rest"
import { filter } from "lodash"

import ExternalWallet from "../models/externalWallet"

import BaseAPI from "./baseAPI"

// Define the response shapes

interface CreateExternalWalletResponse {
  id: string
  userId: string
  organizationId: string
  name: string
  currencyId: number
}

interface ExternalWalletDetails {
  id: string
  userId: string
  name: string
  currencyId: number
  balance: number
}

interface Currency {
  id: number
  name: string
  isFiat: boolean
  symbol: string
  accountEnabled: boolean
}

interface CurrencyStringResponse {
  currencies: Currency[]
}

class ExternalWalletAPI extends RESTDataSource {
  baseAPI: BaseAPI
  context: any
  constructor(baseAPI: BaseAPI) {
    super()
    this.baseAPI = baseAPI
  }

  initialize(config: any) {
    this.context = config.context
  }

  async createExternalWallet(
    currencyId: number,
    name: string,
  ): Promise<CreateExternalWalletResponse> {
    // Access the accountId from the context
    const accountId = this.context.domainAccount.id
    const url = "https://ibexhub.ibexmercado.com/account/create"
    const options = {
      method: "POST",
      headers: { "accept": "application/json", "content-type": "application/json" },
      body: JSON.stringify({ currencyId, name }),
    }
    try {
      const data: CreateExternalWalletResponse = await this.baseAPI.makeRequest(
        url,
        options,
        this.baseAPI.authToken,
      )
      // Create a new ExternalWallet document in MongoDB
      await ExternalWallet.create({
        accountId: accountId,
        externalId: data.id,
        externalUserId: data.userId,
        organizationId: data.organizationId,
        currencyId: data.currencyId,
      })
      return data
    } catch (err) {
      console.error(err)
      throw err // re-throw the error so it can be caught and handled by GraphQL
    }
  }

  async getExternalWalletDetails(externalId: string): Promise<ExternalWalletDetails> {
    const url = `https://ibexhub.ibexmercado.com/v2/account/${externalId}`
    const options = { method: "GET", headers: { accept: "application/json" } }
    try {
      const data: ExternalWalletDetails = await this.baseAPI.makeRequest(
        url,
        options,
        this.baseAPI.authToken,
      )
      return data
    } catch (err) {
      console.error(err)
      throw err // re-throw the error so it can be caught and handled by GraphQL
    }
  }

  async getExternalWalletByAccountId(accountId: string) {
    try {
      const wallet = await ExternalWallet.findOne({ accountId })
      return wallet ? wallet.toJSON() : null
    } catch (err) {
      console.error(err)
      throw err // re-throw the error so it can be caught and handled by GraphQL
    }
  }

  async getCurrencyString(currencyId: number): Promise<string> {
    const url = "https://ibexhub.ibexmercado.com/currency/all"
    const options = { method: "GET", headers: { accept: "application/json" } }
    try {
      const data: CurrencyStringResponse = await this.baseAPI.makeRequest(
        url,
        options,
        null,
      )
      const currencies = filter(data.currencies, { id: currencyId })
      if (currencies.length !== 1) {
        throw new Error(
          `Expected to find exactly one currency with ID ${currencyId}, but found ${currencies.length}.`,
        )
      }
      const walletCurrencyEnum = currencies[0].name == "USD" ? currencies[0].name : "BTC"
      return walletCurrencyEnum
    } catch (err) {
      console.error(err)
      throw err
    }
  }
}

export default ExternalWalletAPI
