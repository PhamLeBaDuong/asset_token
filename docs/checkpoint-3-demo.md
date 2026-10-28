# Checkpoint 3 demo

## Prepare

From `frontend`, run `npm run dev` and open the URL it prints. Use the existing
factory address and matching chain ID. The factory and asset token can stay as
they are; this feature deploys a separate FundingCampaign for each round.

Have an issuer and three investor wallet accounts on that network, with test ETH
for contributions and gas. Create or load a tokenized business whose issuer owns
at least 20,000 tokens. The API is optional for funding; start it only when using
saved PostgreSQL asset lookup.

Automated demo, without wallets or testnet funds, from `frontend`:

```powershell
npm run compile:funding
node --test --test-isolation=none test/funding-campaign.test.js test/funding-ui.test.js
```

These tests use a fresh local Hardhat blockchain, including simulated time jumps.
They do not alter the browser's network or live testnet campaigns.

## Story 1: success

1. Connect the issuer and look up the asset.
2. In Funding campaigns, set goal to `0.01` ETH, offered tokens to `10000`, and a
   deadline comfortably in the future. Create the campaign and copy its address.
3. Click Approve offered tokens, then Deposit tokens & activate. Confirm each
   transaction. Show the issuer's token balance falling by 10,000 and state Active.
4. Switch to investor 1, reconnect, and look up the same asset. Paste the campaign
   address and load it. Contribute `0.002` ETH.
5. Repeat with investor 2 contributing `0.003` and investor 3 contributing `0.005`.
6. Show progress at 100% and state Successful. Contributions are now closed.
7. Switch to the issuer, reconnect, look up the asset, and load this campaign.
   Settle & receive funding. Show state Settled.
8. Each investor reconnects, looks up the asset, loads the campaign, and claims
   tokens: 2,000, 3,000, and 5,000 respectively. Show updated token balances and
   transaction hashes. Claim buttons disappear once claimed.

Explain: the campaign reserved existing tokens; it never minted more. Settlement
pays the issuer once; investors claim individually rather than through a large loop.

## Story 2: failure

1. As issuer, create a second round for the same token with goal `0.01` ETH and
   `10000` offered tokens. Set a deadline a few minutes ahead, leaving enough time
   for approval, activation, and investor confirmations. Copy this new address.
2. Approve and activate this campaign. Investor 1 contributes `0.002` ETH and
   investor 2 contributes `0.0015` ETH, using the same reconnect/lookup/load steps.
3. Show raised `0.0035` ETH, below goal. There is no issuer settlement action.
4. Wait until the deadline, then Load / refresh campaign. Anyone can now finalize
   the failed campaign. Confirm the transaction and show state Failed.
5. From each investor wallet, load the campaign and claim the refund. Contributions
   return as `0.002` and `0.0015` ETH, with separate network gas charges.
6. As issuer, reclaim offered tokens. This can happen before or after refunds and
   does not affect investors' ETH. Show the restored token balance.

Explain: time passing does not submit a transaction. Finalize records failure,
and each investor independently withdraws their own refund.

## Rejection evidence

The UI hides unavailable actions; automated contract tests directly attempt them
and verify rejection. Show passing tests for early issuer settlement, over-cap
payments, duplicate token/refund claims, successful-campaign refund rejection,
failed-campaign settlement rejection, and reentrant withdrawal attempts.

Browser addresses are saved locally for convenience. Other browsers need the
shared address. The UI checks the compiled campaign code, linked token, and issuer;
the asset page has already checked the token's factory registration.

Browser wallet interaction still requires a live rehearsal. Automated UI tests
exercise the real handlers and contracts with a small DOM adapter; they do not
drive MetaMask or render the page in a browser.
