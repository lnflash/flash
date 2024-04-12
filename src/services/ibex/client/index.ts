// Ibex SDK API registry: https://dash.readme.com/api/v1/api-registry/cpd51bloegfhl2
import IbexSDK, * as types from "./.api/apis/sing-in" // TODO: @sing-in@<uuid>
import { IbexClientError, IbexAuthenticationError, IbexApiError } from "./errors"
import { withAuth } from "./authentication";
import WebhookServer from "../webhook-server"
import { wrapAsyncFunctionsToRunInSpan } from "@services/tracing"
import { logRequest, logResponse } from "./errors/logger"

// This is a wrapper around the Ibex api that adds tracing & authentication
export default () => {
    const getAccountTransactions = async (metadata: types.GMetadataParam): Promise<types.GResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("getAccountTransactions", metadata)
        return withAuth(() => IbexSDK.g(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const getTransactionDetails = async (metadata: types.GetTransactionDetails1MetadataParam): Promise<types.GetTransactionDetails1Response200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("getTransactionDetails", metadata)
        return withAuth(() => IbexSDK.getTransactionDetails1(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const createAccount = async (body: types.CreateAccountBodyParam): Promise<types.CreateAccountResponse201 | IbexAuthenticationError | IbexApiError> => {
        logRequest("createAccount", body)
        return withAuth(() => IbexSDK.createAccount(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const getAccountDetails = async (metadata: types.GetAccountDetailsMetadataParam): Promise<types.GetAccountDetailsResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("getAccountDetails", metadata)
        return withAuth(() => IbexSDK.getAccountDetails(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const generateBitcoinAddress = async (body: types.GenerateBitcoinAddressBodyParam): Promise<types.GenerateBitcoinAddressResponse201 | IbexAuthenticationError | IbexApiError> => {
        logRequest("generateBitcoinAddress", body)
        return withAuth(() => IbexSDK.generateBitcoinAddress(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse) 
    }

    const addInvoice = async (body: types.AddInvoiceBodyParam): Promise<types.AddInvoiceResponse201 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onReceive,
            webhookSecret: WebhookServer.secret, 
        } as types.AddInvoiceBodyParam
        logRequest("addInvoice", bodyWithHooks)
        return withAuth(() => IbexSDK.addInvoice(bodyWithHooks))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const invoiceFromHash = async (metadata: types.InvoiceFromHashMetadataParam): Promise<types.InvoiceFromHashResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("invoiceFromHash", metadata)
        return withAuth(() => IbexSDK.invoiceFromHash(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // LN fee estimation
    // GetFeeEstimationResponse200 not defined
    const getFeeEstimation = async (metadata: types.GetFeeEstimationMetadataParam): Promise<types.GetFeeEstimationResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("getFeeEstimation", metadata)
        return withAuth(() => IbexSDK.getFeeEstimation(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const payInvoiceV2 = async (body: types.PayInvoiceV2BodyParam): Promise<types.PayInvoiceV2Response200 | IbexAuthenticationError | IbexApiError> => {
        const bodyWithHooks = { 
            ...body,
            webhookUrl: WebhookServer.endpoints.onPay,
            webhookSecret: WebhookServer.secret, 
        } as types.PayInvoiceV2BodyParam
        logRequest("payInvoiceV2", bodyWithHooks)
        return withAuth(() => IbexSDK.payInvoiceV2(bodyWithHooks))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    const sendToAddressV2 = async (body: types.SendToAddressCopyBodyParam): Promise<types.SendToAddressCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("sendToAddressV2", body)
        return withAuth(() => IbexSDK.sendToAddressCopy(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }

    // onchain fee estimation
    const estimateFeeV2 = async (metadata: types.EstimateFeeCopyMetadataParam): Promise<types.EstimateFeeCopyResponse200 | IbexAuthenticationError | IbexApiError> => {
        logRequest("estimateFeeV2", metadata)
        return withAuth(() => IbexSDK.estimateFeeCopy(metadata))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
    }
    
    const createLnurlPay = async (body: types.CreateLnurlPayBodyParam): Promise<types.CreateLnurlPayResponse201 | IbexAuthenticationError | IbexApiError> => {
        logRequest("createLnurlPay", body)
        return withAuth(() => IbexSDK.createLnurlPay(body))
            .catch(_ => new IbexApiError(_.status, _.data))
            .then(logResponse)
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
