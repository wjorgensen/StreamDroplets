# Stream Droplets – On‑Chain Tracking Plan (Integrations)


## 1) Shadow Exchange (Sonic) — xUSD Liquidity

**Name:** Shadow (DEX LP)

**Chain:** Sonic (chainId 146)

**Tokens involved:** xUSD + HLP0 (Pool A), xUSD + aSonUSDC (Pool B)

**Contracts**
- **Pool A (xUSD/HLP0) – Pair/LP:** `0xdEE813F080f9128e52E38E9Ffef8B997F9544332`
- **Pool B (xUSD/aSonUSDC) – Pair/LP:** `0xFEAd02Fb16eC3B2F6318dCa230198dB73E99428C`

**Events to watch**
- **LP token (same address as pair; ERC‑20):** `Transfer(from,to,amount)` → reassign LP‑based TVL
- **Pair contract:** `Mint(sender,amount0,amount1)`, `Burn(sender,amount0,amount1,to)` (liquidity changes), `Sync(reserve0,reserve1)` (state refresh)

**Functions to read**
- Pair: `getReserves()`, `totalSupply()`, `balanceOf(holder)`

**TVL rule**
- At any block: `user_xUSD = lpBalance/totalSupply * reserve_xUSD` → `user_USD = user_xUSD * $xUSD` (≈ $1)

---

## 2) Euler (Sonic) — xUSD Vault

**Name:** Euler Vault (ERC‑4626)

**Chain:** Sonic (chainId 146)

**Contracts**
- **Euler xUSD Vault (shares ERC‑20):** `0xdEBdAB749330bb976fD10dc52f9A452aaF029028`

**Events to watch**
- **Vault (ERC‑4626):** `Deposit(sender,owner,assets,shares)`, `Withdraw(sender,receiver,owner,assets,shares)`
- **Shares (ERC‑20):** `Transfer(from,to,shares)`

**Functions to read**
- `balanceOf(holder)` (shares), `convertToAssets(shares)` / `previewRedeem(shares)`, `totalAssets()`, `totalSupply()`

**TVL rule**
- `user_USD = convertToAssets(balanceOf(user)) * $xUSD` (≈ $1)

**Notes**
- If only `exchangeRate` is available: compute `assets = shares * exchangeRate` with correct decimals.

---

## 3) Silo Finance V2 — xUSD Markets

**Name:** Silo V2 (Isolated Markets; ERC‑4626 receipts)

**Chains:** Sonic (IDs **112** xUSD‑USDC, **118** xUSD‑scUSD), Avalanche (ID **129** xUSD‑USDC)

**Contracts per market** *(each market has two ERC‑4626 vaults; we track only the **Stream asset** vault)*
- **Sonic Market 118 (xUSD‑scUSD):**
  - **Vault (xUSD receipt):** `0x596aeF68A03a0E35c4D8e624fBbdB0df0862F172`
- **Sonic Market 112 (xUSD‑USDC):**
  - **Vault (xUSD receipt):** `0x172a687c397E315DBE56ED78aB347D7743D0D4fa`
- **Avalanche Market 129 (xUSD‑USDC):**
  - **Vault (xUSD receipt):** `0xc380E5250d9718f8d9116Bc9d787A0229044e2EB`

**Events to watch (per vault)**
- `Deposit(sender,owner,assets,shares)`, `Withdraw(sender,receiver,owner,assets,shares)`
- Shares `Transfer(from,to,shares)`

**Functions to read**
- `convertToAssets(shares)` / `previewRedeem(shares)`, `balanceOf(holder)`, `totalAssets()`, `totalSupply()`

**TVL rule**
- For each xUSD receipt vault: `user_USD = convertToAssets(shares_user) * $xUSD` (≈ $1)

---

