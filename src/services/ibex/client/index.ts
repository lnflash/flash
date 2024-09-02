// Ibex SDK API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import ibexSDK, * as types from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexAuthenticationError, IbexApiError, IbexClientError } from "./errors"
import WebhookServer from "../webhook-server"
import { addAttributesToCurrentSpan, wrapAsyncFunctionsToRunInSpan, wrapAsyncToRunInSpan } from "@services/tracing"
import { IBEX_EMAIL, IBEX_PASSWORD, IBEX_URL } from "@config";
import { baseLogger } from "@services/logger";
import { SignInResponse200 } from "./.api/apis/sing-in";
import Redis from "./authentication/redis-datastore";
import { CacheServiceError, CacheUndefinedError } from "@domain/cache";
import { FetchResponse } from "api/dist/core";

const Ibex = ibexSDK.server(IBEX_URL)
baseLogger.info(`Ibex server set to ${IBEX_URL}`)

// TODO: Divide this into setAccessToken and setRefreshToken which take Partial<SignInResponse200>
const storeTokens = async (signInResp: SignInResponse200): Promise<void> => {
    const { 
        accessToken,
        accessTokenExpiresAt,
        refreshToken,
        refreshTokenExpiresAt
    } = signInResp

    if (!accessToken) return Promise.reject(new IbexClientError("No access token found in Ibex response body"))
    await Redis.setAccessToken(accessToken, accessTokenExpiresAt)
    Ibex.auth(accessToken)

    if (!refreshToken) return Promise.reject(new IbexClientError("No refresh token found in Ibex response body"))
    await Redis.setRefreshToken(refreshToken, refreshTokenExpiresAt)
}

const signIn = wrapAsyncToRunInSpan({
    namespace: "service.ibex.client",
    fnName: "signIn",
    fn: async (): Promise<void | IbexApiError> => {
        return Ibex.signIn({ email: IBEX_EMAIL, password: IBEX_PASSWORD })
            .then(_ => _.data)
            .then(_ => storeTokens(_))
            .catch(e => {
                baseLogger.error(e)
                return new IbexApiError(e.status, e.data)
            })      
    }
})    

const refreshAccessToken = async (): Promise<void | IbexAuthenticationError> => {
    const tokenOrErr = await Redis.getRefreshToken()
    if (tokenOrErr instanceof CacheUndefinedError) {
        return await signIn().catch((e: IbexApiError) => new IbexAuthenticationError(e))
    }
    if (tokenOrErr instanceof CacheServiceError) return new IbexAuthenticationError(tokenOrErr)
    try {   
        const resp = (await Ibex.refreshAccessToken({ refreshToken: tokenOrErr })).data
        if (!resp.accessToken) return new IbexAuthenticationError("Did not receive access token")
        Redis.setAccessToken(resp.accessToken, resp.expiresAt)
        Ibex.auth(resp.accessToken)
    } catch (err: any) {
        if (err.status === 401) return await signIn().catch((e: IbexApiError) => new IbexAuthenticationError(e))
        else return new IbexAuthenticationError(err)
    }
}

// wraps Ibex api calls with authentication handling
const withAuth = async <S, T>(apiCall: () => Promise<FetchResponse<S, T>>): Promise<T | IbexAuthenticationError> => {
    const atResp = await Redis.getAccessToken()

    if (atResp instanceof CacheUndefinedError) {
        const refreshResp = await refreshAccessToken()
        if (refreshResp instanceof IbexAuthenticationError) return refreshResp
    } else if (atResp instanceof CacheServiceError) return new IbexAuthenticationError(atResp)
    else Ibex.auth(atResp)

    try {
        return (await apiCall()).data
    } catch (err: any) {
        if (err.status === 401) {
            const refreshResp = await refreshAccessToken()
            if (refreshResp instanceof IbexAuthenticationError) return refreshResp
            return (await apiCall()).data
        } else {
            throw err // rethrow non-401s
        }
    }
}

