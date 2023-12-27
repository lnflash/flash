// API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, { AddInvoiceBodyParam, AddInvoiceResponse201, CreateAccountBodyParam, CreateAccountResponse201, EstimateFeeCopyMetadataParam, EstimateFeeCopyResponse200, GMetadataParam, GResponse200, GResponse400, GenerateBitcoinAddressBodyParam, GenerateBitcoinAddressResponse201, GetAccountDetailsMetadataParam, GetAccountDetailsResponse200, GetFeeEstimationMetadataParam, GetFeeEstimationResponse200, PayInvoiceV2BodyParam, PayInvoiceV2Response200, RefreshAccessTokenBodyParam, SendToAddressCopyBodyParam, SendToAddressCopyResponse200, SignInResponse200 } from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexEventError, IbexAuthenticationError, IbexApiError } from "./errors"
import { withAuth } from "./authentication";
import { logErrors } from "./errors/logger"

// This is a wrapper around the Ibex api that handles authentication
class Ibex {
    private static instance: Ibex | null = null;
    private constructor() {}

    static getInstance(): Ibex {
        if (!Ibex.instance) {
            Ibex.instance = new Ibex();
        }
        return Ibex.instance;
    }

    async getAccountTransactions(metadata: GMetadataParam): Promise<GResponse200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.g(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    async createAccount(body: CreateAccountBodyParam): Promise<CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.createAccount(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    async getAccountDetails(metadata: GetAccountDetailsMetadataParam): Promise<GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.getAccountDetails(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    async generateBitcoinAddress(body: GenerateBitcoinAddressBodyParam): Promise<GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.generateBitcoinAddress(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors) 
    }

    async addInvoice(body: AddInvoiceBodyParam): Promise<AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.addInvoice(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined
    async getFeeEstimation(metadata: GetFeeEstimationMetadataParam): Promise<GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.getFeeEstimation(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    async payInvoiceV2(body: PayInvoiceV2BodyParam): Promise<PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.payInvoiceV2(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    async sendToAddressV2(body: SendToAddressCopyBodyParam): Promise<SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.sendToAddressCopy(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }

    // onchain fee estimation
    async estimateFeeV2(metadata: EstimateFeeCopyMetadataParam): Promise<EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> {
        return withAuth(() => IbexSDK.estimateFeeCopy(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logErrors)
    }
}

// TODO: Change to static class
export default Ibex.getInstance()