## 4) Royco (Sonic) — Incentivized Action Market
**Name:** Royco IAM (Recipe / Vault)
Chain: Sonic (chainId 146)
Custody model: Custodied (CCDM) — deposits are held by a singleton Deposit Locker (source chain) and later released by a singleton Deposit Executor (destination chain). Treat positions as custodied until withdrawn.
Contracts (Sonic mainnet)
RecipeMarketHub: 0xFcc593aD3705EBcd72eC961c63eb484BE795BDbD
PointsFactory: 0xD3B5beD62038d520FE659C01B03e2727377c8B8d
WrappedVaultFactory: 0x7212d98A88D44f714FD29dd980cb846be8E7491a
WrappedVault (impl): 0xb0a3960B115E0999F33e8AfD4a11f16e04e2bf33
WeirollWallet (impl): 0x40a1c08084671E9A799B73853E82308225309Dc0
WeirollWalletHelper: 0x07899ac8BE7462151d6515FCd4773DD9267c9911
Deposit Locker (singleton): TBD (resolve on Sonic programmatically)
Deposit Executor (singleton): TBD (resolve on Sonic programmatically)
Market identifier
bytes32: 0xfcd798abefe4f9784e8f7ce3019c5e567e85687235ce0ce61c27271ba97d26cd (not a contract address; use to filter logs)
Events to watch
RecipeMarketHub (source chain):
Offer fill / participation (indexed marketId) → start/adjust custodied TVL for the AP (user / Weiroll wallet).
Forfeit / cancel (indexed marketId) → remove custodied TVL.
Deposit Locker (source chain, singleton):
Deposit recorded / bridged (per-market) → maintain custody state (TVL remains with the user).
Deposit Executor (destination chain, singleton):
Deposit received / recipe executed (per marketId) → ownership unchanged (still user), holds receipt tokens until unlock.
Withdraw after unlock → remove TVL.
If Vault IAM (non-custodial):
WrappedVault (ERC-4626) Deposit, Withdraw, share Transfer → attribute via shares and convertToAssets.
Functions to read
Custodied (Recipe IAM): none required for balances; rely on events + your internal per-user ledger.
Vault IAM: balanceOf(holder), convertToAssets(shares), totalAssets(), totalSupply().
TVL rule
Custodied: Attribute USD TVL to the AP’s wallet (or their Weiroll wallet mapped to the user) from fill time until withdraw/forfeit. Do not award TVL to Royco contracts themselves.
Vault IAM: Standard ERC-4626 share → assets conversion.
Ownership mapping
Maintain an off-chain map of Weiroll wallet → user EOA for attribution.
Programmatic discovery: Deposit Locker & Executor (on-chain only)
Inputs you need:
A Weiroll Wallet address that participated in your market, and at least one input token (e.g., Sonic xUSD).
Method (summary):
Executor: scan ERC-20 Approval logs where owner = weirollWallet; the recurring spender across your market tokens is the Deposit Executor.
Locker: scan ERC-20 Transfer logs where from = weirollWallet on the input token; the dominant to contract across fills is the Deposit Locker.
Sanity check: many lockers expose recipeMarketHub(); it should return the Sonic hub (0xFcc593…BDbD).
Drop-in viem script (TypeScript)
```
import { createPublicClient, http, parseAbi, getAddress, Address } from "viem";
import { defineChain } from "viem/chains";

// Sonic chain (146). Replace rpcUrl if you run your own node/provider.
const sonic = defineChain({
  id: 146,
  name: "Sonic",
  network: "sonic",
  nativeCurrency: { name: "S", symbol: "S", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.soniclabs.com"] } },
});

const client = createPublicClient({ chain: sonic, transport: http() });

const erc20Abi = parseAbi([
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "event Approval(address indexed owner, address indexed spender, uint256 value)",
]);

const maybeLockerAbi = parseAbi([
  "function recipeMarketHub() view returns (address)",
]);

export async function findDepositExecutorFromWallet(
  weirollWallet: Address,
  tokenAddresses: Address[],
  fromBlock?: bigint,
  toBlock?: bigint
): Promise<Address | null> {
  const spenderCounts: Record<string, number> = {};
  for (const token of tokenAddresses) {
    const logs = await client.getLogs({
      address: token,
      event: { signature: "Approval(address,address,uint256)" },
      args: { owner: weirollWallet },
      fromBlock,
      toBlock,
    });
    for (const log of logs) {
      const spender = getAddress((log.args as any).spender as string);
      spenderCounts[spender] = (spenderCounts[spender] ?? 0) + 1;
    }
  }
  const top = Object.entries(spenderCounts).sort((a, b) => b[1] - a[1])[0];
  return top ? (top[0] as Address) : null;
}

export async function findDepositLockerFromWallet(
  weirollWallet: Address,
  inputToken: Address,
  fromBlock?: bigint,
  toBlock?: bigint
): Promise<Address | null> {
  const logs = await client.getLogs({
    address: inputToken,
    event: { signature: "Transfer(address,address,uint256)" },
    args: { from: weirollWallet },
    fromBlock,
    toBlock,
  });
  // Count recipients; the locker will be the dominant recipient across fills
  const counts: Record<string, number> = {};
  for (const l of logs) {
    const to = getAddress((l.args as any).to as string);
    counts[to] = (counts[to] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return top ? (top[0] as Address) : null;
}

export async function verifyLockerPointsToHub(
  locker: Address,
  expectedHub: Address
): Promise<boolean> {
  try {
    const hub = await client.readContract({
      address: locker,
      abi: maybeLockerAbi,
      functionName: "recipeMarketHub",
    });
    return getAddress(hub as Address) === getAddress(expectedHub);
  } catch {
    return false; // not all builds expose this; absence isn’t a failure
  }
}

// Example:
// const weiroll = "0x...";
// const xUSD = "0x..."; // Sonic xUSD (input token for your market)
// const executor = await findDepositExecutorFromWallet(weiroll, [xUSD]);
// const locker = await findDepositLockerFromWallet(weiroll, xUSD);
// const ok = locker
//   ? await verifyLockerPointsToHub(locker, "0xFcc593aD3705EBcd72eC961c63eb484BE795BDbD")
//   : false;
```
Notes
If your campaign uses multiple input tokens, include all of them in tokenAddresses.
Restricting fromBlock/toBlock to the campaign’s active range speeds things up.
Once you have the Executor, you can often identify the campaign’s receipt token by watching max Approval events from the Weiroll wallet to that Executor, or by diffing balances around execution.

