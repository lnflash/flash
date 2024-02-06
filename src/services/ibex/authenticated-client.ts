// Ibex SDK API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, * as types from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexEventError, IbexAuthenticationError, IbexApiError } from "./errors"
import { withAuth } from "./authentication";
import { logRequest, logResponse } from "./errors/logger"
import { RECEIVE_PAYMENT_URL, SENT_PAYMENT_URL, WEBHOOK_SECRET } from "./webhook-server"

// This is a wrapper around the Ibex api that handles authentication
class AuthenticatedIbexClient {
    private static instance: AuthenticatedIbexClient | null = null;
    private constructor() {}

    static getInstance(): AuthenticatedIbexClient {
        if (!AuthenticatedIbexClient.instance) {
            AuthenticatedIbexClient.instance = new AuthenticatedIbexClient();
        }
        return AuthenticatedIbexClient.instance;
    }

    async getAccountTransactions(metadata: types.GMetadataParam): Promise<types.GResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getAccountTransactions", metadata)
        return withAuth(() => IbexSDK.g(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async getTransactionDetails(metadata: types.GetTransactionDetails1MetadataParam): Promise<types.GetTransactionDetails1Response200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getTransactionDetails", metadata)
        return withAuth(() => IbexSDK.getTransactionDetails1(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async createAccount(body: types.CreateAccountBodyParam): Promise<types.CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("createAccount", body)
        return withAuth(() => IbexSDK.createAccount(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async getAccountDetails(metadata: types.GetAccountDetailsMetadataParam): Promise<types.GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getAccountDetails", metadata)
        return withAuth(() => IbexSDK.getAccountDetails(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async generateBitcoinAddress(body: types.GenerateBitcoinAddressBodyParam): Promise<types.GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("generateBitcoinAddress", body)
        return withAuth(() => IbexSDK.generateBitcoinAddress(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse) 
    }

    async addInvoice(body: types.AddInvoiceBodyParam): Promise<types.AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: RECEIVE_PAYMENT_URL,
            webhookSecret: WEBHOOK_SECRET, 
        } as types.AddInvoiceBodyParam
        logRequest("addInvoice", body)
        return withAuth(() => IbexSDK.addInvoice(bodyWithHooks))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async invoiceFromHash(metadata: types.InvoiceFromHashMetadataParam): Promise<types.InvoiceFromHashResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("invoiceFromHash", metadata)
        return withAuth(() => IbexSDK.invoiceFromHash(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined
    async getFeeEstimation(metadata: types.GetFeeEstimationMetadataParam): Promise<types.GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getFeeEstimation", metadata)
        return withAuth(() => IbexSDK.getFeeEstimation(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async payInvoiceV2(body: types.PayInvoiceV2BodyParam): Promise<types.PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: SENT_PAYMENT_URL,
            webhookSecret: WEBHOOK_SECRET,
        } as types.PayInvoiceV2BodyParam
        logRequest("payInvoiceV2", bodyWithHooks)
        return withAuth(() => IbexSDK.payInvoiceV2(bodyWithHooks))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async sendToAddressV2(body: types.SendToAddressCopyBodyParam): Promise<types.SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("sendToAddressV2", body)
        return withAuth(() => IbexSDK.sendToAddressCopy(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // onchain fee estimation
    async estimateFeeV2(metadata: types.EstimateFeeCopyMetadataParam): Promise<types.EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("estimateFeeV2", metadata)
        return withAuth(() => IbexSDK.estimateFeeCopy(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }
    
    async createLnurlPay(body: types.CreateLnurlPayBodyParam): Promise<types.CreateLnurlPayResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("createLnurlPay", body)
        return withAuth(() => IbexSDK.createLnurlPay(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }
}

// TODO: Change to static class
export default AuthenticatedIbexClient.getInstance()
