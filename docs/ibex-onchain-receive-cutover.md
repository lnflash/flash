# IBEX cash on-chain receive and wallet cutover

The RN cash receive flow calls `onChainAddressCurrent` with the selected USD or
USDT wallet ID. BTC receive uses Breez/Spark separately. A persisted checking
wallet ID is also its IBEX account ID, so address generation must use the
active settlement wallet ID after a cash-wallet cutover.

Both address mutations first require the presented wallet to be an owned USD or
USDT checking wallet and the account to be active. They then use the same cash
wallet mutation routing as invoice creation: an owned legacy USD alias resolves
to the active USDT wallet when that is the settlement wallet. Because cutover
resolution may create a missing USDT wallet, the initial ownership and account
checks run before routing. A changed wallet ID is read back and must still be
owned USDT checking before IBEX is called. Foreign, external, BTC, inactive,
missing, and wrongly routed wallets produce no provider address request.

The returned address is checksum and network validated against configured
Bitcoin chain. These checks do not prove that IBEX credits that address to the
selected active wallet. Before enabling native cash on-chain receive, use
controlled provider accounts to confirm pre-cutover USD, in-progress, complete,
and rolled-back account routing; address credit attribution; webhook delivery;
and restart behavior. Native BTC receive remains a separate SDK ownership task.