---

## 5) Enclabs (Sonic) — xUSD Core Pool

**Name:** Enclabs Core Pool (cToken‑like)

**Chain:** Sonic (chainId 146)

**Contracts**
- **Market:** `0x13d79435F306D155CA2b9Af77234c84f80506045`

**Events to watch**
- `Mint(minter, mintAmount, mintTokens)`
- `Redeem(redeemer, redeemAmount, redeemTokens)`
- Share `Transfer(from,to,amount)`

**Functions to read**
- `balanceOf(holder)` (cTokens), `exchangeRateStored()` (or equivalent), optionally `underlying()`

**TVL rule**
- `user_USD = balanceOf(user) * exchangeRateStored * $xUSD` (≈ $1), decimals‑adjusted

---

## 6) Stability.market (Sonic) — Stream Market (Deposits in xUSD)

**Name:** Stability Stream Market (Aave‑compatible Pool)

**Chain:** Sonic (chainId 146)

**Contracts**
- **Pool (proxy):** `0x1f672BD230D0FC2Ee9A75D2037a92CC1225A4Ad8`
- **Pool (implementation):** `0x77b7f2600b819c186c5735ac496bb4cf9bbaa997`
- **aToken for xUSD (interest‑bearing receipt):** **derive via** `Pool.getReserveData(xUSD).aTokenAddress` → **fill once resolved**

