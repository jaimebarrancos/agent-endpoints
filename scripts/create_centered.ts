import * as Constants from '../constants.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseEther, maxUint256 } from 'viem';
import { base } from 'viem/chains';
import 'dotenv/config';


// ===========================================================================
// STEP 1: FUND WALLET WITH WETH & USDC
// ===========================================================================
async function createCenteredPositionOnAnvil() {
    const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

    const publicClient = createPublicClient({
        chain: base,
        transport: http('http://127.0.0.1:8545'),
    });

    const walletClient = createWalletClient({
        account,
        chain: base,
        transport: http('http://127.0.0.1:8545'),
    });


    console.log('1. Wrapping 2 ETH into WETH...');
    const depositTx = await walletClient.writeContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.WETH_ABI,
        functionName: 'deposit',
        value: parseEther('2'),
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });

    console.log('2. Swapping 1 WETH to USDC via SwapRouter to get liquid USDC...');
    await walletClient.writeContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.WETH_ABI,
        functionName: 'approve',
        args: [Constants.SWAP_ROUTER, parseEther('1')],
    });

    const swapTx = await walletClient.writeContract({
        address: Constants.SWAP_ROUTER,
        abi: Constants.ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
            {
                tokenIn: Constants.WETH_ADDRESS,
                tokenOut: Constants.USDC_ADDRESS,
                fee: 500, // 0.05% fee pool
                recipient: account.address,
                amountIn: parseEther('1'),
                amountOutMinimum: 0n,
                sqrtPriceLimitX96: 0n,
            },
        ],
    });
    await publicClient.waitForTransactionReceipt({ hash: swapTx });

    const wethBal = await publicClient.readContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });

    const usdcBal = await publicClient.readContract({
        address: Constants.USDC_ADDRESS,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });

    console.log(`Balances acquired: ${wethBal.toString()} wei WETH, ${usdcBal.toString()} units USDC`);

    // ===========================================================================
    // STEP 2: CALCULATE CENTERED TICKS
    // ===========================================================================

    console.log('3. Fetching pool current tick...');
    const [, currentTick] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    const tickSpacing = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'tickSpacing',
    });

    // Align tick to nearest valid tickSpacing step
    const currentTickAligned = Math.floor(currentTick / Number(tickSpacing)) * Number(tickSpacing);

    // Set a range width of ±200 ticks (~2% wide range)
    const rangeWidth = 200;
    const tickLower = currentTickAligned - rangeWidth;
    const tickUpper = currentTickAligned + rangeWidth;

    console.log(`Current Tick: ${currentTick} (Aligned: ${currentTickAligned})`);
    console.log(`Centered Tick Bounds: [${tickLower}, ${tickUpper}]`);

    // ===========================================================================
    // STEP 3: APPROVE & MINT POSITION
    // ===========================================================================
    console.log('4. Approving NonfungiblePositionManager...');
    await walletClient.writeContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    await walletClient.writeContract({
        address: Constants.USDC_ADDRESS,
        abi: Constants.ERC20_ABI,
        functionName: 'approve',
        args: [Constants.POSITION_MANAGER, maxUint256],
    });

    // On Base: WETH (0x4200...) < USDC (0x8335...) lexicographically.
    // Therefore, token0 = WETH, token1 = USDC
    const isWethToken0 = Constants.WETH_ADDRESS.toLowerCase() < Constants.USDC_ADDRESS.toLowerCase();
    const token0 = isWethToken0 ? Constants.WETH_ADDRESS : Constants.USDC_ADDRESS;
    const token1 = isWethToken0 ? Constants.USDC_ADDRESS : Constants.WETH_ADDRESS;
    const amount0Desired = isWethToken0 ? wethBal : usdcBal;
    const amount1Desired = isWethToken0 ? usdcBal : wethBal;

    console.log('5. Calling mint() on PositionManager...');
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);

    const mintTx = await walletClient.writeContract({
        address: Constants.POSITION_MANAGER,
        abi: Constants.NPM_ABI,
        functionName: 'mint',
        args: [
            {
                token0,
                token1,
                fee: 500,
                tickLower,
                tickUpper,
                amount0Desired,
                amount1Desired,
                amount0Min: 0n,
                amount1Min: 0n,
                recipient: account.address,
                deadline,
            },
        ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: mintTx });

    console.log('Successfully minted new position on Uniswap!');
    console.log(`Transaction Hash: ${receipt.transactionHash}`);
}


createCenteredPositionOnAnvil().then(() => {
    console.log('Done!');
}).catch((error) => {
    console.error(error);
    process.exit(1);
});