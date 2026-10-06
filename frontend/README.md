# Minimal asset token frontend

This Vite + ethers frontend works with the existing `AssetTokenFactory` and
`AssetToken` contracts. A browser wallet signs transactions; the application never
asks for private keys. Use Node.js 24 LTS and a browser wallet such as MetaMask.

## Run

```powershell
cd frontend
npm ci
npm run dev
```

Open the localhost URL Vite prints. Connect your wallet, enter the expected chain
ID and an already deployed factory address, then complete the asset form. Optional
defaults can be set by copying `.env.example` to `.env` and restarting Vite.
These settings are public configuration, not secrets.

## Deploy a factory first

For a first demo, compile `smart_contracts/asset_factory.sol` in Remix using
Solidity 0.8.30, OpenZeppelin 5.6.1, optimizer enabled (200 runs), `viaIR: true`,
and EVM version Cancun on a compatible chain such as Sepolia. The constructor
has many inputs, so compilation uses viaIR. Match these settings to the automated
test compiler. Deploy `AssetTokenFactory` through Remix's browser wallet provider
on Sepolia (chain ID 11155111); the wallet needs test ETH for gas. Copy the factory
address into this app, with the wallet on that same network. Remix's isolated VM
is not accessible through the browser wallet used by this frontend.

Creating an asset prompts for one transaction. The factory deploys the token,
mints the configured initial supply to the caller, registers its address, and
emits an event. The UI extracts the token address from the confirmed receipt,
then reads metadata, total supply, and balances through the wallet's RPC.
It shows chain ID, transaction hash, creation block/hash, and the block used for
balance reads. Lookup by asset ID also works after reloading the page.

After creation, the app uses the transaction receipt directly. On later lookups,
it reads the token's stored creation timestamp and uses binary search over block
headers to locate the creation block. It queries events for that single block,
avoiding the wallet RPC's event-history range limit. This assumes strictly
increasing block timestamps, as on Ethereum Sepolia. Metadata URIs are stored as text;
the app does not upload or fetch documents. Valuation is a whole-number amount in
the currency you enter, without currency conversion. Asset IDs are case-sensitive.

## What minting means

Minting creates new token units and adds them to someone's balance, increasing
total supply. Transferring moves existing units between wallets without changing
total supply. Here, creation and initial minting happen in the same transaction.

For example, entering 1000 creates 1000 tokens owned by the connected issuer.
The contract stores that as 1000 × 10^18 base units (18 decimals). The form sends
1000 without scaling because the Solidity constructor handles scaling itself.
The supply field accepts non-negative whole tokens, including zero, matching the
contract. Minting records token units; it does not deposit the entered valuation
as money or automatically establish rights in a real-world asset.

This implementation deliberately keeps your selected **fixed-supply policy**.
There is no public `mint` function. Even the issuer's admin roles cannot mint
additional units. The extra-mint check uses `eth_call` to simulate the conventional
`mint(address,uint256)` call from the connected account; this contract reverts
because that function does not exist. This is not a demonstration of role-gated
minting, nor does a single reverted call prove that an arbitrary third-party token
is fixed-supply. A role-gated mint function would require a contract change.

To demonstrate rejection from a different user, create a token with wallet A,
switch to wallet B, reconnect, look up the asset, and click the simulation button.
The issuer displayed remains wallet A. Simulation spends no gas and does not
submit a transaction. Supply and balances can be refreshed using lookup.
The factory has zero tokens at creation; later transfers to it are possible.

## Checkpoint 2, step 2: transfer UI

After connecting and creating or looking up a token, the Transfer tokens section
shows its contract address and your connected wallet's balance. Enter a recipient
wallet address and an amount in tokens, then press Transfer. Your browser wallet
signs `AssetToken.transfer(recipient, amount)` directly. No backend or private key
input is involved. The app waits for confirmation, displays the transaction hash,
and re-reads balances at a block that includes the confirmed transfer.

Amounts may include fractions, such as `2.5`. The app uses `parseUnits` with the
token's decimals and rejects excess precision rather than rounding. This differs
from initial supply: the constructor scales supply, but `transfer` expects base
units, so the frontend scales transfer amounts. Invalid addresses, the zero
address, and non-positive amounts are rejected before a wallet prompt.

For the browser demonstration on your chosen network:

1. Connect Alice and create `coffee-001` with name Duong Coffee Token, symbol
   DCOF, and initial supply `100000`. Complete the other asset fields as usual.
2. Enter Bob's wallet address and `10000`, then approve the transfer. Alice's
   refreshed balance should be 90,000 DCOF.
