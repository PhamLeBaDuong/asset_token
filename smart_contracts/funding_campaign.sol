// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/// @notice One funding round for an existing asset token.
/// @dev Escrows funding for successful settlement or individual failure refunds.
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
    mapping(address => bool) public tokensClaimed;
    uint256 public claimedContributions;
    uint256 public totalTokensClaimed;
    bool public remainderReclaimed;
    mapping(address => bool) public refundClaimed;
    uint256 public totalRefunded;
    bool public escrowReturned;

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
    error EtherTransferFailed();
    error NothingToClaim();
    error AlreadyClaimed();
    error ClaimsOutstanding();
    error DeadlineNotReached();

    event CampaignActivated(address indexed issuer, uint256 offeredTokens);
    event ContributionReceived(address indexed contributor, uint256 amount, uint256 totalRaised);
    event CampaignSuccessful(uint256 totalRaised);
    event CampaignSettled(address indexed issuer, uint256 amount);
    event TokensClaimed(address indexed contributor, uint256 amount);
    event RemainderReclaimed(uint256 amount);
    event CampaignFailed(uint256 totalRaised);
    event RefundClaimed(address indexed contributor, uint256 amount);
    event EscrowReturned(address indexed issuer, uint256 amount);

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

    /// @notice Pay successful funding to the issuer once.
    function settle() external nonReentrant {
        require(msg.sender == issuer, OnlyIssuer());
        require(state == CampaignState.Successful, InvalidState());

        state = CampaignState.Settled;
        (bool sent, ) = payable(issuer).call{value: totalRaised}("");
        require(sent, EtherTransferFailed());
        emit CampaignSettled(issuer, totalRaised);
    }

    /// @notice Record failure after an underfunded campaign's deadline.
    /// @dev Anyone may finalize so investors do not depend on the issuer.
    function finalizeCampaign() external nonReentrant {
        require(state == CampaignState.Active, InvalidState());
        require(block.timestamp >= deadline, DeadlineNotReached());
        state = CampaignState.Failed;
        emit CampaignFailed(totalRaised);
    }

    /// @notice Return a failed campaign's contribution to its original sender.
    function claimRefund() external nonReentrant {
        require(state == CampaignState.Failed, InvalidState());
        uint256 amount = contributions[msg.sender];
        require(amount > 0, NothingToClaim());
        require(!refundClaimed[msg.sender], AlreadyClaimed());

        refundClaimed[msg.sender] = true;
        totalRefunded += amount;
        (bool sent, ) = payable(msg.sender).call{value: amount}("");
        require(sent, EtherTransferFailed());
        emit RefundClaimed(msg.sender, amount);
    }

    /// @notice Return offered tokens after failure without affecting ETH refunds.
    function reclaimFailedTokens() external nonReentrant {
        require(msg.sender == issuer, OnlyIssuer());
        require(state == CampaignState.Failed, InvalidState());
        require(!escrowReturned, AlreadyClaimed());
        escrowReturned = true;
        assetToken.safeTransfer(issuer, offeredTokens);
        emit EscrowReturned(issuer, offeredTokens);
    }

    /// @notice Proportional allocation in token base units, rounded down.
    function tokenAllocation(address contributor) public view returns (uint256) {
        return Math.mulDiv(contributions[contributor], offeredTokens, fundingGoal);
    }

    /// @notice Investors individually collect tokens after successful settlement.
    function claimTokens() external nonReentrant {
        require(state == CampaignState.Settled, InvalidState());
        uint256 contribution = contributions[msg.sender];
        require(contribution > 0, NothingToClaim());
        require(!tokensClaimed[msg.sender], AlreadyClaimed());

        uint256 allocation = tokenAllocation(msg.sender);
        // Record the claim before transferring. Failed transfers roll this back.
        tokensClaimed[msg.sender] = true;
        claimedContributions += contribution;
        totalTokensClaimed += allocation;
        if (allocation > 0) assetToken.safeTransfer(msg.sender, allocation);
        emit TokensClaimed(msg.sender, allocation);
    }

    /// @notice Return rounding dust only after every investor has claimed.
    function reclaimRemainder() external nonReentrant {
        require(msg.sender == issuer, OnlyIssuer());
        require(state == CampaignState.Settled, InvalidState());
        require(claimedContributions == totalRaised, ClaimsOutstanding());
        require(!remainderReclaimed, AlreadyClaimed());

        uint256 remainder = offeredTokens - totalTokensClaimed;
        remainderReclaimed = true;
        if (remainder > 0) assetToken.safeTransfer(issuer, remainder);
        emit RemainderReclaimed(remainder);
    }
}
