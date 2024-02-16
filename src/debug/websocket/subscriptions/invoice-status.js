const { gql } = require('@apollo/client');

//const SUBSCRIPTION_QUERY = gql`
// subscription Subscription($input: LnInvoicePaymentStatusInput!) {
//   	lnInvoicePaymentStatus(input: $input) {
//     		errors {
//       		message
//     	}
//     		status
//   	}
// }
// `;

const SUBSCRIPTION_QUERY = gql`
    subscription myLnUpdates {
        myUpdates {
            errors {
                message
            }
            update {
                ... on LnUpdate {
                    paymentHash
                    status
                }
            }
        }
    }
`;

module.exports = {
    invoiceStatusGql: () => ({
        query: SUBSCRIPTION_QUERY,
        // variables: {
        //     input: {
        //         "paymentRequest": pr
        //     }
        // }
    })
}