3. Switch the wallet to Bob, reconnect, and look up `coffee-001` using the same
   factory address and chain. Your balance should show 10,000 DCOF.
4. Transfer `2500` to Carol. Bob's refreshed balance should be 7,500 DCOF.
5. Switch to Carol, reconnect, and look up the asset. Your balance should show
   2,500 DCOF. Total supply remains 100,000 throughout.

Each sending wallet needs native test ETH for gas on Sepolia. Account or network
changes clear the loaded asset, requiring reconnect and lookup. A declined wallet
prompt or reverted transaction displays an error. If a confirmed transaction's
balance refresh fails, its hash remains visible; retry using lookup.

The local automated transfer check uses the same ABI, input conversion, and
balance reader as the frontend:

```powershell
node --test --test-name-pattern="checkpoint step 2" test/contracts.test.js
```

## Checkpoint 2, step 3: invalid transfers and authorization

From `frontend`, run the security demonstration alone:

```powershell
node --test --test-name-pattern="checkpoint step 3" test/contracts.test.js
```

The test deploys a fresh coffee token and repeats the valid transfers, giving
Alice 90,000, Bob 7,500, and Carol 2,500 DCOF. It then checks:

1. Bob attempts to send Carol 10,000. The contract reverts with
   `ERC20InsufficientBalance`, identifying Bob, his 7,500 balance, and the
   requested 10,000. All three balances and total supply remain unchanged.
2. Carol calls `transferFrom(bob, carol, 5000)` without Bob's approval. The
   contract reverts with `ERC20InsufficientAllowance`, identifying Carol's zero
   allowance and the requested 5,000. Balances, supply, and allowance stay unchanged.
3. Bob approves Carol for 1,000. Approval changes allowance, without moving any
   tokens. Carol still cannot transfer 5,000, but a confirmed transfer of 1,000
   succeeds. Bob ends with 6,500, Carol with 3,500, and Alice with 90,000. The
   allowance is consumed to zero; another attempt by Carol is rejected. Supply
   stays at 100,000.

The rejected calls use ethers `staticCall`: they execute the contract on the
local chain as simulations, without submitting transactions or spending gas.
The tests assert the precise decoded contract error and its arguments, so an RPC
failure cannot accidentally count as a passing security test. Approval and the
authorized transfer are actual confirmed transactions on that local chain.

`transfer` sends the caller's own tokens. `transferFrom` sends another address's
tokens and requires an allowance from that owner to the caller. These protections
already exist in the inherited OpenZeppelin ERC-20; no Solidity changes are needed.

## Verification and GitHub CI

### Checkpoint 2, step 1: three wallets, one token

From `frontend`, run only this checkpoint step:

```powershell
node --test --test-name-pattern="checkpoint step 1" test/contracts.test.js
```

The test uses three distinct funded accounts on a temporary local Hardhat chain:
account 0 is Alice (issuer), account 1 is Bob, and account 2 is Carol. Alice deploys
the factory and creates `coffee-001`, named Duong Coffee Token (`DCOF`), with an
initial supply of 100,000. The factory records Alice as issuer and returns the
address of the new token. Each account then calls `balanceOf` on that same token.

Expected balances: Alice = 100,000 DCOF, Bob = 0, Carol = 0. The test prints the
token address, wallet addresses, and balances, and asserts those results. ERC-20
stores balances in base units; this contract uses 18 decimals, so 100,000 tokens
are stored as 100,000 times 10^18. The factory constructor arguments take the
whole-token supply because the token constructor already performs that scaling.

This local chain is discarded when the test finishes. These accounts are separate
from your browser wallet and Sepolia deployment. This step verifies the initial
ownership and shared contract; transfers come in step 2.

```powershell
npm test
npm run build
```

Tests compile the actual Solidity source and deploy it on an in-process Hardhat
blockchain. They exercise the same creation arguments, ABIs, event parsing,
blockchain reads, and extra-mint simulation that the frontend uses. No RPC account,
wallet secret, or real ETH is needed. They cover metadata, supply, issuer roles
and balance, zero factory balance, duplicate rejection, and independent assets.

`.github/workflows/frontend.yml` installs locked dependencies, tests the contracts,
and builds the frontend on pushes and pull requests. This is CI; it does not
automatically deploy a factory or publish the frontend.

The browser wallet interaction still needs a manual check on your chosen network:
connect, create, reject a wallet prompt, try a duplicate asset ID, reload and look
up an asset, switch accounts, and try the mint simulation.
