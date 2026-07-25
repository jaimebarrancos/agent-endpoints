import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, maxUint256, parseAbi, parseAbiItem, parseEventLogs } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base, baseSepolia } from 'viem/chains';
import * as Constants from '../constants.ts';
import { checkUniswapPositionsHealth } from './fetcher.ts';

export interface RebalanceOptions {
    account: string;
    tokenId?: string | number;
    network?: string;
    rangeWidth?: number;
}

export interface RebalanceResult {
    success: boolean;
    account: string;
    oldTokenId: string;
    newTokenId?: string;
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
    transactions: {
        decreaseLiquidityTx: string;
        collectTx: string;
        swapTx?: string | null;
        mintTx: string;
    };
    swapDetails?: {
        tokenIn: string;
        tokenOut: string;
        amountIn: string;
    };
}

export async function rebalancePosition(options: RebalanceOptions): Promise<RebalanceResult> {
    const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
    if (!privateKey) {
        throw new Error('PRIVATE_KEY environment variable is missing in process.env');
    }

    const walletAccount = privateKeyToAccount(privateKey);
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const isTestnet = options.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    const chain = isTestnet ? baseSepolia : base;

    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account: walletAccount, chain, transport: http(rpcUrl) });

    console.log(`[Rebalance] Starting rebalance process for account: ${options.account}`);
    console.log(`[Rebalance] Connected to RPC: ${rpcUrl} (Network: ${isTestnet ? 'Base Sepolia' : 'Base Mainnet / Anvil Fork'})`);

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
            const targetPos = activePositions.find((p) => p.status === 'OUT_OF_RANGE') || activePositions[0];
            if (targetPos && targetPos.id) {
                targetTokenId = BigInt(targetPos.id);
            }
        } catch (e) {
            console.warn('[Rebalance] Position lookup failed, falling back to on-chain query...');
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
                console.warn('[Rebalance] On-chain fallback query failed:', err);
            }
        }
    }

    if (targetTokenId === undefined) {
        throw new Error(`No active Uniswap position found for account ${options.account}`);
    }

    console.log(`[Rebalance] Target Position NFT Token ID: ${targetTokenId.toString()}`);

    const posData = await publicClient.readContract({
        address: Constants.POSITION_MANAGER,
        abi: Constants.NPM_ABI,
        functionName: 'positions',
        args: [targetTokenId],
    });

    const [, , token0, token1, fee, tickLower, tickUpper, liquidity] = posData;

    if (liquidity === 0n) {
        throw new Error(`Position NFT #${targetTokenId} has zero liquidity.`);
    }

    // =========================================================================
    // STEP 1: WITHDRAW (DECREASE LIQUIDITY + COLLECT)
    // =========================================================================
    console.log(`[Rebalance] Step 1: Withdrawing 100% liquidity (${liquidity.toString()}) from position #${targetTokenId}...`);

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const decreaseTxHash = await walletClient.writeContract({
        address: Constants.POSITION_MANAGER,
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
    await publicClient.waitForTransactionReceipt({ hash: decreaseTxHash });
    console.log(`[Rebalance] Liquidity decreased. Tx: ${decreaseTxHash}`);

    const maxUint128 = 340282366920938463463374607431768211455n;

    const collectTxHash = await walletClient.writeContract({
        address: Constants.POSITION_MANAGER,
        abi: Constants.NPM_ABI,
        functionName: 'collect',
        args: [
            {
                tokenId: targetTokenId,
                recipient: walletAccount.address,
                amount0Max: maxUint128,
                amount1Max: maxUint128,
            },
        ],
    });
    await publicClient.waitForTransactionReceipt({ hash: collectTxHash });
    console.log(`[Rebalance] Tokens collected into wallet. Tx: ${collectTxHash}`);

    // =========================================================================
    // STEP 2: OPTIMAL SWAP (50/50 VALUE RATIO ALIGNMENT)
    // =========================================================================
    console.log('[Rebalance] Step 2: Calculating optimal swap to balance assets 50/50...');

    const [sqrtPriceX96, currentTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    let bal0 = await publicClient.readContract({
        address: token0,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAccount.address],
    });

    let bal1 = await publicClient.readContract({
        address: token1,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAccount.address],
    });

    const sqrtPriceNum = Number(sqrtPriceX96) / 2 ** 96;
    const priceToken0InToken1 = sqrtPriceNum * sqrtPriceNum * 1e12; // WETH in USDC

    const val0InUsdc = (Number(bal0) / 1e18) * priceToken0InToken1;
    const val1InUsdc = Number(bal1) / 1e6;
    const totalValUsdc = val0InUsdc + val1InUsdc;
    const targetValUsdc = totalValUsdc / 2;

    let swapTxHash: `0x${string}` | null = null;
    let swapDetails: { tokenIn: string; tokenOut: string; amountIn: string } | undefined;

    const imbalanceThreshold = totalValUsdc * 0.02; // 2% tolerance

    if (val0InUsdc > targetValUsdc + imbalanceThreshold) {
        const excessValUsdc = val0InUsdc - targetValUsdc;
        let excessWethWei = parseEther((excessValUsdc / priceToken0InToken1).toFixed(18));
        if (excessWethWei > bal0) excessWethWei = bal0;

        if (excessWethWei > 0n) {
            console.log(`[Rebalance] Swapping ${formatEther(excessWethWei)} WETH -> USDC for 50/50 balance...`);

            await walletClient.writeContract({
                address: token0,
                abi: Constants.ERC20_ABI,
                functionName: 'approve',
                args: [Constants.SWAP_ROUTER, excessWethWei],
            });

            swapTxHash = await walletClient.writeContract({
                address: Constants.SWAP_ROUTER,
                abi: Constants.ROUTER_ABI,
                functionName: 'exactInputSingle',
                args: [
                    {
                        tokenIn: token0,
                        tokenOut: token1,
                        fee,
                        recipient: walletAccount.address,
                        amountIn: excessWethWei,
                        amountOutMinimum: 0n,
                        sqrtPriceLimitX96: 0n,
                    },
                ],
            });
            await publicClient.waitForTransactionReceipt({ hash: swapTxHash });

            swapDetails = {
                tokenIn: token0,
                tokenOut: token1,
                amountIn: excessWethWei.toString(),
            };
            console.log(`[Rebalance] Swap completed. Tx: ${swapTxHash}`);
        }
    } else if (val1InUsdc > targetValUsdc + imbalanceThreshold) {
        const excessValUsdc = val1InUsdc - targetValUsdc;
        let excessUsdcUnits = BigInt(Math.floor(excessValUsdc * 1e6));
        if (excessUsdcUnits > bal1) excessUsdcUnits = bal1;

        if (excessUsdcUnits > 0n) {
            console.log(`[Rebalance] Swapping ${excessUsdcUnits.toString()} USDC -> WETH for 50/50 balance...`);

            await walletClient.writeContract({
                address: token1,
                abi: Constants.ERC20_ABI,
                functionName: 'approve',
                args: [Constants.SWAP_ROUTER, excessUsdcUnits],
            });

            swapTxHash = await walletClient.writeContract({
                address: Constants.SWAP_ROUTER,
                abi: Constants.ROUTER_ABI,
                functionName: 'exactInputSingle',
                args: [
                    {
                        tokenIn: token1,
                        tokenOut: token0,
                        fee,
                        recipient: walletAccount.address,
                        amountIn: excessUsdcUnits,
                        amountOutMinimum: 0n,
                        sqrtPriceLimitX96: 0n,
                    },
                ],
            });
            await publicClient.waitForTransactionReceipt({ hash: swapTxHash });

            swapDetails = {
                tokenIn: token1,
                tokenOut: token0,
                amountIn: excessUsdcUnits.toString(),
            };
            console.log(`[Rebalance] Swap completed. Tx: ${swapTxHash}`);
        }
    } else {
        console.log('[Rebalance] Balances are already optimal (50/50 ratio). No swap needed.');
    }

    // =========================================================================
    // STEP 3: RE-MINT NEW CENTERED POSITION & LOG TICK COMPARISON
    // =========================================================================
    console.log('[Rebalance] Step 3: Minting new centered position...');

    // Fetch latest pool tick post-swap
    const [, latestCurrentTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    const tickSpacing = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'tickSpacing',
    });

    const currentTickAligned = Math.floor(latestCurrentTick / Number(tickSpacing)) * Number(tickSpacing);
    const rangeWidth = options.rangeWidth || 200;
    const newTickLower = currentTickAligned - rangeWidth;
    const newTickUpper = currentTickAligned + rangeWidth;

    bal0 = await publicClient.readContract({
        address: token0,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAccount.address],
    });

    bal1 = await publicClient.readContract({
        address: token1,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [walletAccount.address],
    });

    await walletClient.writeContract({
        address: token0,
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    await walletClient.writeContract({
        address: token1,
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    const mintTxHash = await walletClient.writeContract({
        address: Constants.POSITION_MANAGER,
        abi: Constants.NPM_ABI,
        functionName: 'mint',
        args: [
            {
                token0,
                token1,
                fee,
                tickLower: newTickLower,
                tickUpper: newTickUpper,
                amount0Desired: bal0,
                amount1Desired: bal1,
                amount0Min: 0n,
                amount1Min: 0n,
                recipient: walletAccount.address,
                deadline: BigInt(Math.floor(Date.now() / 1000) + 600),
            },
        ],
    });

    const mintReceipt = await publicClient.waitForTransactionReceipt({ hash: mintTxHash });
    console.log(`[Rebalance] New position minted. Tx: ${mintTxHash}`);

    let newTokenId: string | undefined;
    try {
        const parsedLogs = parseEventLogs({
            abi: Constants.NPM_ABI,
            logs: mintReceipt.logs,
        });

        for (const log of parsedLogs) {
            if ('tokenId' in log.args && log.args.tokenId !== undefined) {
                newTokenId = log.args.tokenId.toString();
                break;
            }
        }
    } catch (err) {
        console.warn('[Rebalance] Error parsing mint receipt logs:', err);
    }

    // Console log tick comparison metrics
    const wasInRange = initialPoolTick >= tickLower && initialPoolTick <= tickUpper;
    const isNowInRange = latestCurrentTick >= newTickLower && latestCurrentTick <= newTickUpper;
    const oldCenterTick = Math.floor((tickLower + tickUpper) / 2);
    const newCenterTick = Math.floor((newTickLower + newTickUpper) / 2);
    const shiftFromOldCenter = latestCurrentTick - oldCenterTick;

    console.log(`\n=============================================================`);
    console.log(`                  TICK COMPARISON SUMMARY                    `);
    console.log(`=============================================================`);
    console.log(` Initial Pool Tick (Before): ${initialPoolTick}`);
    console.log(` Final Pool Tick (After):   ${latestCurrentTick}`);
    console.log(` Old Position Bounds:       [${tickLower}, ${tickUpper}] (Was In Range: ${wasInRange})`);
    console.log(` Old Center Tick:           ${oldCenterTick}`);
    console.log(` New Position Bounds:       [${newTickLower}, ${newTickUpper}] (Is In Range: ${isNowInRange})`);
    console.log(` New Center Tick:           ${newCenterTick}`);
    console.log(` Tick Shift From Old Center:${shiftFromOldCenter > 0 ? '+' : ''}${shiftFromOldCenter} ticks`);
    console.log(`=============================================================\n`);

    console.log(`[Rebalance] Successfully rebalanced position! New Token ID: ${newTokenId || 'unknown'}`);

    return {
        success: true,
        account: options.account,
        oldTokenId: targetTokenId.toString(),
        newTokenId,
        oldPosition: {
            tickLower,
            tickUpper,
            liquidity: liquidity.toString(),
        },
        newPosition: {
            tickLower: newTickLower,
            tickUpper: newTickUpper,
            currentTick: latestCurrentTick,
        },
        transactions: {
            decreaseLiquidityTx: decreaseTxHash,
            collectTx: collectTxHash,
            swapTx: swapTxHash,
            mintTx: mintTxHash,
        },
        swapDetails,
    };
}
