import 'dotenv/config';
import { createPublicClient, http, encodeFunctionData, parseEther, formatEther, maxUint256 } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import * as Constants from '../constants.ts';
import { checkUniswapPositionsHealth } from './subgraph.ts';
import { getUniswapQuote, calculateSlippageBounds, calculateOptimalMintAmounts } from './uniswap_api.ts';

export interface RebalanceOptions {
    account: string;
    tokenId?: string | number;
    network?: string;
    rangeWidth?: number;
}

export interface PreparedTransaction {
    id: string;
    description: string;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: string;
}

export interface RebalanceResult {
    success: boolean;
    account: string;
    oldTokenId: string;
    oldPosition: {
        tickLower: number;
        tickUpper: number;
        liquidity: string;
    };
    newPosition: {
        tickLower: number;
        tickUpper: number;
        currentTick: number;
    };
    preparedTransactions: PreparedTransaction[];
    swapDetails?: {
        tokenIn: string;
        tokenOut: string;
        amountIn: string;
    };
}

export async function rebalancePosition(options: RebalanceOptions): Promise<RebalanceResult> {
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const isTestnet = options.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    const chain = isTestnet ? baseSepolia : base;

    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    console.log(`[Rebalance Service] Generating non-custodial rebalance plan for account: ${options.account}`);
    console.log(`[Rebalance Service] Connected to RPC: ${rpcUrl} (Network: ${isTestnet ? 'Base Sepolia' : 'Base Mainnet / Anvil Fork'})`);

    // =========================================================================
    // STEP 0: RESOLVE POSITION TOKEN ID & FETCH INITIAL POOL TICK
    // =========================================================================
    const [, initialPoolTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    let targetTokenId: bigint | undefined;

    if (options.tokenId) {
        targetTokenId = BigInt(options.tokenId);
    } else {
        try {
            const health = await checkUniswapPositionsHealth(options.account, { network: options.network });
            const activePositions = health.positions.filter((p) => BigInt(p.liquidity) > 0n);
            const targetPos = activePositions.find((p) => p.status === 'OUT_OF_RANGE') || activePositions[0] || health.positions[0];
            if (targetPos && targetPos.id) {
                targetTokenId = BigInt(targetPos.id);
            }
        } catch (e) {
            console.warn('[Rebalance Service] Subgraph position lookup failed, falling back to on-chain query...');
        }

        if (!targetTokenId) {
            try {
                const npmBal = await publicClient.readContract({
                    address: Constants.POSITION_MANAGER,
                    abi: Constants.NPM_ABI,
                    functionName: 'balanceOf',
                    args: [options.account as `0x${string}`],
                });

                for (let i = npmBal - 1n; i >= 0n; i--) {
                    const tokenId = await publicClient.readContract({
                        address: Constants.POSITION_MANAGER,
                        abi: Constants.NPM_ABI,
                        functionName: 'tokenOfOwnerByIndex',
                        args: [options.account as `0x${string}`, i],
                    });

                    const posData = await publicClient.readContract({
                        address: Constants.POSITION_MANAGER,
                        abi: Constants.NPM_ABI,
                        functionName: 'positions',
                        args: [tokenId],
                    });

                    if (posData[7] > 0n) {
                        targetTokenId = tokenId;
                        break;
                    }
                }
            } catch (err) {
                console.warn('[Rebalance Service] On-chain fallback query failed:', err);
            }
        }
    }

    if (targetTokenId === undefined) {
        throw new Error(`No active Uniswap position found for account ${options.account}`);
    }

    console.log(`[Rebalance Service] Target Position NFT Token ID: ${targetTokenId.toString()}`);

    const posData = await publicClient.readContract({
        address: Constants.POSITION_MANAGER,
        abi: Constants.NPM_ABI,
        functionName: 'positions',
        args: [targetTokenId],
    });

    const [, , token0, token1, fee, tickLower, tickUpper, liquidity, , , tokensOwed0, tokensOwed1] = posData;

    if (liquidity === 0n) {
        throw new Error(`Position NFT #${targetTokenId} has zero liquidity.`);
    }

    const preparedTransactions: PreparedTransaction[] = [];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    // =========================================================================
    // STEP 1: WITHDRAW (DECREASE LIQUIDITY + COLLECT)
    // =========================================================================
    console.log(`[Rebalance Service] Preparing Step 1: Withdraw 100% liquidity (${liquidity.toString()}) from position #${targetTokenId}...`);

    const decreaseLiquidityData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'decreaseLiquidity',
        args: [
            {
                tokenId: targetTokenId,
                liquidity,
                amount0Min: 0n,
                amount1Min: 0n,
                deadline,
            },
        ],
    });

    const maxUint128 = 340282366920938463463374607431768211455n;

    const collectData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'collect',
        args: [
            {
                tokenId: targetTokenId,
                recipient: options.account as `0x${string}`,
                amount0Max: maxUint128,
                amount1Max: maxUint128,
            },
        ],
    });

    const burnData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'burn',
        args: [targetTokenId],
    });

    const multicallData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'multicall',
        args: [[decreaseLiquidityData, collectData, burnData]],
    });

    preparedTransactions.push({
        id: 'withdraw_collect_burn',
        description: `Atomic Withdraw 100% liquidity, Collect tokens & Burn position #${targetTokenId}`,
        to: Constants.POSITION_MANAGER,
        data: multicallData,
    });

    // =========================================================================
    // STEP 2: OPTIMAL SWAP (50/50 VALUE RATIO ALIGNMENT)
    // =========================================================================
    console.log('[Rebalance Service] Preparing Step 2: Calculating optimal swap to balance assets 50/50...');

    const [sqrtPriceX96, currentTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    let bal0 = await publicClient.readContract({
        address: token0,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [options.account as `0x${string}`],
    });

    let bal1 = await publicClient.readContract({
        address: token1,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [options.account as `0x${string}`],
    });

    // Factor in the tokens that WILL be collected from Step 1 withdrawal
    const q96 = 2n ** 96n;
    const sqrtRatioAX96 = BigInt(Math.floor(Math.pow(1.0001, tickLower / 2) * Number(q96)));
    const sqrtRatioBX96 = BigInt(Math.floor(Math.pow(1.0001, tickUpper / 2) * Number(q96)));

    let expectedCollected0 = tokensOwed0 || 0n;
    let expectedCollected1 = tokensOwed1 || 0n;

    if (liquidity > 0n) {
        if (sqrtPriceX96 <= sqrtRatioAX96) {
            expectedCollected0 += (liquidity * q96 * (sqrtRatioBX96 - sqrtRatioAX96)) / (sqrtRatioAX96 * sqrtRatioBX96);
        } else if (sqrtPriceX96 >= sqrtRatioBX96) {
            expectedCollected1 += (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / q96;
        } else {
            expectedCollected0 += (liquidity * q96 * (sqrtRatioBX96 - sqrtPriceX96)) / (sqrtPriceX96 * sqrtRatioBX96);
            expectedCollected1 += (liquidity * (sqrtPriceX96 - sqrtRatioAX96)) / q96;
        }
    }

    bal0 += expectedCollected0;
    bal1 += expectedCollected1;

    const sqrtPriceNum = Number(sqrtPriceX96) / 2 ** 96;
    const priceToken0InToken1 = sqrtPriceNum * sqrtPriceNum * 1e12; // WETH in USDC

    const val0InUsdc = (Number(bal0) / 1e18) * priceToken0InToken1;
    const val1InUsdc = Number(bal1) / 1e6;
    const totalValUsdc = val0InUsdc + val1InUsdc;
    const targetValUsdc = totalValUsdc / 2;

    let swapDetails: { tokenIn: string; tokenOut: string; amountIn: string } | undefined;
    const imbalanceThreshold = totalValUsdc * 0.02; // 2% tolerance

    if (val0InUsdc > targetValUsdc + imbalanceThreshold) {
        const excessValUsdc = val0InUsdc - targetValUsdc;
        let excessWethWei = parseEther((excessValUsdc / priceToken0InToken1).toFixed(18));
        if (excessWethWei > bal0) excessWethWei = bal0;

        if (excessWethWei > 0n) {
            console.log(`[Rebalance Service] Preparing Swap ${formatEther(excessWethWei)} WETH -> USDC for 50/50 balance...`);

            const uniQuote = await getUniswapQuote({
                tokenIn: token0,
                tokenOut: token1,
                amountIn: excessWethWei.toString(),
                recipient: options.account,
                slippageTolerancePercent: 0.5,
            });

            const amountOutMin = uniQuote.amountOutMin ? BigInt(uniQuote.amountOutMin) : 0n;

            const approveSwapData = encodeFunctionData({
                abi: Constants.ERC20_ABI,
                functionName: 'approve',
                args: [Constants.SWAP_ROUTER, maxUint256],
            });

            preparedTransactions.push({
                id: 'approve_swap',
                description: `Approve ${formatEther(excessWethWei)} WETH for SwapRouter`,
                to: token0,
                data: approveSwapData,
            });

            let swapData: `0x${string}`;
            let swapTo: `0x${string}` = Constants.SWAP_ROUTER;

            if (uniQuote.methodParameters) {
                swapData = uniQuote.methodParameters.calldata as `0x${string}`;
                swapTo = uniQuote.methodParameters.to as `0x${string}`;
            } else {
                swapData = encodeFunctionData({
                    abi: Constants.ROUTER_ABI,
                    functionName: 'exactInputSingle',
                    args: [
                        {
                            tokenIn: token0,
                            tokenOut: token1,
                            fee,
                            recipient: options.account as `0x${string}`,
                            deadline,
                            amountIn: excessWethWei,
                            amountOutMinimum: amountOutMin,
                            sqrtPriceLimitX96: 0n,
                        },
                    ],
                });
            }

            preparedTransactions.push({
                id: 'swap',
                description: `Swap ${formatEther(excessWethWei)} WETH -> USDC via ${uniQuote.source === 'UNISWAP_API' ? 'Uniswap Routing API' : 'SwapRouter'}`,
                to: swapTo,
                data: swapData,
            });

            swapDetails = {
                tokenIn: token0,
                tokenOut: token1,
                amountIn: excessWethWei.toString(),
            };
        }
    } else if (val1InUsdc > targetValUsdc + imbalanceThreshold) {
        const excessValUsdc = val1InUsdc - targetValUsdc;
        let excessUsdcUnits = BigInt(Math.floor(excessValUsdc * 1e6));
        if (excessUsdcUnits > bal1) excessUsdcUnits = bal1;

        if (excessUsdcUnits > 0n) {
            console.log(`[Rebalance Service] Preparing Swap ${excessUsdcUnits.toString()} USDC -> WETH for 50/50 balance...`);

            const uniQuote = await getUniswapQuote({
                tokenIn: token1,
                tokenOut: token0,
                amountIn: excessUsdcUnits.toString(),
                recipient: options.account,
                slippageTolerancePercent: 0.5,
            });

            const amountOutMin = uniQuote.amountOutMin ? BigInt(uniQuote.amountOutMin) : 0n;

            const approveSwapData = encodeFunctionData({
                abi: Constants.ERC20_ABI,
                functionName: 'approve',
                args: [Constants.SWAP_ROUTER, maxUint256],
            });

            preparedTransactions.push({
                id: 'approve_swap',
                description: `Approve ${excessUsdcUnits.toString()} USDC for SwapRouter`,
                to: token1,
                data: approveSwapData,
            });

            let swapData: `0x${string}`;
            let swapTo: `0x${string}` = Constants.SWAP_ROUTER;

            if (uniQuote.methodParameters) {
                swapData = uniQuote.methodParameters.calldata as `0x${string}`;
                swapTo = uniQuote.methodParameters.to as `0x${string}`;
            } else {
                swapData = encodeFunctionData({
                    abi: Constants.ROUTER_ABI,
                    functionName: 'exactInputSingle',
                    args: [
                        {
                            tokenIn: token1,
                            tokenOut: token0,
                            fee,
                            recipient: options.account as `0x${string}`,
                            deadline,
                            amountIn: excessUsdcUnits,
                            amountOutMinimum: amountOutMin,
                            sqrtPriceLimitX96: 0n,
                        },
                    ],
                });
            }

            preparedTransactions.push({
                id: 'swap',
                description: `Swap ${excessUsdcUnits.toString()} USDC -> WETH via ${uniQuote.source === 'UNISWAP_API' ? 'Uniswap Routing API' : 'SwapRouter'}`,
                to: swapTo,
                data: swapData,
            });

            swapDetails = {
                tokenIn: token1,
                tokenOut: token0,
                amountIn: excessUsdcUnits.toString(),
            };
        }
    } else {
        console.log('[Rebalance Service] Balances are already optimal (50/50 ratio). No swap needed.');
    }

    // =========================================================================
    // STEP 3: RE-MINT NEW CENTERED POSITION
    // =========================================================================
    console.log('[Rebalance Service] Preparing Step 3: Mint new centered position...');

    const tickSpacing = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'tickSpacing',
    });

    const tickSpacingNum = Number(tickSpacing);
    const currentTickAligned = Math.floor(currentTick / tickSpacingNum) * tickSpacingNum;
    const rangeWidth = options.rangeWidth || 200;
    const newTickLower = currentTickAligned - rangeWidth;
    const newTickUpper = currentTickAligned + rangeWidth;

    console.log(`[Rebalance Service] Current Pool Tick: ${currentTick} (Aligned: ${currentTickAligned}), Tick Spacing: ${tickSpacingNum}`);
    console.log(`[Rebalance Service] Target Position Range: [${newTickLower}, ${newTickUpper}] (Width: ${newTickUpper - newTickLower} ticks / ±${rangeWidth} ticks)`);

    const approveMintToken0Data = encodeFunctionData({
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    preparedTransactions.push({
        id: 'approve_mint_token0',
        description: `Approve token0 for PositionManager`,
        to: token0,
        data: approveMintToken0Data,
    });

    const approveMintToken1Data = encodeFunctionData({
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    preparedTransactions.push({
        id: 'approve_mint_token1',
        description: `Approve token1 for PositionManager`,
        to: token1,
        data: approveMintToken1Data,
    });

    const { amount0Desired: opt0, amount1Desired: opt1 } = calculateOptimalMintAmounts(
        sqrtPriceX96,
        newTickLower,
        newTickUpper,
        bal0,
        bal1
    );

    const { amount0Min, amount1Min } = calculateSlippageBounds(opt0, opt1, 0.5);

    const mintData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'mint',
        args: [
            {
                token0,
                token1,
                fee,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: opt0,
                amount1Desired: opt1,
                amount0Min,
                amount1Min,
                recipient: options.account as `0x${string}`,
                deadline,
            },
        ],
    });

    preparedTransactions.push({
        id: 'mint_position',
        description: `Mint new centered position [${newTickLower}, ${newTickUpper}]`,
        to: Constants.POSITION_MANAGER,
        data: mintData,
    });

    console.log(`[Rebalance Service] Successfully created non-custodial rebalance plan with ${preparedTransactions.length} transactions!`);

    return {
        success: true,
        account: options.account,
        oldTokenId: targetTokenId.toString(),
        oldPosition: {
            tickLower,
            tickUpper,
            liquidity: liquidity.toString(),
        },
        newPosition: {
            tickLower: newTickLower,
            tickUpper: newTickUpper,
            currentTick,
        },
        preparedTransactions,
        swapDetails,
    };
}
