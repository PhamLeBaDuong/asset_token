// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/access/AccessControl.sol";

contract AssetToken is ERC20, AccessControl {

    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");

    struct Asset {
        string assetId;
        string assetName;
        string assetType;
        uint256 valuation;
        string currency;
        string metadataURI;
        bytes32 documentHash;
        uint256 tokenizedAt;
        bool active;
    }

    Asset public asset;

    constructor(
        string memory tokenName,
        string memory tokenSymbol,
        uint256 initialSupply,

        string memory assetId,
        string memory assetName,
        string memory assetType,
        uint256 valuation,
        string memory currency,
        string memory metadataURI,
        bytes32 documentHash
    )
        ERC20(tokenName, tokenSymbol)
    {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(ADMIN_ROLE, msg.sender);

        asset = Asset({
            assetId: assetId,
            assetName: assetName,
            assetType: assetType,
            valuation: valuation,
            currency: currency,
            metadataURI: metadataURI,
            documentHash: documentHash,
            tokenizedAt: block.timestamp,
            active: true
        });

        _mint(msg.sender, initialSupply * 10 ** decimals());
    }
}