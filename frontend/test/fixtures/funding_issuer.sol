// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "funding_campaign.sol";

// Test-only issuer that can reject payment or attempt a nested settlement.
contract FundingIssuer {
    FundingCampaign public campaign;
    bool public rejectPayment;
    bool public attemptReentry;
    bool public reentryBlocked;

    function launch(address token, uint256 goal, uint256 deadline, uint256 offered) external {
        campaign = new FundingCampaign(token, goal, deadline, offered);
        IERC20(token).approve(address(campaign), offered);
        campaign.activate();
    }

    function configure(bool reject, bool reenter) external {
        rejectPayment = reject;
        attemptReentry = reenter;
    }

    function settle() external { campaign.settle(); }

    receive() external payable {
        require(!rejectPayment, "Payment rejected");
        if (attemptReentry) {
            try campaign.settle() { reentryBlocked = false; }
            catch { reentryBlocked = true; }
        }
    }
}
