const { gql } = require('@apollo/client');

const SUBSCRIPTION_QUERY = gql`
subscription Subscription($input: LnInvoicePaymentStatusInput!) {
  	lnInvoicePaymentStatus(input: $input) {
    		errors {
      		message
    	}
    		status
  	}
}
`;

module.exports = {
    invoiceStatusGql: (pr) => ({
        query: SUBSCRIPTION_QUERY,
        variables: {
            input: {
                "paymentRequest": pr
            }
        }
    })
}
