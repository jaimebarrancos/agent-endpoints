import 'dotenv/config';
import { createPublicClient, http, encodeFunctionData } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import * as Constants from '../constants.ts';

export interface WithdrawPositionOptions {
    account: string;
    tokenId?: string | number;
    network?: string;
    percentage?: number; // 1 to 100, default 100
}

export interface PreparedTransaction {
    id: string;
    description: string;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: string;
}

export interface WithdrawPositionResult {
    success: boolean;
    account: string;
    tokenId: string;
    liquidityWithdrawn: string;
    remainingLiquidity: string;
    percentage: number;
    preparedTransactions: PreparedTransaction[];
}

export async function withdrawPosition(options: WithdrawPositionOptions): Promise<WithdrawPositionResult> {
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const isTestnet = options.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    const chain = isTestnet ? baseSepolia : base;
    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const positionManagerAddress = (isTestnet ? Constants.POSITION_MANAGER_TESTNET : Constants.POSITION_MANAGER_MAINNET) as `0x${string}`;

    const account = options.account as `0x${string}`;
    let targetTokenId: bigint;

    if (options.tokenId !== undefined && options.tokenId !== null && String(options.tokenId).trim() !== '') {
        targetTokenId = BigInt(options.tokenId);
    } else {
        // Resolve latest token ID for account
        const nftBalance = await publicClient.readContract({
            address: positionManagerAddress,
            abi: Constants.NPM_ABI,
            functionName: 'balanceOf',
            args: [account],
        });

        if (nftBalance === 0n) {
            throw new Error(`No Uniswap v3 positions (NFTs) found for account ${options.account}`);
        }

        targetTokenId = await publicClient.readContract({
            address: positionManagerAddress,
            abi: Constants.NPM_ABI,
            functionName: 'tokenOfOwnerByIndex',
            args: [account, nftBalance - 1n],
        });
    }

    // Read position details from NonfungiblePositionManager
    const posData = await publicClient.readContract({
        address: positionManagerAddress,
        abi: Constants.NPM_ABI,
        functionName: 'positions',
        args: [targetTokenId],
    });

    // posData layout:
    // [nonce, operator, token0, token1, fee, tickLower, tickUpper, liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128, tokensOwed0, tokensOwed1]
    const currentLiquidity = posData[7];
    const tokensOwed0 = posData[10];
    const tokensOwed1 = posData[11];

    if (currentLiquidity === 0n && tokensOwed0 === 0n && tokensOwed1 === 0n) {
        throw new Error(`Position #${targetTokenId} has zero liquidity and no tokens to collect.`);
    }

    const pct = Math.min(100, Math.max(1, options.percentage || 100));
    const liquidityToDecrease = (currentLiquidity * BigInt(pct)) / 100n;
    const remainingLiquidity = currentLiquidity - liquidityToDecrease;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 1800); // 30 minutes
    const MAX_UINT128 = (1n << 128n) - 1n;

    const preparedTransactions: PreparedTransaction[] = [];

    // Step 1: Decrease Liquidity (if liquidity > 0)
    if (liquidityToDecrease > 0n) {
        const decreaseData = encodeFunctionData({
            abi: Constants.NPM_ABI,
            functionName: 'decreaseLiquidity',
            args: [
                {
                    tokenId: targetTokenId,
                    liquidity: liquidityToDecrease,
                    amount0Min: 0n,
                    amount1Min: 0n,
                    deadline,
                },
            ],
        });

        preparedTransactions.push({
            id: 'decrease_liquidity',
            description: `Decrease Liquidity by ${pct}% (${liquidityToDecrease.toString()} units) for Position #${targetTokenId}`,
            to: positionManagerAddress,
            data: decreaseData,
        });
    }

    // Step 2: Collect accumulated tokens & fees
    const collectData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'collect',
        args: [
            {
                tokenId: targetTokenId,
                recipient: account,
                amount0Max: MAX_UINT128,
                amount1Max: MAX_UINT128,
            },
        ],
    });

    preparedTransactions.push({
        id: 'collect_tokens',
        description: `Collect all underlying tokens and fees for Position #${targetTokenId} to ${account}`,
        to: positionManagerAddress,
        data: collectData,
    });

    // Step 3: Burn NFT if 100% full withdrawal and remaining liquidity will be 0
    if (pct === 100 || remainingLiquidity === 0n) {
        const burnData = encodeFunctionData({
            abi: Constants.NPM_ABI,
            functionName: 'burn',
            args: [targetTokenId],
        });

        preparedTransactions.push({
            id: 'burn_position_nft',
            description: `Burn empty Position #${targetTokenId} NFT`,
            to: positionManagerAddress,
            data: burnData,
        });
    }

    return {
        success: true,
        account,
        tokenId: targetTokenId.toString(),
        liquidityWithdrawn: liquidityToDecrease.toString(),
        remainingLiquidity: remainingLiquidity.toString(),
        percentage: pct,
        preparedTransactions,
    };
}
