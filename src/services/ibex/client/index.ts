// Ibex SDK API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, * as types from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexAuthenticationError, IbexApiError } from "./errors"
import { withAuth } from "./authentication";
import WebhookServer from "../webhook-server"
import { addAttributesToCurrentSpan, wrapAsyncFunctionsToRunInSpan } from "@services/tracing"

// This is a wrapper around the Ibex api that adds tracing & authentication
export default () => {
    const getAccountTransactions = async (metadata: types.GMetadataParam): Promise<types.GResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.g(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const getTransactionDetails = async (metadata: types.GetTransactionDetails1MetadataParam): Promise<types.GetTransactionDetails1Response200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.getTransactionDetails1(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const createAccount = async (body: types.CreateAccountBodyParam): Promise<types.CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.createAccount(body))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const getAccountDetails = async (metadata: types.GetAccountDetailsMetadataParam): Promise<types.GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.getAccountDetails(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const generateBitcoinAddress = async (body: types.GenerateBitcoinAddressBodyParam): Promise<types.GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.generateBitcoinAddress(body))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const addInvoice = async (body: types.AddInvoiceBodyParam): Promise<types.AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onReceive,
            webhookSecret: WebhookServer.secret, 
        } as types.AddInvoiceBodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.addInvoice(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const invoiceFromHash = async (metadata: types.InvoiceFromHashMetadataParam): Promise<types.InvoiceFromHashResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.invoiceFromHash(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined
    const getFeeEstimation = async (metadata: types.GetFeeEstimationMetadataParam): Promise<types.GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.getFeeEstimation(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const payInvoiceV2 = async (body: types.PayInvoiceV2BodyParam): Promise<types.PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onPay,
            webhookSecret: WebhookServer.secret, 
        } as types.PayInvoiceV2BodyParam
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.payInvoiceV2(bodyWithHooks))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    const sendToAddressV2 = async (body: types.SendToAddressCopyBodyParam): Promise<types.SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.sendToAddressCopy(body))
            .catch(e => new IbexApiError(e.status, e.data))
    }

    // onchain fee estimation
    const estimateFeeV2 = async (metadata: types.EstimateFeeCopyMetadataParam): Promise<types.EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(metadata) })
        return withAuth(() => IbexSDK.estimateFeeCopy(metadata))
            .catch(e => new IbexApiError(e.status, e.data))
    }
    
    const createLnurlPay = async (body: types.CreateLnurlPayBodyParam): Promise<types.CreateLnurlPayResponse201 | IbexAuthenticationError | IbexApiError> => {
        addAttributesToCurrentSpan({ "request.params": JSON.stringify(body) })
        return withAuth(() => IbexSDK.createLnurlPay(body))
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
            createLnurlPay 
        },
    })
}
