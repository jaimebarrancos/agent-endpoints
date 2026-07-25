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

async function runAutonomousAgent() {
    console.log(`=============================================================`);
    console.log(` Starting Autonomous AI Agent (Payer: ${walletB.address})`);
    console.log(` Target Account: ${targetAccount}`);
    console.log(`=============================================================`);

    const initialBalances = await fetchClientBalances(walletB.address);
    console.log(`\n[Agent] Initial Wallet Balances:`);
    console.log(`  ETH:  ${formatEther(initialBalances.ethBal)} ETH`);
    console.log(`  USDC: $${(Number(initialBalances.usdcBal) / 1e6).toFixed(6)} USDC`);

    // Step 1: Check position health
    console.log('\n[Agent] Step 1: Requesting /check-health with x402 payment...');
    let isHealthy = true;
    try {
        const healthResponse = await fetchWithPayment('http://localhost:3000/check-health', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                account: targetAccount,
                network: 'base-mainnet',
                tickBuffer: 10,
                timeBuffer: 300,
            }),
        });

        const healthData = await healthResponse.json();
        console.log('[Agent] Health Check Response:');
        console.log(JSON.stringify(healthData, null, 2));

        if (typeof healthData?.isHealthy === 'boolean') {
            isHealthy = healthData.isHealthy;
        }
    } catch (err: any) {
        console.error('[Agent] Error during /check-health call:', err?.message || err);
    }

    // Step 2: Trigger /rebalance if position is unhealthy
    if (!isHealthy) {
        console.log('\n[Agent] Position is out of range / unhealthy! Triggering /rebalance with x402 payment...');
        try {
            const rebalanceResponse = await fetchWithPayment('http://localhost:3000/rebalance', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    account: targetAccount,
                    network: 'base-mainnet',
                }),
            });

            const rebalanceData = await rebalanceResponse.json();
            console.log('[Agent] Rebalance Response:');
            console.log(JSON.stringify(rebalanceData, null, 2));

            if (Array.isArray(rebalanceData?.preparedTransactions) && rebalanceData.preparedTransactions.length > 0) {
                console.log(`\n[Agent] Executing ${rebalanceData.preparedTransactions.length} prepared rebalance transactions non-custodially...`);
                for (let i = 0; i < rebalanceData.preparedTransactions.length; i++) {
                    const tx = rebalanceData.preparedTransactions[i];
                    console.log(`[Agent] Step ${i + 1}/${rebalanceData.preparedTransactions.length}: ${tx.description}`);
                    const hash = await walletClient.sendTransaction({
                        to: tx.to,
                        data: tx.data,
                        value: tx.value ? BigInt(tx.value) : 0n,
                    });
                    console.log(`  Tx Sent: ${hash}. Waiting for confirmation...`);
                    await publicClient.waitForTransactionReceipt({ hash });
                }
                console.log('[Agent] All rebalance transactions executed successfully!');
            }
        } catch (err: any) {
            console.error('[Agent] Error during /rebalance call:', err?.message || err);
        }
    } else {
        console.log('\n[Agent] Position is healthy! No rebalance required at this time.');
    }

    // Short delay to allow RPC node to index the newly mined settlement block
    await new Promise((r) => setTimeout(r, 2500));

    const finalBalances = await fetchClientBalances(walletB.address);
    const usdcDiff = Number(initialBalances.usdcBal) - Number(finalBalances.usdcBal);

    console.log(`\n=============================================================`);
    console.log(` [Agent] Final Balances Post-Execution:`);
    console.log(`  ETH:       ${formatEther(finalBalances.ethBal)} ETH`);
    console.log(`  USDC:      $${(Number(finalBalances.usdcBal) / 1e6).toFixed(6)} USDC`);
    console.log(`  x402 Spent: $${(usdcDiff / 1e6).toFixed(6)} USDC (${usdcDiff.toString()} units)`);
    console.log(`=============================================================`);
    console.log(` Autonomous AI Agent Execution Completed`);
    console.log(`=============================================================\n`);
}

runAutonomousAgent();
