const { GraphQLWsLink } = require('@apollo/client/link/subscriptions');
const { createClient } = require('graphql-ws');
const { ApolloClient, InMemoryCache, gql } = require('@apollo/client');
const WebSocket = require('ws');

const paymentRequest = process.argv[2]
// typescript
// declare global {
  //interface BigInt {
    //toJSON(): string;
  //}
// }

BigInt.prototype.toJSON = function () {
  return this.toString();
};

const wsLink = new GraphQLWsLink(createClient({
  url: 'ws://localhost:4000/graphql',
  webSocketImpl: WebSocket,
  // connectionParams: {
  //  authToken: user.authToken,
  // },
}));

const client = new ApolloClient({
  link: wsLink,
  cache: new InMemoryCache(),
});

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

var subscription = client.subscribe({
    query: SUBSCRIPTION_QUERY,
    variables: {
        input: {
            "paymentRequest": paymentRequest
        }
    }
});

subscription.subscribe({
    next: function (data) {
        console.log('Received data:', JSON.stringify(data));
    },
    error: function (error) {
        console.error('Subscription error:', error);
    }
});
