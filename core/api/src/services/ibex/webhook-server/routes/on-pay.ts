import express, { Request, Response } from "express"
import { authenticate, logRequest } from "../middleware"

const path = "/invoice/pay"

const router = express.Router() 
router.post(
    path, 
    authenticate,
    logRequest, 
    async (_: Request, resp: Response) => {
        return resp.status(200).end()
    }
)

export {
    path,
    router,
}