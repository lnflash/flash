import express, { Request, Response } from "express"
import { authenticate, logRequest } from "../middleware"

const paths = {
    invoice: "/pay/invoice",
    lnurl: "/pay/lnurl",
    onchain: "/pay/onchain"
}

const router = express.Router() 

router.post(
    paths.invoice, 
    authenticate,
    logRequest, 
    async (_: Request, resp: Response) => resp.status(200).end()
)

router.post(
    paths.lnurl, 
    authenticate,
    logRequest, 
    async (_: Request, resp: Response) => resp.status(200).end()
)

router.post(
    paths.onchain, 
    authenticate,
    logRequest, 
    async (_: Request, resp: Response) => resp.status(200).end()
)

export {
    paths,
    router,
}