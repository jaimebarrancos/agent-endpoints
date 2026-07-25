import * as Constants from '../constants.ts';
import { privateKeyToAccount } from 'viem/accounts';
import { createPublicClient, createWalletClient, http, parseEther, formatEther } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import 'dotenv/config';

async function makePositionOutOfRange() {
    const privateKey = (process.env.CLIENT_PRIVATE_KEY || process.env.PRIVATE_KEY) as `0x${string}`;
    if (!privateKey) {
        throw new Error('CLIENT_PRIVATE_KEY environment variable is missing.');
    }

    const account = privateKeyToAccount(privateKey);
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
    const chain = Constants.IS_TESTNET ? baseSepolia : base;

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

    const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
    });

    console.log(`Executing out_of_range script for account: ${account.address}`);
    console.log(`Connected to RPC: ${rpcUrl} (Network: ${Constants.IS_TESTNET ? 'Base Sepolia' : 'Base Mainnet / Anvil Fork'})`);

    // 1. Fetch current pool tick & slot0
    const [sqrtPriceBefore, tickBefore] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    console.log(`\n--- POOL STATE BEFORE SWAP ---`);
    console.log(`Current Tick: ${tickBefore}`);
    console.log(`SqrtPriceX96: ${sqrtPriceBefore.toString()}`);

    // 2. Determine swap size based on available balance or SWAP_ETH_AMOUNT env var
    const ethBalance = await publicClient.getBalance({ address: account.address });
    console.log(`ETH Balance: ${formatEther(ethBalance)} ETH`);

    let swapAmountWei: bigint;
    if (process.env.SWAP_ETH_AMOUNT) {
        swapAmountWei = parseEther(process.env.SWAP_ETH_AMOUNT);
    } else if (ethBalance > parseEther('10')) {
        // High balance (e.g. Anvil local fork with 10,000 ETH)
        swapAmountWei = parseEther('200');
    } else {
        // Lower balance (e.g. Testnet)
        swapAmountWei = (ethBalance * 7n) / 10n; // Use 70% of ETH balance
    }

    if (swapAmountWei <= 0n) {
        throw new Error('Insufficient ETH balance to perform swap.');
    }

    console.log(`\n--- EXECUTING MEDIUM/LARGE SWAP ---`);
    console.log(`1. Wrapping ${formatEther(swapAmountWei)} ETH into WETH...`);

    const depositTx = await walletClient.writeContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.WETH_ABI,
        functionName: 'deposit',
        value: swapAmountWei,
    });
    await publicClient.waitForTransactionReceipt({ hash: depositTx });

    console.log('2. Approving SwapRouter for WETH...');
    const approveTx = await walletClient.writeContract({
        address: Constants.WETH_ADDRESS,
        abi: Constants.WETH_ABI,
        functionName: 'approve',
        args: [Constants.SWAP_ROUTER, swapAmountWei],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveTx });

    console.log(`3. Swapping ${formatEther(swapAmountWei)} WETH for USDC via SwapRouter...`);
    const swapTx = await walletClient.writeContract({
        address: Constants.SWAP_ROUTER,
        abi: Constants.ROUTER_ABI,
        functionName: 'exactInputSingle',
        args: [
            {
                tokenIn: Constants.WETH_ADDRESS,
                tokenOut: Constants.USDC_ADDRESS,
                fee: 500, // 0.05% pool
                recipient: account.address,
                amountIn: swapAmountWei,
                amountOutMinimum: 0n,
                sqrtPriceLimitX96: 0n,
            },
        ],
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: swapTx });
    console.log(`Swap transaction confirmed! Hash: ${receipt.transactionHash}`);

    // 3. Fetch pool state after swap
    const [sqrtPriceAfter, tickAfter] = await publicClient.readContract({
        address: Constants.USDC_WETH_POOL_500,
        abi: Constants.POOL_ABI,
        functionName: 'slot0',
    });

    const tickDelta = tickAfter - tickBefore;
    console.log(`\n--- POOL STATE AFTER SWAP ---`);
    console.log(`New Tick: ${tickAfter}`);
    console.log(`SqrtPriceX96: ${sqrtPriceAfter.toString()}`);
    console.log(`Tick Shift: ${tickDelta > 0 ? '+' : ''}${tickDelta} ticks`);

    console.log(`\nPosition status update: Pool tick moved from ${tickBefore} to ${tickAfter} (${Math.abs(tickDelta)} ticks).`);
}

makePositionOutOfRange()
    .then(() => {
        console.log('Done!');
    })
    .catch((error) => {
        console.error('Error executing out_of_range script:', error);
        process.exit(1);
    });
