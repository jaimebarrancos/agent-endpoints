import 'dotenv/config';
import { createPublicClient, http, encodeFunctionData, parseEther, formatEther, maxUint256 } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import * as Constants from '../constants.ts';
import { calculateSlippageBounds } from './uniswap_api.ts';

export interface CreatePositionOptions {
    account: string;
    network?: string;
    rangeWidth?: number;
    amount0Desired?: string;
    amount1Desired?: string;
    tickLower?: number;
    tickUpper?: number;
}

export interface PreparedTransaction {
    id: string;
    description: string;
    to: `0x${string}`;
    data: `0x${string}`;
    value?: string;
}

export interface CreatePositionResult {
    success: boolean;
    account: string;
    position: {
        tickLower: number;
        tickUpper: number;
        currentTick: number;
    };
    preparedTransactions: PreparedTransaction[];
}

export async function createPosition(options: CreatePositionOptions): Promise<CreatePositionResult> {
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const isTestnet = options.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    const chain = isTestnet ? baseSepolia : base;

    const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });

    console.log(`[Create Position Service] Generating non-custodial position creation plan for account: ${options.account}`);

    // Read current tick & tick spacing
    const [sqrtPriceX96, currentTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    const tickSpacing = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'tickSpacing',
    });

    let tickLower: number;
    let tickUpper: number;

    if (options.tickLower !== undefined && options.tickUpper !== undefined) {
        tickLower = options.tickLower;
        tickUpper = options.tickUpper;
    } else {
        const currentTickAligned = Math.floor(currentTick / Number(tickSpacing)) * Number(tickSpacing);
        const rangeWidth = options.rangeWidth || 100;
        tickLower = currentTickAligned - rangeWidth;
        tickUpper = currentTickAligned + rangeWidth;
    }

    const isWethToken0 = Constants.WETH_ADDRESS.toLowerCase() < Constants.USDC_ADDRESS.toLowerCase();
    const token0 = isWethToken0 ? Constants.WETH_ADDRESS : Constants.USDC_ADDRESS;
    const token1 = isWethToken0 ? Constants.USDC_ADDRESS : Constants.WETH_ADDRESS;

    // Check account balances
    const ethBal = await publicClient.getBalance({ address: options.account as `0x${string}` });

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

    const preparedTransactions: PreparedTransaction[] = [];
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    let finalAmount0Desired: bigint;
    let finalAmount1Desired: bigint;

    if (options.amount0Desired && options.amount1Desired) {
        finalAmount0Desired = BigInt(options.amount0Desired);
        finalAmount1Desired = BigInt(options.amount1Desired);
    } else if (bal0 > 0n && bal1 > 0n) {
        finalAmount0Desired = bal0;
        finalAmount1Desired = bal1;
    } else {
        // If wallet doesn't have both WETH and USDC, prepare deposit + swap if ETH is available
        const wrapAmount = ethBal >= parseEther('2.1') ? parseEther('2.0') : ethBal > parseEther('0.2') ? ethBal - parseEther('0.1') : parseEther('1.0');

        console.log(`[Create Position Service] Client has insufficient WETH/USDC balances. Adding deposit & swap steps for ${formatEther(wrapAmount)} ETH...`);

        // Step 1: Deposit ETH -> WETH
        const depositData = encodeFunctionData({
            abi: Constants.WETH_ABI,
            functionName: 'deposit',
        });

        preparedTransactions.push({
            id: 'deposit_weth',
            description: `Deposit ${formatEther(wrapAmount)} ETH into WETH`,
            to: Constants.WETH_ADDRESS,
            data: depositData,
            value: wrapAmount.toString(),
        });

        // Step 2: Swap half WETH -> USDC
        const swapWethAmount = wrapAmount / 2n;

        const approveSwapData = encodeFunctionData({
            abi: Constants.ERC20_ABI,
            functionName: 'approve',
            args: [Constants.SWAP_ROUTER, swapWethAmount],
        });

        preparedTransactions.push({
            id: 'approve_swap',
            description: `Approve ${formatEther(swapWethAmount)} WETH for SwapRouter`,
            to: Constants.WETH_ADDRESS,
            data: approveSwapData,
        });

        const swapData = encodeFunctionData({
            abi: Constants.ROUTER_ABI,
            functionName: 'exactInputSingle',
            args: [
                {
                    tokenIn: Constants.WETH_ADDRESS,
                    tokenOut: Constants.USDC_ADDRESS,
                    fee: 500,
                    recipient: options.account as `0x${string}`,
                    amountIn: swapWethAmount,
                    amountOutMinimum: 0n,
                    sqrtPriceLimitX96: 0n,
                },
            ],
        });

        preparedTransactions.push({
            id: 'swap_weth_to_usdc',
            description: `Swap ${formatEther(swapWethAmount)} WETH to USDC via SwapRouter`,
            to: Constants.SWAP_ROUTER,
            data: swapData,
        });

        // Estimate USDC from price
        const sqrtPriceNum = Number(sqrtPriceX96) / 2 ** 96;
        const priceWethInUsdc = sqrtPriceNum * sqrtPriceNum * 1e12;
        const estUsdcUnits = BigInt(Math.floor((Number(swapWethAmount) / 1e18) * priceWethInUsdc * 0.98));

        finalAmount0Desired = isWethToken0 ? swapWethAmount : estUsdcUnits;
        finalAmount1Desired = isWethToken0 ? estUsdcUnits : swapWethAmount;
    }

    // Step 3: Approve PositionManager for token0 and token1
    const approveToken0Data = encodeFunctionData({
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    preparedTransactions.push({
        id: 'approve_token0',
        description: `Approve token0 (${token0}) for PositionManager`,
        to: token0,
        data: approveToken0Data,
    });

    const approveToken1Data = encodeFunctionData({
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    preparedTransactions.push({
        id: 'approve_token1',
        description: `Approve token1 (${token1}) for PositionManager`,
        to: token1,
        data: approveToken1Data,
    });

    // Step 4: Mint position
    const { amount0Min, amount1Min } = calculateSlippageBounds(finalAmount0Desired, finalAmount1Desired, 0.5);

    const mintData = encodeFunctionData({
        abi: Constants.NPM_ABI,
        functionName: 'mint',
        args: [
            {
                token0,
                token1,
                fee: 500,
                tickLower,
                tickUpper,
                amount0Desired: finalAmount0Desired,
                amount1Desired: finalAmount1Desired,
                amount0Min,
                amount1Min,
                recipient: options.account as `0x${string}`,
                deadline,
            },
        ],
    });

    preparedTransactions.push({
        id: 'mint_position',
        description: `Mint new centered position [${tickLower}, ${tickUpper}]`,
        to: Constants.POSITION_MANAGER,
        data: mintData,
    });

    return {
        success: true,
        account: options.account,
        position: {
            tickLower,
            tickUpper,
            currentTick,
        },
        preparedTransactions,
    };
}
