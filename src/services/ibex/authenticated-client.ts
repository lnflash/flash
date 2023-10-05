// Ibex SDK API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountBodyParam, CreateAccountResponse201, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GMetadataParam, GResponse200, GResponse400, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, RefreshAccessTokenBodyParam, SendToAddressCopyBodyParam, SendToAddressCopyResponse200, SignInResponse200 } from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexEventError, IbexAuthenticationError, IbexApiError } from "./errors"
import { withAuth } from "./authentication";
import { logRequest, logResponse } from "./errors/logger"

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

    async getAccountTransactions(metadata: GMetadataParam): Promise<GResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getAccountTransactions", metadata)
        return withAuth(() => IbexSDK.g(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async createAccount(body: CreateAccountBodyParam): Promise<CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("createAccount", body)
        return withAuth(() => IbexSDK.createAccount(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async getAccountDetails(metadata: GetAccountDetailsMetadataParam): Promise<GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getAccountDetails", metadata)
        return withAuth(() => IbexSDK.getAccountDetails(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async generateBitcoinAddress(body: GenerateBitcoinAddressBodyParam): Promise<GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("generateBitcoinAddress", body)
        return withAuth(() => IbexSDK.generateBitcoinAddress(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse) 
    }

    async addInvoice(body: AddInvoiceBodyParam): Promise<AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> {
        logRequest("addInvoice", body)
        return withAuth(() => IbexSDK.addInvoice(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined
    async getFeeEstimation(metadata: GetFeeEstimationMetadataParam): Promise<GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("getFeeEstimation", metadata)
        return withAuth(() => IbexSDK.getFeeEstimation(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async payInvoiceV2(body: PayInvoiceV2BodyParam): Promise<PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: 'http://localhost:8889/invoice/status',
            webhookSecret: 'secret'
        } as PayInvoiceV2BodyParam
        logRequest("payInvoiceV2", bodyWithHooks)
        return withAuth(() => IbexSDK.payInvoiceV2(bodyWithHooks))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    async sendToAddressV2(body: SendToAddressCopyBodyParam): Promise<SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> {
        logRequest("sendToAddressV2", body)
        return withAuth(() => IbexSDK.sendToAddressCopy(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // onchain fee estimation
    async estimateFeeV2(metadata: EstimateFeeCopyMetadataParam): Promise<EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> {
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
