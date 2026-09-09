import { DEPRECATED_DEV_UNSAFE_MODE_FLAG, DEV_UNSAFE_MODE_FLAG } from "@utils/dev-context"

const FLAGS = [DEV_UNSAFE_MODE_FLAG, DEPRECATED_DEV_UNSAFE_MODE_FLAG] as const

// Captured at import time, i.e. before any spec body has had a chance to
// mutate the environment.
const saved = new Map(FLAGS.map((flag) => [flag, process.env[flag]]))

// The repo's .env — which `make unit-in-ci` sources — turns unsafe dev mode ON,
// and that flag is half the dev-context predicate that BOTH the weak-secret
// refusal and the SSRF guard read. A spec meaning to exercise deployed
// behaviour has to clear every spelling of it, the deprecated alias included,
// or it is quietly testing the escape hatch instead of the guard. Going
// through this helper is what keeps that true across a rename.
export const clearDevUnsafeModeFlags = (): void => {
  for (const flag of FLAGS) delete process.env[flag]
}

export const restoreDevUnsafeModeFlags = (): void => {
  for (const flag of FLAGS) {
    const value = saved.get(flag)
    if (value === undefined) delete process.env[flag]
    else process.env[flag] = value
  }
}
