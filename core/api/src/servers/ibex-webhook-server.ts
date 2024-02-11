import WebookServer from "@services/ibex/webhook-server"

if (require.main === module) {
    WebookServer.start()
}