// This is a wrapper around the Ibex api that adds tracing & authentication
export default () => {
    const getAccountTransactions = async (metadata: types.GMetadataParam): Promise<types.GResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.g(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const getTransactionDetails = async (metadata: types.GetTransactionDetails1MetadataParam): Promise<types.GetTransactionDetails1Response200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.getTransactionDetails1(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const createAccount = async (body: types.CreateAccountBodyParam): Promise<types.CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> => {
        // IbexSDK.server(IBEX_URL);
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => Ibex.createAccount(body))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const getAccountDetails = async (metadata: types.GetAccountDetailsMetadataParam): Promise<types.GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.getAccountDetails(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const generateBitcoinAddress = async (body: types.GenerateBitcoinAddressBodyParam): Promise<types.GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onReceive.onchain,
            webhookSecret: WebhookServer.secret, 
        } as types.GenerateBitcoinAddressBodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
        return withAuth(() => Ibex.generateBitcoinAddress(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const addInvoice = async (body: types.AddInvoiceBodyParam): Promise<types.AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onReceive.invoice,
            webhookSecret: WebhookServer.secret, 
        } as types.AddInvoiceBodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
        return withAuth(() => Ibex.addInvoice(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const invoiceFromHash = async (metadata: types.InvoiceFromHashMetadataParam): Promise<types.InvoiceFromHashResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.invoiceFromHash(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined in sdk
    // Returns { amount: integer, invoiceAmount: integer }
    const getFeeEstimation = async (metadata: types.GetFeeEstimationMetadataParam): Promise<types.GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.getFeeEstimation(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const payInvoiceV2 = async (body: types.PayInvoiceV2BodyParam): Promise<types.PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onPay.invoice,
            webhookSecret: WebhookServer.secret, 
        } as types.PayInvoiceV2BodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
        return withAuth(() => Ibex.payInvoiceV2(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const sendToAddressV2 = async (body: types.SendToAddressCopyBodyParam): Promise<types.SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onPay.onchain,
            webhookSecret: WebhookServer.secret, 
        } as types.SendToAddressCopyBodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
        return withAuth(() => Ibex.sendToAddressCopy(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    // onchain fee estimation
    const estimateFeeV2 = async (metadata: types.EstimateFeeCopyMetadataParam): Promise<types.EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => Ibex.estimateFeeCopy(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }
    
    const createLnurlPay = async (body: types.CreateLnurlPayBodyParam): Promise<types.CreateLnurlPayResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onReceive.lnurl,
            webhookSecret: WebhookServer.secret, 
        } as types.CreateLnurlPayBodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(bodyWithHooks) })
        return withAuth(() => Ibex.createLnurlPay(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const decodeLnurl = async (lnurl: types.DecodeLnurlMetadataParam): Promise<types.DecodeLnurlResponse200 | IbexAuthenticationError | IbexApiError> => {
        return withAuth(() => Ibex.decodeLnurl(lnurl))
            .catch(e => new IbexApiError(e.status, e.data))
    }
    
    const payToLnurl = async (body: types.PayToALnurlPayBodyParam): Promise<types.PayToALnurlPayResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onPay.lnurl,
            webhookSecret: WebhookServer.secret, 
        } as types.PayToALnurlPayBodyParam
        return withAuth(() => Ibex.payToALnurlPay(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    return wrapAsyncFunctionsToRunInSpan({
        namespace: "services.ibex.client",
        fns: { 
            getAccountTransactions,
            getTransactionDetails,
            createAccount, 
            getAccountDetails, 
            generateBitcoinAddress, 
            addInvoice, 
            invoiceFromHash, 
            getFeeEstimation,
            payInvoiceV2, 
            sendToAddressV2, 
            estimateFeeV2, 
            createLnurlPay,
            decodeLnurl,
            payToLnurl
        },
    })
}
