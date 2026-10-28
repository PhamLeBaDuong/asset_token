# Funding browser demo evidence

These captures come from the actual rendered frontend and transactions on an
isolated local Hardhat blockchain. ETH is simulated. See [results.json](results.json)
for the recorded outcomes and local campaign addresses.

| Screen | What it shows |
| --- | --- |
| [Wallet](01-wallet.png) | Navbar and the Start local demo entry point |
| [Issuer](02-issuer-create.png) | Campaign creation form for the original issuer |
| [Investor](03-investor-contribute.png) | Active campaign and ETH contribution form |
| [Successful round](04-success-settled.png) | Settled campaign after investor token claims |
| [Failed round](05-failed-refund.png) | Failed campaign with a refund action |
| [Mobile](06-mobile.png) | Responsive layout with no page overflow |

To try the same flow, run `npm run dev` from `frontend`, open Wallet, and click
Start local demo. Create, approve, and activate a round, then switch accounts in
the demo toolbar. The original browser wallet is not used for these transactions.

Commit message for the redesign and demo:

```text
feat: add workspace navigation and an interactive local funding demo
```
