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

Historical lookup queries the factory's creation events starting at block zero.
Some public RPCs limit log ranges; use a provider allowing historical queries for
this minimal demo. A larger app should query paginated ranges from the factory's
deployment block or maintain an event index. Metadata URIs are stored as text;
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

## Verification and GitHub CI

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