**Events to watch**
- **Pool (Aave semantics):** `Supply(user, onBehalfOf, asset, amount, ...)`, `Withdraw(user, to, asset, amount, ...)` *(use exact ABI from deployed build)*
- **aToken (ERC‑20 receipt):** `Transfer(from,to,amount)`; optional `Mint/Burn` if emitted

**Functions to read**
- **Discovery:** `getReserveData(asset)` → returns `aTokenAddress` (and other reserve info)
- **Balances:** `aToken.balanceOf(user)` (interest‑accruing), optional `aToken.scaledBalanceOf(user)` + `Pool.getReserveNormalizedIncome(asset)` for index math

**TVL rule**
- Attribute USD TVL to **aToken holder**: `user_USD = aToken.balanceOf(user) * $xUSD` (≈ $1)
- Reassign TVL on **aToken `Transfer`**; increase/decrease on **Pool `Supply`/`Withdraw`** for the user

**Notes**
- This is an Aave‑style pool clone; the Pool proxy dispatches to implementation; the **aToken** is the receipt of deposits.

---

## Snapshot & Indexer Checklist

- **Address registry** (per above) – fill all **TBD** items as discovered.
- **Indexers**
  - ERC‑4626 indexer (generic)
  - cToken/Aave indexer (generic)
  - Uniswap V2 LP indexer (generic)
  - *(Optional)* Uniswap V3 position indexer (generic)
- **Data model**
  - `positions`: `{ protocol, chainId, contract, kind, owner, size_shares, size_assets, updatedAt }`
  - `ownership`: mirror of receipt/NFT ownership via `Transfer`
  - `snapshots`: daily per owner USD TVL totals
- **Pricing**
  - For xUSD/USDC/scUSD: treat $1 until price feed is added
  - For other x* (xETH/xBTC): integrate price feed when those integrations go live

---

## Appendix — Royco Address Discovery Helpers (optional)

Use a Weiroll wallet known to have interacted with your Royco market and the relevant input token(s) (e.g., xUSD). The helpers infer the **Deposit Executor** (via ERC‑20 Approvals) and **Deposit Locker** (via ERC‑20 Transfers).

```ts
import { createPublicClient, http, parseAbi, getAddress, Address, defineChain } from "viem";

// Sonic mainnet (146)
const sonic = defineChain({
  id: 146, name: 'Sonic', network: 'sonic',
  nativeCurrency: { name: 'S', symbol: 'S', decimals: 18 },
  rpcUrls: { default: { http: ['https://rpc.soniclabs.com'] } }
});

const client = createPublicClient({ chain: sonic, transport: http() });

const erc20Abi = parseAbi([
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'event Approval(address indexed owner, address indexed spender, uint256 value)'
]);

export async function findExecutor(
  weirollWallet: Address,
  tokenAddrs: Address[],
  fromBlock?: bigint, toBlock?: bigint
): Promise<Address | null> {
  const counts: Record<string, number> = {};
  for (const token of tokenAddrs) {
    const logs = await client.getLogs({
      address: token,
      event: { signature: 'Approval(address,address,uint256)' },
      args: { owner: weirollWallet },
      fromBlock, toBlock
    });
    for (const l of logs) {
      const spender = getAddress((l.args as any).spender as string);
      counts[spender] = (counts[spender] ?? 0) + 1;
    }
  }
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return top ? (top[0] as Address) : null;
}

export async function findLocker(
  weirollWallet: Address,
  inputToken: Address,
  fromBlock?: bigint, toBlock?: bigint
): Promise<Address | null> {
  const logs = await client.getLogs({
    address: inputToken,
    event: { signature: 'Transfer(address,address,uint256)' },
    args: { from: weirollWallet },
    fromBlock, toBlock
  });
  const counts: Record<string, number> = {};
  for (const l of logs) {
    const to = getAddress((l.args as any).to as string);
    counts[to] = (counts[to] ?? 0) + 1;
  }
  const top = Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
  return top ? (top[0] as Address) : null;
}
```

