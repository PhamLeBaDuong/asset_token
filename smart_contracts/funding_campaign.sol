// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @notice One funding round for an existing asset token.
/// @dev Escrows tokens and contributions; settlement and refunds are added next.
contract FundingCampaign is ReentrancyGuard {
    using SafeERC20 for IERC20;
    enum CampaignState { Setup, Active, Successful, Failed, Settled }

    address public immutable issuer;
    IERC20 public immutable assetToken;
    uint256 public immutable fundingGoal; // Wei, not whole ETH.
    uint256 public immutable deadline; // Unix timestamp in seconds.
    uint256 public immutable offeredTokens; // ERC-20 base units.

    CampaignState public state;
    uint256 public totalRaised;
    mapping(address => uint256) public contributions;

    error InvalidAssetToken();
    error InvalidFundingGoal();
    error InvalidDeadline();
    error InvalidOfferedTokens();
    error OnlyIssuer();
    error InvalidState();
    error DeadlinePassed();
    error IncorrectEscrowAmount();
    error ZeroContribution();
    error FundingCapExceeded();

    event CampaignActivated(address indexed issuer, uint256 offeredTokens);
    event ContributionReceived(address indexed contributor, uint256 amount, uint256 totalRaised);
    event CampaignSuccessful(uint256 totalRaised);

    constructor(
        address assetToken_,
        uint256 fundingGoal_,
        uint256 deadline_,
        uint256 offeredTokens_
    ) {
        // Reject missing addresses and ordinary wallets: a token must be a contract.
        require(assetToken_ != address(0) && assetToken_.code.length > 0, InvalidAssetToken());
        require(fundingGoal_ > 0, InvalidFundingGoal());
        require(deadline_ > block.timestamp, InvalidDeadline());
        require(offeredTokens_ > 0, InvalidOfferedTokens());

        issuer = msg.sender;
        assetToken = IERC20(assetToken_);
        fundingGoal = fundingGoal_;
        deadline = deadline_;
        offeredTokens = offeredTokens_;
        state = CampaignState.Setup;
    }

    /// @notice Reserve the offered tokens before accepting contributions.
    /// @dev Issuer must first approve this campaign on the asset token contract.
    function activate() external nonReentrant {
        require(msg.sender == issuer, OnlyIssuer());
        require(state == CampaignState.Setup, InvalidState());
        require(block.timestamp < deadline, DeadlinePassed());

        uint256 balanceBefore = assetToken.balanceOf(address(this));
        // All changes, including this state change, roll back if escrow fails.
        state = CampaignState.Active;
        assetToken.safeTransferFrom(issuer, address(this), offeredTokens);
        require(
            assetToken.balanceOf(address(this)) == balanceBefore + offeredTokens,
            IncorrectEscrowAmount()
        );

        emit CampaignActivated(issuer, offeredTokens);
    }

    /// @notice Contribute ETH up to the remaining funding goal.
    function contribute() external payable nonReentrant {
        require(state == CampaignState.Active, InvalidState());
        require(block.timestamp < deadline, DeadlinePassed());
        require(msg.value > 0, ZeroContribution());
        require(msg.value <= fundingGoal - totalRaised, FundingCapExceeded());

        contributions[msg.sender] += msg.value;
        totalRaised += msg.value;
        emit ContributionReceived(msg.sender, msg.value, totalRaised);

        if (totalRaised == fundingGoal) {
            state = CampaignState.Successful;
            emit CampaignSuccessful(totalRaised);
        }
    }
}
