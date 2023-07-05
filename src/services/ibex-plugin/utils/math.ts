export default function getSecondsUntilExpiry(expiryTimestamp: number): number {
  const secondsUntilExpiry = expiryTimestamp - Math.floor(Date.now() / 1000)
  return secondsUntilExpiry
  // convert
}
