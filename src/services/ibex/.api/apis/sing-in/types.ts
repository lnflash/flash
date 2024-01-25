import type { FromSchema } from 'json-schema-to-ts';
import * as schemas from './schemas';

export type AddInvoiceBodyParam = FromSchema<typeof schemas.AddInvoice.body>;
export type AddInvoiceResponse201 = FromSchema<typeof schemas.AddInvoice.response['201']>;
export type AddInvoiceResponse400 = FromSchema<typeof schemas.AddInvoice.response['400']>;
export type AddInvoiceResponse403 = FromSchema<typeof schemas.AddInvoice.response['403']>;
export type AddInvoiceV1DepreciatedBodyParam = FromSchema<typeof schemas.AddInvoiceV1Depreciated.body>;
export type AddInvoiceV1DepreciatedResponse201 = FromSchema<typeof schemas.AddInvoiceV1Depreciated.response['201']>;
export type AddInvoiceV1DepreciatedResponse400 = FromSchema<typeof schemas.AddInvoiceV1Depreciated.response['400']>;
export type AddInvoiceV1DepreciatedResponse403 = FromSchema<typeof schemas.AddInvoiceV1Depreciated.response['403']>;
export type CancelALnurlWithdrawMetadataParam = FromSchema<typeof schemas.CancelALnurlWithdraw.metadata>;
export type CancelALnurlWithdrawResponse200 = FromSchema<typeof schemas.CancelALnurlWithdraw.response['200']>;
export type CancelALnurlWithdrawResponse400 = FromSchema<typeof schemas.CancelALnurlWithdraw.response['400']>;
export type CancelALnurlWithdrawResponse403 = FromSchema<typeof schemas.CancelALnurlWithdraw.response['403']>;
export type ChangePasswordBodyParam = FromSchema<typeof schemas.ChangePassword.body>;
export type ChangePasswordResponse204 = FromSchema<typeof schemas.ChangePassword.response['204']>;
export type ChangePasswordResponse400 = FromSchema<typeof schemas.ChangePassword.response['400']>;
export type ChangePasswordResponse401 = FromSchema<typeof schemas.ChangePassword.response['401']>;
export type ConfirmForgotPasswordBodyParam = FromSchema<typeof schemas.ConfirmForgotPassword.body>;
export type ConfirmForgotPasswordResponse204 = FromSchema<typeof schemas.ConfirmForgotPassword.response['204']>;
export type ConfirmForgotPasswordResponse400 = FromSchema<typeof schemas.ConfirmForgotPassword.response['400']>;
export type ConfirmForgotPasswordResponse404 = FromSchema<typeof schemas.ConfirmForgotPassword.response['404']>;
export type CreateALightningAddressBodyParam = FromSchema<typeof schemas.CreateALightningAddress.body>;
export type CreateALightningAddressResponse201 = FromSchema<typeof schemas.CreateALightningAddress.response['201']>;
export type CreateALightningAddressResponse400 = FromSchema<typeof schemas.CreateALightningAddress.response['400']>;
export type CreateALightningAddressResponse403 = FromSchema<typeof schemas.CreateALightningAddress.response['403']>;
export type CreateAccountBodyParam = FromSchema<typeof schemas.CreateAccount.body>;
export type CreateAccountResponse201 = FromSchema<typeof schemas.CreateAccount.response['201']>;
export type CreateAccountResponse400 = FromSchema<typeof schemas.CreateAccount.response['400']>;
export type CreateAccountResponse401 = FromSchema<typeof schemas.CreateAccount.response['401']>;
export type CreateLnurlPayBodyParam = FromSchema<typeof schemas.CreateLnurlPay.body>;
export type CreateLnurlPayResponse201 = FromSchema<typeof schemas.CreateLnurlPay.response['201']>;
export type CreateLnurlPayResponse400 = FromSchema<typeof schemas.CreateLnurlPay.response['400']>;
export type CreateLnurlPayResponse403 = FromSchema<typeof schemas.CreateLnurlPay.response['403']>;
export type CreateLnurlWithdrawBodyParam = FromSchema<typeof schemas.CreateLnurlWithdraw.body>;
export type CreateLnurlWithdrawResponse201 = FromSchema<typeof schemas.CreateLnurlWithdraw.response['201']>;
export type CreateLnurlWithdrawResponse400 = FromSchema<typeof schemas.CreateLnurlWithdraw.response['400']>;
export type CreateLnurlWithdrawResponse403 = FromSchema<typeof schemas.CreateLnurlWithdraw.response['403']>;
export type DecodeInvoiceMetadataParam = FromSchema<typeof schemas.DecodeInvoice.metadata>;
export type DecodeInvoiceResponse200 = FromSchema<typeof schemas.DecodeInvoice.response['200']>;
export type DecodeInvoiceResponse400 = FromSchema<typeof schemas.DecodeInvoice.response['400']>;
export type DecodeInvoiceResponse401 = FromSchema<typeof schemas.DecodeInvoice.response['401']>;
export type DecodeInvoiceResponse404 = FromSchema<typeof schemas.DecodeInvoice.response['404']>;
export type DecodeLnurlMetadataParam = FromSchema<typeof schemas.DecodeLnurl.metadata>;
export type DecodeLnurlResponse200 = FromSchema<typeof schemas.DecodeLnurl.response['200']>;
export type DecodeLnurlResponse400 = FromSchema<typeof schemas.DecodeLnurl.response['400']>;
export type DeleteLightningAddressMetadataParam = FromSchema<typeof schemas.DeleteLightningAddress.metadata>;
export type DeleteLightningAddressResponse204 = FromSchema<typeof schemas.DeleteLightningAddress.response['204']>;
export type DeleteLightningAddressResponse400 = FromSchema<typeof schemas.DeleteLightningAddress.response['400']>;
export type DeleteLightningAddressResponse403 = FromSchema<typeof schemas.DeleteLightningAddress.response['403']>;
export type EstimateFeeCopyMetadataParam = FromSchema<typeof schemas.EstimateFeeCopy.metadata>;
export type EstimateFeeCopyResponse200 = FromSchema<typeof schemas.EstimateFeeCopy.response['200']>;
export type EstimateFeeCopyResponse400 = FromSchema<typeof schemas.EstimateFeeCopy.response['400']>;
export type EstimateFeeCopyResponse404 = FromSchema<typeof schemas.EstimateFeeCopy.response['404']>;
export type EstimateFeeMetadataParam = FromSchema<typeof schemas.EstimateFee.metadata>;
export type EstimateFeeResponse200 = FromSchema<typeof schemas.EstimateFee.response['200']>;
export type EstimateFeeResponse400 = FromSchema<typeof schemas.EstimateFee.response['400']>;
export type EstimateFeeResponse404 = FromSchema<typeof schemas.EstimateFee.response['404']>;
export type FetchInvoiceCopyMetadataParam = FromSchema<typeof schemas.FetchInvoiceCopy.metadata>;
export type FetchInvoiceCopyResponse200 = FromSchema<typeof schemas.FetchInvoiceCopy.response['200']>;
export type FetchInvoiceCopyResponse400 = FromSchema<typeof schemas.FetchInvoiceCopy.response['400']>;
export type ForgotPasswordBodyParam = FromSchema<typeof schemas.ForgotPassword.body>;
export type ForgotPasswordResponse204 = FromSchema<typeof schemas.ForgotPassword.response['204']>;
export type ForgotPasswordResponse400 = FromSchema<typeof schemas.ForgotPassword.response['400']>;
export type ForgotPasswordResponse404 = FromSchema<typeof schemas.ForgotPassword.response['404']>;
export type GMetadataParam = FromSchema<typeof schemas.G.metadata>;
export type GResponse200 = FromSchema<typeof schemas.G.response['200']>;
export type GResponse400 = FromSchema<typeof schemas.G.response['400']>;
export type GenerateBitcoinAddressBodyParam = FromSchema<typeof schemas.GenerateBitcoinAddress.body>;
export type GenerateBitcoinAddressResponse201 = FromSchema<typeof schemas.GenerateBitcoinAddress.response['201']>;
export type GenerateBitcoinAddressResponse400 = FromSchema<typeof schemas.GenerateBitcoinAddress.response['400']>;
export type GenerateBitcoinAddressResponse403 = FromSchema<typeof schemas.GenerateBitcoinAddress.response['403']>;
export type GetASingleSplitMetadataParam = FromSchema<typeof schemas.GetASingleSplit.metadata>;
export type GetASingleSplitResponse200 = FromSchema<typeof schemas.GetASingleSplit.response['200']>;
export type GetASingleSplitResponse400 = FromSchema<typeof schemas.GetASingleSplit.response['400']>;
export type GetAccountDetailsMetadataParam = FromSchema<typeof schemas.GetAccountDetails.metadata>;
export type GetAccountDetailsResponse200 = FromSchema<typeof schemas.GetAccountDetails.response['200']>;
export type GetAccountDetailsResponse400 = FromSchema<typeof schemas.GetAccountDetails.response['400']>;
export type GetAccountDetailsResponse401 = FromSchema<typeof schemas.GetAccountDetails.response['401']>;
export type GetAccountDetailsResponse403 = FromSchema<typeof schemas.GetAccountDetails.response['403']>;
export type GetAllAccountsCopyMetadataParam = FromSchema<typeof schemas.GetAllAccountsCopy.metadata>;
export type GetAllAccountsCopyResponse200 = FromSchema<typeof schemas.GetAllAccountsCopy.response['200']>;
export type GetAllAccountsCopyResponse400 = FromSchema<typeof schemas.GetAllAccountsCopy.response['400']>;
export type GetAllAccountsCopyResponse401 = FromSchema<typeof schemas.GetAllAccountsCopy.response['401']>;
export type GetAllLightningAdressesMetadataParam = FromSchema<typeof schemas.GetAllLightningAdresses.metadata>;
export type GetAllLightningAdressesResponse200 = FromSchema<typeof schemas.GetAllLightningAdresses.response['200']>;
export type GetAllLightningAdressesResponse400 = FromSchema<typeof schemas.GetAllLightningAdresses.response['400']>;
export type GetAllLightningAdressesResponse403 = FromSchema<typeof schemas.GetAllLightningAdresses.response['403']>;
export type GetAllLnurlPayMetadataParam = FromSchema<typeof schemas.GetAllLnurlPay.metadata>;
export type GetAllLnurlPayResponse200 = FromSchema<typeof schemas.GetAllLnurlPay.response['200']>;
export type GetAllLnurlPayResponse400 = FromSchema<typeof schemas.GetAllLnurlPay.response['400']>;
export type GetAllLnurlPayResponse404 = FromSchema<typeof schemas.GetAllLnurlPay.response['404']>;
export type GetAllLnurlWithdrawsMetadataParam = FromSchema<typeof schemas.GetAllLnurlWithdraws.metadata>;
export type GetAllLnurlWithdrawsResponse200 = FromSchema<typeof schemas.GetAllLnurlWithdraws.response['200']>;
export type GetAllLnurlWithdrawsResponse400 = FromSchema<typeof schemas.GetAllLnurlWithdraws.response['400']>;
export type GetAllResponse200 = FromSchema<typeof schemas.GetAll.response['200']>;
export type GetAllResponse400 = FromSchema<typeof schemas.GetAll.response['400']>;
export type GetAllSplitsCopyBodyParam = FromSchema<typeof schemas.GetAllSplitsCopy.body>;
export type GetAllSplitsCopyMetadataParam = FromSchema<typeof schemas.GetAllSplitsCopy.metadata>;
export type GetAllSplitsCopyResponse200 = FromSchema<typeof schemas.GetAllSplitsCopy.response['200']>;
export type GetAllSplitsCopyResponse400 = FromSchema<typeof schemas.GetAllSplitsCopy.response['400']>;
export type GetAllSplitsCopyResponse404 = FromSchema<typeof schemas.GetAllSplitsCopy.response['404']>;
export type GetAllSplitsMetadataParam = FromSchema<typeof schemas.GetAllSplits.metadata>;
export type GetAllSplitsResponse200 = FromSchema<typeof schemas.GetAllSplits.response['200']>;
export type GetAllTheAccountsOfTheUserResponse200 = FromSchema<typeof schemas.GetAllTheAccountsOfTheUser.response['200']>;
export type GetAllTheAccountsOfTheUserResponse400 = FromSchema<typeof schemas.GetAllTheAccountsOfTheUser.response['400']>;
export type GetAllTheAccountsOfTheUserResponse401 = FromSchema<typeof schemas.GetAllTheAccountsOfTheUser.response['401']>;
export type GetFeeEstimationMetadataParam = FromSchema<typeof schemas.GetFeeEstimation.metadata>;
export type GetFeeEstimationResponse200 = FromSchema<typeof schemas.GetFeeEstimation.response['200']>;
export type GetFeeEstimationResponse400 = FromSchema<typeof schemas.GetFeeEstimation.response['400']>;
export type GetFeeEstimationResponse404 = FromSchema<typeof schemas.GetFeeEstimation.response['404']>;
export type GetLnurlPayStatusMetadataParam = FromSchema<typeof schemas.GetLnurlPayStatus.metadata>;
export type GetLnurlPayStatusResponse200 = FromSchema<typeof schemas.GetLnurlPayStatus.response['200']>;
export type GetLnurlPayStatusResponse400 = FromSchema<typeof schemas.GetLnurlPayStatus.response['400']>;
export type GetLnurlPayStatusResponse404 = FromSchema<typeof schemas.GetLnurlPayStatus.response['404']>;
export type GetLnurlWithdrawStatusMetadataParam = FromSchema<typeof schemas.GetLnurlWithdrawStatus.metadata>;
export type GetLnurlWithdrawStatusResponse200 = FromSchema<typeof schemas.GetLnurlWithdrawStatus.response['200']>;
export type GetLnurlWithdrawStatusResponse400 = FromSchema<typeof schemas.GetLnurlWithdrawStatus.response['400']>;
export type GetLnurlWithdrawStatusResponse404 = FromSchema<typeof schemas.GetLnurlWithdrawStatus.response['404']>;
export type GetPaymentInfoFromHashMetadataParam = FromSchema<typeof schemas.GetPaymentInfoFromHash.metadata>;
export type GetPaymentInfoFromHashResponse200 = FromSchema<typeof schemas.GetPaymentInfoFromHash.response['200']>;
export type GetPaymentInfoFromHashResponse400 = FromSchema<typeof schemas.GetPaymentInfoFromHash.response['400']>;
export type GetPaymentInfoFromHashResponse404 = FromSchema<typeof schemas.GetPaymentInfoFromHash.response['404']>;
export type GetPaymentInfosFromBolt11MetadataParam = FromSchema<typeof schemas.GetPaymentInfosFromBolt11.metadata>;
export type GetPaymentInfosFromBolt11Response200 = FromSchema<typeof schemas.GetPaymentInfosFromBolt11.response['200']>;
export type GetPaymentInfosFromBolt11Response400 = FromSchema<typeof schemas.GetPaymentInfosFromBolt11.response['400']>;
export type GetPaymentInfosFromBolt11Response404 = FromSchema<typeof schemas.GetPaymentInfosFromBolt11.response['404']>;
export type GetRatesMetadataParam = FromSchema<typeof schemas.GetRates.metadata>;
export type GetRatesResponse200 = FromSchema<typeof schemas.GetRates.response['200']>;
export type GetRatesResponse400 = FromSchema<typeof schemas.GetRates.response['400']>;
export type GetRatesV2MetadataParam = FromSchema<typeof schemas.GetRatesV2.metadata>;
export type GetRatesV2Response200 = FromSchema<typeof schemas.GetRatesV2.response['200']>;
export type GetSplitDestinationMetadataParam = FromSchema<typeof schemas.GetSplitDestination.metadata>;
export type GetSplitDestinationResponse200 = FromSchema<typeof schemas.GetSplitDestination.response['200']>;
export type GetTransactionDetails1MetadataParam = FromSchema<typeof schemas.GetTransactionDetails1.metadata>;
export type GetTransactionDetails1Response200 = FromSchema<typeof schemas.GetTransactionDetails1.response['200']>;
export type GetTransactionDetails1Response400 = FromSchema<typeof schemas.GetTransactionDetails1.response['400']>;
export type InvoiceFromBolt111MetadataParam = FromSchema<typeof schemas.InvoiceFromBolt111.metadata>;
export type InvoiceFromBolt111Response200 = FromSchema<typeof schemas.InvoiceFromBolt111.response['200']>;
export type InvoiceFromBolt111Response400 = FromSchema<typeof schemas.InvoiceFromBolt111.response['400']>;
export type InvoiceFromBolt111Response404 = FromSchema<typeof schemas.InvoiceFromBolt111.response['404']>;
export type InvoiceFromBolt11MetadataParam = FromSchema<typeof schemas.InvoiceFromBolt11.metadata>;
export type InvoiceFromBolt11Response200 = FromSchema<typeof schemas.InvoiceFromBolt11.response['200']>;
export type InvoiceFromBolt11Response400 = FromSchema<typeof schemas.InvoiceFromBolt11.response['400']>;
export type InvoiceFromBolt11Response404 = FromSchema<typeof schemas.InvoiceFromBolt11.response['404']>;
export type InvoiceFromHashMetadataParam = FromSchema<typeof schemas.InvoiceFromHash.metadata>;
export type InvoiceFromHashResponse200 = FromSchema<typeof schemas.InvoiceFromHash.response['200']>;
export type InvoiceFromHashResponse400 = FromSchema<typeof schemas.InvoiceFromHash.response['400']>;
export type InvoiceFromHashResponse404 = FromSchema<typeof schemas.InvoiceFromHash.response['404']>;
export type InvoiceRequirements1MetadataParam = FromSchema<typeof schemas.InvoiceRequirements1.metadata>;
export type InvoiceRequirements1Response200 = FromSchema<typeof schemas.InvoiceRequirements1.response['200']>;
export type InvoiceRequirements1Response400 = FromSchema<typeof schemas.InvoiceRequirements1.response['400']>;
export type InvoiceRequirementsMetadataParam = FromSchema<typeof schemas.InvoiceRequirements.metadata>;
export type InvoiceRequirementsResponse200 = FromSchema<typeof schemas.InvoiceRequirements.response['200']>;
export type InvoiceRequirementsResponse400 = FromSchema<typeof schemas.InvoiceRequirements.response['400']>;
export type PayInvoice1MetadataParam = FromSchema<typeof schemas.PayInvoice1.metadata>;
export type PayInvoice1Response200 = FromSchema<typeof schemas.PayInvoice1.response['200']>;
export type PayInvoice1Response400 = FromSchema<typeof schemas.PayInvoice1.response['400']>;
export type PayInvoice2MetadataParam = FromSchema<typeof schemas.PayInvoice2.metadata>;
export type PayInvoice2Response200 = FromSchema<typeof schemas.PayInvoice2.response['200']>;
export type PayInvoice2Response400 = FromSchema<typeof schemas.PayInvoice2.response['400']>;
export type PayInvoiceBodyParam = FromSchema<typeof schemas.PayInvoice.body>;
export type PayInvoiceResponse200 = FromSchema<typeof schemas.PayInvoice.response['200']>;
export type PayInvoiceResponse400 = FromSchema<typeof schemas.PayInvoice.response['400']>;
export type PayInvoiceResponse403 = FromSchema<typeof schemas.PayInvoice.response['403']>;
export type PayInvoiceResponse404 = FromSchema<typeof schemas.PayInvoice.response['404']>;
export type PayInvoiceResponse422 = FromSchema<typeof schemas.PayInvoice.response['422']>;
export type PayInvoiceResponse504 = FromSchema<typeof schemas.PayInvoice.response['504']>;
export type PayInvoiceV2BodyParam = FromSchema<typeof schemas.PayInvoiceV2.body>;
export type PayInvoiceV2Response200 = FromSchema<typeof schemas.PayInvoiceV2.response['200']>;
export type PayInvoiceV2Response400 = FromSchema<typeof schemas.PayInvoiceV2.response['400']>;
export type PayInvoiceV2Response403 = FromSchema<typeof schemas.PayInvoiceV2.response['403']>;
export type PayInvoiceV2Response404 = FromSchema<typeof schemas.PayInvoiceV2.response['404']>;
export type PayInvoiceV2Response422 = FromSchema<typeof schemas.PayInvoiceV2.response['422']>;
export type PayInvoiceV2Response504 = FromSchema<typeof schemas.PayInvoiceV2.response['504']>;
export type PayToALnurlPayBodyParam = FromSchema<typeof schemas.PayToALnurlPay.body>;
export type PayToALnurlPayResponse201 = FromSchema<typeof schemas.PayToALnurlPay.response['201']>;
export type PayToALnurlPayResponse400 = FromSchema<typeof schemas.PayToALnurlPay.response['400']>;
export type PayToALnurlPayResponse403 = FromSchema<typeof schemas.PayToALnurlPay.response['403']>;
export type RefreshAccessTokenBodyParam = FromSchema<typeof schemas.RefreshAccessToken.body>;
export type RefreshAccessTokenResponse200 = FromSchema<typeof schemas.RefreshAccessToken.response['200']>;
export type RefreshAccessTokenResponse400 = FromSchema<typeof schemas.RefreshAccessToken.response['400']>;
export type RevokeRefreshTokenBodyParam = FromSchema<typeof schemas.RevokeRefreshToken.body>;
export type RevokeRefreshTokenResponse204 = FromSchema<typeof schemas.RevokeRefreshToken.response['204']>;
export type RevokeRefreshTokenResponse400 = FromSchema<typeof schemas.RevokeRefreshToken.response['400']>;
export type SendToAddressBodyParam = FromSchema<typeof schemas.SendToAddress.body>;
export type SendToAddressCopyBodyParam = FromSchema<typeof schemas.SendToAddressCopy.body>;
export type SendToAddressCopyResponse200 = FromSchema<typeof schemas.SendToAddressCopy.response['200']>;
export type SendToAddressCopyResponse400 = FromSchema<typeof schemas.SendToAddressCopy.response['400']>;
export type SendToAddressCopyResponse403 = FromSchema<typeof schemas.SendToAddressCopy.response['403']>;
export type SendToAddressResponse200 = FromSchema<typeof schemas.SendToAddress.response['200']>;
export type SendToAddressResponse400 = FromSchema<typeof schemas.SendToAddress.response['400']>;
export type SendToAddressResponse403 = FromSchema<typeof schemas.SendToAddress.response['403']>;
export type SignInBodyParam = FromSchema<typeof schemas.SignIn.body>;
export type SignInResponse200 = FromSchema<typeof schemas.SignIn.response['200']>;
export type SignInResponse400 = FromSchema<typeof schemas.SignIn.response['400']>;
export type SignUpBodyParam = FromSchema<typeof schemas.SignUp.body>;
export type SignUpResponse200 = FromSchema<typeof schemas.SignUp.response['200']>;
export type SignUpResponse400 = FromSchema<typeof schemas.SignUp.response['400']>;
export type UpdateASingleSplitCopyMetadataParam = FromSchema<typeof schemas.UpdateASingleSplitCopy.metadata>;
export type UpdateASingleSplitCopyResponse200 = FromSchema<typeof schemas.UpdateASingleSplitCopy.response['200']>;
export type UpdateASingleSplitCopyResponse400 = FromSchema<typeof schemas.UpdateASingleSplitCopy.response['400']>;
export type UpdateAccountBodyParam = FromSchema<typeof schemas.UpdateAccount.body>;
export type UpdateAccountMetadataParam = FromSchema<typeof schemas.UpdateAccount.metadata>;
export type UpdateAccountResponse200 = FromSchema<typeof schemas.UpdateAccount.response['200']>;
export type UpdateAccountResponse400 = FromSchema<typeof schemas.UpdateAccount.response['400']>;
export type UpdateAccountResponse401 = FromSchema<typeof schemas.UpdateAccount.response['401']>;
export type UpdateAccountResponse403 = FromSchema<typeof schemas.UpdateAccount.response['403']>;
export type UpdateAllSplitsCopy1MetadataParam = FromSchema<typeof schemas.UpdateAllSplitsCopy1.metadata>;
export type UpdateAllSplitsCopy1Response200 = FromSchema<typeof schemas.UpdateAllSplitsCopy1.response['200']>;
export type UpdateAllSplitsCopy2BodyParam = FromSchema<typeof schemas.UpdateAllSplitsCopy2.body>;
export type UpdateAllSplitsCopy2MetadataParam = FromSchema<typeof schemas.UpdateAllSplitsCopy2.metadata>;
export type UpdateAllSplitsCopy2Response200 = FromSchema<typeof schemas.UpdateAllSplitsCopy2.response['200']>;
export type UpdateAllSplitsCopy2Response400 = FromSchema<typeof schemas.UpdateAllSplitsCopy2.response['400']>;
export type UpdateAllSplitsCopy2Response404 = FromSchema<typeof schemas.UpdateAllSplitsCopy2.response['404']>;
export type UpdateAllSplitsCopyBodyParam = FromSchema<typeof schemas.UpdateAllSplitsCopy.body>;
export type UpdateAllSplitsCopyMetadataParam = FromSchema<typeof schemas.UpdateAllSplitsCopy.metadata>;
export type UpdateAllSplitsCopyResponse200 = FromSchema<typeof schemas.UpdateAllSplitsCopy.response['200']>;
export type UpdateAllSplitsCopyResponse400 = FromSchema<typeof schemas.UpdateAllSplitsCopy.response['400']>;
export type UpdateAllSplitsCopyResponse404 = FromSchema<typeof schemas.UpdateAllSplitsCopy.response['404']>;
export type UpdateLightningAddressBodyParam = FromSchema<typeof schemas.UpdateLightningAddress.body>;
export type UpdateLightningAddressMetadataParam = FromSchema<typeof schemas.UpdateLightningAddress.metadata>;
export type UpdateLightningAddressResponse200 = FromSchema<typeof schemas.UpdateLightningAddress.response['200']>;
export type UpdateLightningAddressResponse400 = FromSchema<typeof schemas.UpdateLightningAddress.response['400']>;
export type UpdateLightningAddressResponse403 = FromSchema<typeof schemas.UpdateLightningAddress.response['403']>;
export type WithdrawFromALnurlWithdrawBodyParam = FromSchema<typeof schemas.WithdrawFromALnurlWithdraw.body>;
export type WithdrawFromALnurlWithdrawMetadataParam = FromSchema<typeof schemas.WithdrawFromALnurlWithdraw.metadata>;
export type WithdrawFromALnurlWithdrawResponse200 = FromSchema<typeof schemas.WithdrawFromALnurlWithdraw.response['200']>;
export type WithdrawFromALnurlWithdrawResponse400 = FromSchema<typeof schemas.WithdrawFromALnurlWithdraw.response['400']>;
export type WithdrawFromALnurlWithdrawResponse403 = FromSchema<typeof schemas.WithdrawFromALnurlWithdraw.response['403']>;