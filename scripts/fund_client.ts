import 'dotenv/config';
import { createPublicClient, createWalletClient, http, parseEther, formatEther, maxUint256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import * as Constants from '../constants.ts';

///////////////////////////////
// SENDS ETH AND USDC
///////////////////////////////

// Payer Client account
const walletBPrivateKey = process.env.CLIENT_PAYMENTS_PRIVATE_KEY as `0x${string}`;
if (!walletBPrivateKey) {
    throw new Error('CLIENT_PAYMENTS_PRIVATE_KEY is missing in process.env');
}
const account = privateKeyToAccount(walletBPrivateKey);

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';

const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
});

async function fundClientWalletB() {
    console.log(`=============================================================`);
    console.log(` Funding Agent Client Wallet B (${account.address})`);
    console.log(`=============================================================`);

    // Fetch initial balances
    const ethBalanceBefore = await publicClient.getBalance({ address: account.address });
    const wethBalanceBefore = await publicClient.readContract({
        address: Constants.WETH_ADDRESS_MAINNET,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });
    const usdcBalanceBefore = await publicClient.readContract({
        address: Constants.USDC_ADDRESS_MAINNET,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });

    // Ensure Wallet B is an EOA (clear any mainnet proxy bytecode at this address on Anvil)
    try {
        await publicClient.request({
            method: 'anvil_setCode' as any,
            params: [account.address, '0x'],
        });
    } catch (_) { }

    // Seed Wallet B with 10 ETH on Anvil if needed
    if (ethBalanceBefore < parseEther('1')) {
        try {
            await publicClient.request({
                method: 'anvil_setBalance' as any,
                params: [account.address, '0x8ac7230489e80000'], // 10 ETH
            });
        } catch (_) { }
    }
    try {
        // Slot 9 is USDC balance mapping. keccak256(abi.encode(account, 9))
        const balanceSlot = '0x4e610f29667d7f0b671b2a1db8bee3694514af781177cb43e097b798ef9df896';
        await publicClient.request({
            method: 'anvil_setStorageAt' as any,
            params: [
                Constants.USDC_ADDRESS_MAINNET,
                balanceSlot,
                '0x000000000000000000000000000000000000000000000000000000003b9aca00', // 1,000 USDC ($1000)
            ],
        });
        console.log('   Direct USDC balance seed complete!');
    } catch (err: any) {
        console.error('   Direct USDC seeding failed:', err?.message || err);
    }

    // Fetch updated balances
    const ethBalanceAfter = await publicClient.getBalance({ address: account.address });
    const wethBalanceAfter = await publicClient.readContract({
        address: Constants.WETH_ADDRESS_MAINNET,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });
    const usdcBalanceAfter = await publicClient.readContract({
        address: Constants.USDC_ADDRESS_MAINNET,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [account.address],
    });

    console.log(`\n=============================================================`);
    console.log(` Updated Balances for Wallet B (${account.address})`);
    console.log(`=============================================================`);
    console.log(`  ETH:  ${formatEther(ethBalanceAfter)} ETH`);
    console.log(`  WETH: ${formatEther(wethBalanceAfter)} WETH`);
    console.log(`  USDC: $${(Number(usdcBalanceAfter) / 1e6).toFixed(2)} USDC (${usdcBalanceAfter.toString()} units)`);
    console.log(`=============================================================\n`);
}

fundClientWalletB().catch((error) => {
    console.error('Error funding Wallet B:', error);
    process.exit(1);
});
