# Checkpoint 3: funding campaign design

## Step 1: agree on the lifecycle

Keep `AssetToken` responsible for the existing fixed-supply asset token. Add a
separate `FundingCampaign` contract for each funding round. The campaign holds
the tokens offered for that round and the ETH contributed by investors.

For this checkpoint, contributions use native ETH on the selected test network.
Funding amounts in the contract use wei; the frontend will display ETH.

### States and allowed actions

| State | Meaning | Allowed actions |
| --- | --- | --- |
| Setup | Campaign exists, but offered tokens are not reserved yet. | Issuer approves the campaign to spend the offered tokens, then activates it. |
| Active | Offered tokens are in escrow and the deadline has not passed. | Investors contribute up to the remaining goal. Anyone can finalize after the deadline. |
| Successful | Contributions have reached the goal exactly. | Issuer settles the campaign to receive the raised ETH. |
| Failed | Deadline passed before the goal was reached, and the campaign was finalized. | Contributors claim refunds. Issuer reclaims the reserved tokens. |
| Settled | Successful funding has been paid to the issuer. | Contributors claim their token allocations. |

Activation transfers the offered tokens from the issuer to the campaign in the
same transaction that changes Setup to Active. If the transfer fails, activation
fails too. Activation must occur before the deadline.

```text
Setup -- reserve offered tokens --> Active
Active -- contribution reaches goal --> Successful
Active -- finalize after deadline, below goal --> Failed
Successful -- issuer settles --> Settled
Failed -- individual refund claims --> remains Failed
Settled -- individual token claims --> remains Settled
```

An Active campaign cannot accept contributions at or after its deadline, even
if nobody has called finalize yet. Passing time does not itself send a blockchain
transaction: someone must call finalize to record failure.

### Funding and allocation rules

- The goal is also the hard cap. Reject a contribution larger than the remaining
  goal, and reject zero contributions.
- Reaching the goal ends fundraising immediately, even before the deadline.
- Investors receive no tokens during fundraising.
- Settlement pays the issuer once. Each investor then claims their own tokens,
  without a loop over all contributors.
- Allocation is `contribution * offeredTokens / fundingGoal`, calculated in
  integer base units with rounding down. Implementation must handle multiplication
  safely. Any rounding remainder can return to the issuer only after all investor
  claims have completed.
- Failed campaigns pay the issuer no contributed ETH. Each contributor claims
  their own original contribution once.
- Token claims, refunds, settlement, and return of escrow must prevent repeat
  withdrawals and reentrant withdrawals.

### Example to use while implementing

An issuer already owns 100,000 DCOF and reserves 10,000 DCOF for a campaign with
a 1 ETH goal.

Successful round:

1. Alice contributes 0.2 ETH; Bob contributes 0.3 ETH; Carol contributes 0.5 ETH.
2. The total reaches 1 ETH and the state becomes Successful.
3. The issuer settles, receives 1 ETH, and the state becomes Settled.
4. Alice, Bob, and Carol claim 2,000, 3,000, and 5,000 DCOF respectively.

Failed round, using a separate campaign:

1. Alice contributes 0.2 ETH and Bob contributes 0.15 ETH.
2. The deadline passes with only 0.35 ETH raised.
3. Someone finalizes the campaign, changing its state to Failed.
4. Alice and Bob claim their refunds; the issuer reclaims the offered tokens.

In both examples the issuer cannot withdraw contributed ETH while Active.
Refund amounts exclude transaction fees, which are paid to the network.

## Step 2: constructor implemented

`smart_contracts/funding_campaign.sol` now records the deploying wallet as issuer,
the token address, funding goal, deadline, and offered token amount. These terms
are immutable. The campaign starts in Setup, with zero contributions and no
tokens deposited yet.

The constructor rejects a zero token address, an address without contract code,
a zero funding goal, a deadline at or before the current block timestamp, and
zero offered tokens. Checking for contract code alone does not establish that
the address is a factory-registered AssetToken; integration checks come later.

Constructor tests use a real local AssetToken deployment. Run from `frontend`:

```powershell
node --test --test-isolation=none test/funding-campaign.test.js
```

## Step 3: escrow activation implemented

The issuer calls `approve(campaignAddress, offeredTokens)` on the asset token,
then `activate()` on the campaign. Approval grants permission; activation actually
moves the tokens. Only the issuer can activate, only once, and before the deadline.

Activation uses SafeERC20 and a reentrancy guard. It checks that the campaign's
token balance increased by exactly the offered amount. A failed transfer rolls
back the transaction, leaving the campaign in Setup. Existing tokens sent directly
to the campaign do not substitute for the issuer's required escrow deposit.

The local suite now passes 16 tests covering configuration, successful escrow,
missing/insufficient approval, insufficient issuer balance, unauthorized/repeated/
expired activation, and protection of reserved tokens from issuer spending.

## Step 4: contributions implemented

Investors call payable `contribute()` with ETH. The campaign records each wallet's
cumulative contribution and totalRaised. It rejects zero payments, payments
larger than the remaining goal, payments before activation or after success, and
payments at or after the deadline. Reaching the goal immediately records
Successful. ETH and offered tokens remain in the campaign pending settlement.

ContributionReceived and CampaignSuccessful events expose these changes to a
future frontend. Ordinary ETH transfers without calling contribute are rejected.

The funding suite now passes 26 tests, including three distinct investors,
repeated contributions by one wallet, over-cap transaction rollback, exact goal
success, and deadline boundaries.

## Run locally

From the project root, start the frontend:

```powershell
cd frontend
npm run dev
```

In another terminal, start the API if using saved database assets (requires the
existing `server/.env` database configuration):

```powershell
cd server
npm run dev
```

The funding UI is not implemented yet. Its tests deploy fresh contracts to an
in-process Hardhat blockchain, requiring no browser wallet, API, or testnet ETH.
From `frontend`, run funding tests or the full frontend test suite:

```powershell
node --test --test-isolation=none test/funding-campaign.test.js
node --test --test-isolation=none test/*.test.js
```

## Step 5: successful settlement and token claims implemented

Only the issuer can call `settle()`, and only in Successful. It records Settled
and transfers totalRaised to the issuer. A failed payment rolls back settlement
so it can be retried. Reentrancy protection prevents nested withdrawals.

After settlement, each contributor calls `claimTokens()` once. `tokenAllocation`
uses Math.mulDiv for proportional allocation with rounding down, avoiding
intermediate multiplication overflow. Original contribution amounts remain
available for history; a separate flag records each completed token claim.

`reclaimRemainder()` returns any rounding dust to the issuer once, only after
all contributions have been accounted for by completed token claims. Even an
allocation rounding down to zero can complete its claim. No investor loop is
required for settlement, claims, or remainder recovery.

Tests cover exact issuer payment including gas accounting, early/unauthorized/
repeated settlement, individual allocations, non-contributors, duplicate claims,
rounding, rejected issuer payments, and an issuer callback attempting reentrancy.

Suggested commit message:

```text
feat: settle successful campaigns and support investor token claims
```

## Next step

Implement deadline-based failure finalization, individual refunds, and return of
failed-campaign escrow to the issuer.
