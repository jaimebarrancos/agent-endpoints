import 'dotenv/config';
import { wrapFetchWithPaymentFromConfig } from '@x402/fetch';
import { ExactEvmScheme } from '@x402/evm';
import { createPublicClient, createWalletClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import * as Constants from '../constants.ts';

const clientPaymentsKey = process.env.CLIENT_PAYMENTS_PRIVATE_KEY as `0x${string}`;
if (!clientPaymentsKey) {
    throw new Error('CLIENT_PAYMENTS_PRIVATE_KEY is missing in process.env');
}
const walletB = privateKeyToAccount(clientPaymentsKey);

const clientPrivateKey = process.env.CLIENT_PRIVATE_KEY as `0x${string}`;
if (!clientPrivateKey) {
    throw new Error('CLIENT_PRIVATE_KEY is missing in process.env');
}
const clientAccount = privateKeyToAccount(clientPrivateKey);

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
});

const walletClient = createWalletClient({
    account: clientAccount,
    chain: base,
    transport: http(rpcUrl),
});

async function fetchClientBalances(address: `0x${string}`) {
    const ethBal = await publicClient.getBalance({ address });
    const usdcBal = await publicClient.readContract({
        address: Constants.USDC_ADDRESS_MAINNET,
        abi: Constants.ERC20_ABI,
        functionName: 'balanceOf',
        args: [address],
    });
    return { ethBal, usdcBal };
}

const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
    schemes: [
        {
            network: 'eip155:8453',
            client: new ExactEvmScheme(walletB),
        },
    ],
});

const targetAccount = (process.env.CLIENT_ADDRESS || process.env.TARGET_ACCOUNT || clientAccount.address) as string;

async function runRebalanceClient() {
    console.log(`=============================================================`);
    console.log(` Executing /rebalance Client (Payer: ${walletB.address})`);
    console.log(` Target Client Wallet: ${clientAccount.address}`);
    console.log(`=============================================================`);

    const initialBalances = await fetchClientBalances(walletB.address);
    console.log(`\n[Client] Initial Payments Wallet Balances:`);
    console.log(`  ETH:  ${formatEther(initialBalances.ethBal)} ETH`);
    console.log(`  USDC: $${(Number(initialBalances.usdcBal) / 1e6).toFixed(6)} USDC`);

    console.log('\n[Client] Requesting non-custodial rebalance plan from /rebalance with x402 payment...');
    try {
        const response = await fetchWithPayment('http://localhost:3000/rebalance', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                account: targetAccount,
                network: 'base-mainnet',
            }),
        });

        const data = await response.json();
        console.log('\n[Client] Received Non-Custodial Rebalance Plan:');
        console.log(JSON.stringify(data, null, 2));

        if (Array.isArray(data?.preparedTransactions) && data.preparedTransactions.length > 0) {
            console.log(`\n=============================================================`);
            console.log(` [Client] Executing ${data.preparedTransactions.length} Non-Custodial Transactions`);
            console.log(`=============================================================`);

            for (let i = 0; i < data.preparedTransactions.length; i++) {
                const tx = data.preparedTransactions[i];
                console.log(`\n[Client] Step ${i + 1}/${data.preparedTransactions.length}: ${tx.description} (${tx.id})`);
                console.log(`  Target: ${tx.to}`);
                
                const hash = await walletClient.sendTransaction({
                    to: tx.to,
                    data: tx.data,
                    value: tx.value ? BigInt(tx.value) : 0n,
                });

                console.log(`  Tx Sent: ${hash}`);
                console.log(`  Waiting for on-chain confirmation...`);
                await publicClient.waitForTransactionReceipt({ hash });
                console.log(`  Confirmed!`);
            }

            console.log(`\n=============================================================`);
            console.log(` [Client] All Rebalance Transactions Successfully Executed!`);
            console.log(`=============================================================`);
        }
    } catch (err: any) {
        console.error('[Client] Error during /rebalance call:', err?.message || err);
    }

    const finalBalances = await fetchClientBalances(walletB.address);
    const usdcDiff = Number(initialBalances.usdcBal) - Number(finalBalances.usdcBal);

    console.log(`\n=============================================================`);
    console.log(` [Client] Final Balances:`);
    console.log(`  ETH:       ${formatEther(finalBalances.ethBal)} ETH`);
    console.log(`  USDC:      $${(Number(finalBalances.usdcBal) / 1e6).toFixed(6)} USDC`);
    console.log(`  x402 Spent: $${(usdcDiff / 1e6).toFixed(6)} USDC (${usdcDiff.toString()} units)`);
    console.log(`=============================================================\n`);
}

runRebalanceClient();
