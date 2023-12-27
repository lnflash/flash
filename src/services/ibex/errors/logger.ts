import { baseLogger as log } from "@services/logger"
import { IbexEventError } from "."

export const logErrors = (e: any) => {
    if (e instanceof IbexEventError) log.error(e)
    return e
}