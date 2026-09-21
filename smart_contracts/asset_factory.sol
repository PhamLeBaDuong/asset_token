// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./asset_token.sol";

contract AssetTokenFactory {

    struct TokenizedAsset {
        string assetId;
        address tokenAddress;
        address issuer;
    }

    TokenizedAsset[] public assets;

    mapping(string => address) public tokenByAssetId;

    event AssetTokenCreated(
        string assetId,
        address indexed tokenAddress,
        address indexed issuer
    );

    function createAssetToken(
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
        external
        returns (address)
    {
        require(
            tokenByAssetId[assetId] == address(0),
            "Asset already tokenized"
        );

        AssetToken token = new AssetToken(
            msg.sender,
            tokenName,
            tokenSymbol,
            initialSupply,
            assetId,
            assetName,
            assetType,
            valuation,
            currency,
            metadataURI,
            documentHash
        );

        tokenByAssetId[assetId] = address(token);

        assets.push(
            TokenizedAsset({
                assetId: assetId,
                tokenAddress: address(token),
                issuer: msg.sender
            })
        );

        emit AssetTokenCreated(
            assetId,
            address(token),
            msg.sender
        );

        return address(token);
    }
    
    function getAssetCount() 
    external 
    view 
    returns (uint256)
    {
        return assets.length;
    }
}