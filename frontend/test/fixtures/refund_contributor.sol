// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "funding_campaign.sol";

// Test-only investor that rejects refunds or attempts a nested refund claim.
contract RefundContributor {
    FundingCampaign public campaign;
    bool public rejectPayment;
    bool public attemptReentry;
    bool public reentryBlocked;

    function contribute(address campaign_) external payable {
        campaign = FundingCampaign(campaign_);
        campaign.contribute{value: msg.value}();
    }

    function configure(bool reject, bool reenter) external {
        rejectPayment = reject;
        attemptReentry = reenter;
    }

    function claimRefund() external { campaign.claimRefund(); }

    receive() external payable {
        require(!rejectPayment, "Refund rejected");
        if (attemptReentry) {
            try campaign.claimRefund() { reentryBlocked = false; }
            catch { reentryBlocked = true; }
        }
    }
}
