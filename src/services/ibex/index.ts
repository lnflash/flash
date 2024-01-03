// API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountBodyParam, CreateAccountResponse201, GMetadataParam, GResponse200, GResponse400, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, RefreshAccessTokenBodyParam, SignInResponse200 } from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { Datastore, InMemoryDatastore } from "./Datastore"
import { IbexEventError, IbexAuthenticationError } from "./errors"
import { IBEX_URL, IBEX_EMAIL, IBEX_PASSWORD } from "@config"

// This is a wrapper around the Ibex api that handles authentication
class AuthenticatedIbex {
    private static instance: AuthenticatedIbex | null = null;
    readonly datastore: Datastore // can be in-memory or redis

    private constructor(ds?: Datastore) {
        this.datastore = ds || new InMemoryDatastore()
        // IbexSDK.server(IBEX_URL)
    }

    static getInstance(): AuthenticatedIbex {
        if (!AuthenticatedIbex.instance) {
            AuthenticatedIbex.instance = new AuthenticatedIbex();
        }
        return AuthenticatedIbex.instance;
    }

    // Calls Ibex sign-in and stores authentication details.
    // Returns accessToken on success
    async signIn(): Promise<string | IbexEventError> {
        try {
            const tokenResp: SignInResponse200 = (await IbexSDK.signIn({ email: IBEX_EMAIL, password: IBEX_PASSWORD })).data
            if (!tokenResp.accessToken) return Promise.reject(new IbexAuthenticationError("Did not receive access token"))
            this.datastore.set(tokenResp)
            IbexSDK.auth(tokenResp.accessToken)
            return tokenResp.accessToken  
        } catch (err) {
            return Promise.reject(new IbexAuthenticationError("Authentication failed."))
        } 
    }

    async refreshAccessToken(): Promise<string | IbexEventError> {
        const refreshToken = this.datastore.getRefreshToken()
        if (!refreshToken) return Promise.reject(new IbexAuthenticationError("No refresh token found in local datastore."))
        try {   
            const resp = (await IbexSDK.refreshAccessToken({ refreshToken })).data
            if (!resp.accessToken) return Promise.reject(new IbexAuthenticationError("Did not receive access token"))
            this.datastore.set(resp)
            IbexSDK.auth(resp.accessToken)
            return resp.accessToken
        } catch (err) {
            return Promise.reject(new IbexAuthenticationError("Failed to refresh access token")) 
        }
    }

    // Also throws FetchError<400, GResponse400>
    // async getAccountTransactions(metadata: GMetadataParam): Promise<GResponse200 | IbexEventError> {
    //     try {
    //         return (await Ibex.g(metadata)).data as GResponse200
    //     } catch (err: any) { // FetchError<401, any>
    //         if (err.status === 401) {
    //             const token = await this.refreshAccessToken();
    //             if (token instanceof IbexEventError) return token

    //             // try again after authentication. TODO: add circuit-breaker
    //             return this.getAccountTransactions(metadata)
    //         } else {
    //             return Promise.reject(new IbexEventError("Generic failure while calling Ibex"))
    //         }
    //     }
    // }

    // wraps Ibex api calls with authentication handling
    async withAuth(apiCall: () => Promise<any>): Promise<any> {
        const accessToken = this.datastore.getAccessToken()
        if (!accessToken) {
            console.error("No access token found for Ibex. Signing in...")
            const atOrErr = await this.signIn()
            if (atOrErr instanceof IbexEventError) return atOrErr
        }
        try {
            return (await apiCall()).data
        } catch (err: any) {
            if (err.status === 401) {
                const tokenOrErr = await this.refreshAccessToken();
                if (tokenOrErr instanceof IbexEventError) return tokenOrErr

                // try again
                return (await apiCall()).data
            } else {
                return Promise.reject(new IbexEventError("Generic failure while calling Ibex"))
            }
        }
    }

    async getAccountTransactions(metadata: GMetadataParam): Promise<GResponse200 | IbexEventError> {
        return this.withAuth(() => IbexSDK.g(metadata))
    }

    async createAccount(body: CreateAccountBodyParam): Promise<CreateAccountResponse201 | IbexEventError> {
        return this.withAuth(() => IbexSDK.createAccount(body))
    }

    async getAccountDetails(metadata: GetAccountDetailsMetadataParam): Promise<GetAccountDetailsResponse200 | IbexEventError> {
        return this.withAuth(() => IbexSDK.getAccountDetails(metadata))
    }

    async generateBitcoinAddress(body: GenerateBitcoinAddressBodyParam): Promise<GenerateBitcoinAddressResponse201 | IbexEventError> {
        return this.withAuth(() => IbexSDK.generateBitcoinAddress(body))
    }

    async addInvoice(body: AddInvoiceBodyParam): Promise<AddInvoiceResponse201 | IbexEventError> {
        return this.withAuth(() => IbexSDK.addInvoice(body))
    }

    // GetFeeEstimationResponse200 not defined
    async getFeeEstimation(metadata: GetFeeEstimationMetadataParam): Promise<GetFeeEstimationResponse200 | IbexEventError> {
        return this.withAuth(() => IbexSDK.getFeeEstimation(metadata))
    }

    async payInvoiceV2(body: PayInvoiceV2BodyParam): Promise<PayInvoiceV2Response200 | IbexEventError> {
        return this.withAuth(() => IbexSDK.payInvoiceV2(body))
    }
}

// Uses singleton to ensure only one sign-in. Can be avoided by checking external datastore (i.e Redis) + setting IbexSDK with every api call  
export default AuthenticatedIbex.getInstance()
