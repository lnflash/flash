const { GraphQLWsLink } = require("@apollo/client/link/subscriptions")
const { createClient } = require("graphql-ws")
const { ApolloClient, InMemoryCache, gql } = require("@apollo/client")
const WebSocket = require("ws")
const { invoiceStatusGql } = require("./subscriptions/invoice-status")
const { priceUpdatesGql } = require("./subscriptions/price")

BigInt.prototype.toJSON = function () {
  return this.toString()
}

const localUrl = "ws://localhost:4000/graphql"
const stagingUrl = "wss://ws.staging.flashapp.me:8080/graphql"
const developmentUrl = "wss://ws.development.flashapp.me:8080/graphql"
const authToken = process.env.AUTH_TOKEN

const wsLink = new GraphQLWsLink(
  createClient({
    url: localUrl,
    connectionParams: {
      Authorization: `Bearer ${authToken}`,
    },
    webSocketImpl: WebSocket,
  }),
)

const client = new ApolloClient({
  link: wsLink,
  cache: new InMemoryCache(),
})

const subType = process.argv[2]
var subscription
if (subType === "invoice") {
  const paymentRequest = process.argv[3]
  subscription = client.subscribe(invoiceStatusGql(paymentRequest))
} else if (subType === "price") {
  subscription = client.subscribe(priceUpdatesGql(paymentRequest))
} else {
  throw Error("Invalid argument.")
}

subscription.subscribe({
  next: function (data) {
    console.log("Received data:", JSON.stringify(data))
  },
  error: function (error) {
    console.error("Subscription error:", error)
  },
})
