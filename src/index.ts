import 'dotenv/config';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createPublicClient, createWalletClient, http, formatEther, parseAbi, recoverTypedDataAddress, keccak256, encodeAbiParameters, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { decodePaymentSignatureHeader } from '@x402/core/http';
import * as Constants from '../constants.ts';
import { checkUniswapPositionsHealth, getCopyTradingIntelligence } from './subgraph.ts';
import { rebalancePosition } from './rebalance.ts';
import { createPosition } from './create_position.ts';
import { withdrawPosition } from './withdraw_position.ts';

const app: Express = express();
app.use(express.json());

// Server Payment Receiver Wallet
export const SERVER_PAYMENT_ADDRESS = process.env.SERVER_PAYMENTS_ADDRESS as `0x${string}`;
const serverPrivateKey = process.env.SERVER_PAYMENTS_PRIVATE_KEY as `0x${string}`;

if (!SERVER_PAYMENT_ADDRESS || !serverPrivateKey) {
    throw new Error('SERVER_PAYMENTS_ADDRESS or SERVER_PAYMENTS_PRIVATE_KEY is missing in process.env');
}

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const publicClient = createPublicClient({
    chain: base,
    transport: http(rpcUrl),
});

const serverAccount = privateKeyToAccount(serverPrivateKey);
const serverWalletClient = createWalletClient({
    account: serverAccount,
    chain: base,
    transport: http(rpcUrl),
});



/**
 * Helper to fetch and print the server payment wallet balance
 */
async function printServerPaymentWalletBalance(route: string) {
    try {
        const ethBal = await publicClient.getBalance({ address: SERVER_PAYMENT_ADDRESS });
        const usdcBal = await publicClient.readContract({
            address: Constants.USDC_ADDRESS_MAINNET,
            abi: Constants.ERC20_ABI,
            functionName: 'balanceOf',
            args: [SERVER_PAYMENT_ADDRESS],
        });

        console.log(`\n=============================================================`);
        console.log(` [x402 Server] Payment Header Verified for ${route}`);
        console.log(` Receiver Wallet: ${SERVER_PAYMENT_ADDRESS}`);
        console.log(` Current ETH Balance:  ${formatEther(ethBal)} ETH`);
        console.log(` Current USDC Balance: $${(Number(usdcBal) / 1e6).toFixed(6)} USDC (${usdcBal.toString()} units)`);
        console.log(`=============================================================\n`);
    } catch (err: any) {
        console.warn('[x402 Server] Failed to query server payment wallet balance:', err?.message || err);
    }
}

/**
 * x402 Payment Express Middleware
 */
const x402PaymentMiddleware = async (req: Request, res: Response, next: NextFunction) => {
    // Expose x402 headers for client access
    res.setHeader('Access-Control-Expose-Headers', 'PAYMENT-REQUIRED, PAYMENT-RESPONSE, X-PAYMENT-RESPONSE');

    const paymentHeader =
        (req.headers['payment-signature'] as string) ||
        (req.headers['x-payment'] as string) ||
        (req.headers['payment-authorization'] as string);

    if (!paymentHeader) {
        console.log(`[x402 Server] Request to ${req.path} lacks payment signature. Returning HTTP 402 Payment Required...`);
        console.log("USDC: " + Constants.USDC_ADDRESS_MAINNET);
        const paymentRequirements = {
            x402Version: 2,
            resource: {
                url: `${req.protocol}://${req.get('host') || 'localhost:3000'}${req.originalUrl}`,
                method: req.method,
            },
            accepts: [
                {
                    scheme: 'exact',
                    network: 'eip155:8453',
                    asset: Constants.USDC_ADDRESS_MAINNET,
                    amount: '1000', // 0.01 USDC (6 decimals)
                    payTo: SERVER_PAYMENT_ADDRESS,
                    maxTimeoutSeconds: 3600,
                    extra: {
                        name: 'USD Coin',
                        version: '2',
                    },
                },
            ],
        };

        const encodedHeader = Buffer.from(JSON.stringify(paymentRequirements)).toString('base64');
        res.setHeader('PAYMENT-REQUIRED', encodedHeader);
        res.status(402).json(paymentRequirements);
        return;
    }

    try {
        const paymentPayload = decodePaymentSignatureHeader(paymentHeader);
        const authorization = (paymentPayload?.payload as any)?.authorization;
        const signature = (paymentPayload?.payload as any)?.signature;

        if (authorization && signature) {
            console.log(`[x402 Server] Settling EIP-3009 authorization on-chain for ${authorization.from}...`);
            const EIP3009_ABI = parseAbi([
                'function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, bytes signature) external',
            ]);

            const txHash = await serverWalletClient.writeContract({
                address: Constants.USDC_ADDRESS_MAINNET,
                abi: EIP3009_ABI,
                functionName: 'transferWithAuthorization',
                args: [
                    authorization.from,
                    authorization.to,
                    BigInt(authorization.value),
                    BigInt(authorization.validAfter),
                    BigInt(authorization.validBefore),
                    authorization.nonce,
                    signature,
                ],
            });

            await publicClient.waitForTransactionReceipt({ hash: txHash });
            console.log(`[x402 Server] On-chain EIP-3009 payment settlement confirmed! Tx: ${txHash}`);
        } else {
            res.status(402).json({ error: 'Invalid payment signature header payload' });
            return;
        }
    } catch (err: any) {
        console.error('[x402 Server] Settlement error:', err?.message || err);
        res.status(402).json({
            error: 'Payment settlement failed',
            details: err?.shortMessage || err?.message || String(err),
        });
        return;
    }

    await printServerPaymentWalletBalance(req.path);

    // Set settlement response header
    const settlementResponse = Buffer.from(
        JSON.stringify({
            status: 'settled',
            timestamp: Math.floor(Date.now() / 1000),
            payTo: SERVER_PAYMENT_ADDRESS,
        })
    ).toString('base64');
    res.setHeader('PAYMENT-RESPONSE', settlementResponse);

    next();
};

const handleCheckHealth = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const network = ((req.query.network || req.body?.network) as string) || 'base-mainnet';

        const tickBuffer =
            req.query.tickBuffer !== undefined
                ? Number(req.query.tickBuffer)
                : req.body?.tickBuffer !== undefined
                    ? Number(req.body.tickBuffer)
                    : undefined;

        const timeBuffer =
            req.query.timeBuffer !== undefined
                ? Number(req.query.timeBuffer)
                : req.body?.timeBuffer !== undefined
                    ? Number(req.body.timeBuffer)
                    : undefined;

        const lastOutOfRangeTimestamp =
            req.query.lastOutOfRangeTimestamp !== undefined
                ? Number(req.query.lastOutOfRangeTimestamp)
                : req.body?.lastOutOfRangeTimestamp !== undefined
                    ? Number(req.body.lastOutOfRangeTimestamp)
                    : undefined;

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

        console.log(`[Server] Checking health for account: ${account} on network: ${network} (tickBuffer: ${tickBuffer ?? 0}, timeBuffer: ${timeBuffer ?? 0}s)`);
        const health = await checkUniswapPositionsHealth(account, {
            network,
            tickBuffer,
            timeBuffer,
            lastOutOfRangeTimestamp,
        });
        res.json(health);
    } catch (err: any) {
        console.error('Error checking position health:', err);
        res.status(500).json({
            error: 'Failed to check position health via Viem Fetcher',
            details: err?.message || String(err),
        });
    }
};

const handleRebalance = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const tokenId = req.query.tokenId || req.body?.tokenId;
        const network = ((req.query.network || req.body?.network) as string) || 'base-mainnet';

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

        const rangeWidth =
            req.query.rangeWidth !== undefined
                ? Number(req.query.rangeWidth)
                : req.body?.rangeWidth !== undefined
                    ? Number(req.body.rangeWidth)
                    : undefined;

        console.log(`[Server] Generating non-custodial rebalance plan for account: ${account} on network: ${network}`);
        const result = await rebalancePosition({
            account,
            tokenId: tokenId ? String(tokenId) : undefined,
            network,
            rangeWidth,
        });

        res.json(result);
    } catch (err: any) {
        console.error('Error executing position rebalance:', err);
        res.status(500).json({
            error: 'Failed to rebalance Uniswap position',
            details: err?.message || String(err),
        });
    }
};

const handleCopyIntelligence = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const network = ((req.query.network || req.body?.network) as string) || 'base-mainnet';
        console.log(`[Server] Generating copy trading intelligence feed for network: ${network}`);
        const intelligence = await getCopyTradingIntelligence({ network });

        let preparedTransactions: any[] = [];
        if (account && intelligence.suggestedRange) {
            console.log(`[Server] Generating non-custodial copy trade transaction bundle for account: ${account}`);
            const copyPositionResult = await createPosition({
                account,
                network,
                tickLower: intelligence.suggestedRange.tickLower,
                tickUpper: intelligence.suggestedRange.tickUpper,
            });
            preparedTransactions = copyPositionResult.preparedTransactions;
        }

        res.json({
            ...intelligence,
            account,
            preparedTransactions,
        });
    } catch (err: any) {
        console.error('Error generating copy trading intelligence feed:', err);
        res.status(500).json({
            error: 'Failed to generate copy trading intelligence feed',
            details: err?.message || String(err),
        });
    }
};

const handleCreatePosition = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const network = ((req.query.network || req.body?.network) as string) || 'base-mainnet';

        const rangeWidth =
            req.query.rangeWidth !== undefined
                ? Number(req.query.rangeWidth)
                : req.body?.rangeWidth !== undefined
                    ? Number(req.body.rangeWidth)
                    : undefined;

        const amount0Desired = (req.query.amount0Desired || req.body?.amount0Desired) as string | undefined;
        const amount1Desired = (req.query.amount1Desired || req.body?.amount1Desired) as string | undefined;

        const outOfRange =
            req.query.outOfRange !== undefined
                ? req.query.outOfRange === 'true' || req.query.outOfRange === '1'
                : req.body?.outOfRange !== undefined
                    ? Boolean(req.body.outOfRange)
                    : undefined;

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

        console.log(`[Server] Generating non-custodial position creation plan for account: ${account} on network: ${network}`);
        const result = await createPosition({
            account,
            network,
            rangeWidth,
            amount0Desired,
            amount1Desired,
            outOfRange,
        });

        res.json(result);
    } catch (err: any) {
        console.error('Error executing position creation:', err);
        res.status(500).json({
            error: 'Failed to create Uniswap position plan',
            details: err?.message || String(err),
        });
    }
};

const handleWithdrawPosition = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const tokenId = req.query.tokenId || req.body?.tokenId;
        const percentage = req.query.percentage || req.body?.percentage;
        const network = ((req.query.network || req.body?.network) as string) || 'base-mainnet';

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

        console.log(`[Server] Generating non-custodial position withdrawal plan for account: ${account} on network: ${network}`);
        const result = await withdrawPosition({
            account,
            tokenId: tokenId ? String(tokenId) : undefined,
            percentage: percentage !== undefined ? Number(percentage) : undefined,
            network,
        });

        res.json(result);
    } catch (err: any) {
        console.error('Error executing position withdrawal:', err);
        res.status(500).json({
            error: 'Failed to create Uniswap position withdrawal plan',
            details: err?.message || String(err),
        });
    }
};

// Protect routes with x402 payment middleware
app.get('/check-health', x402PaymentMiddleware, handleCheckHealth);
app.post('/check-health', x402PaymentMiddleware, handleCheckHealth);

app.get('/rebalance', x402PaymentMiddleware, handleRebalance);
app.post('/rebalance', x402PaymentMiddleware, handleRebalance);

app.get('/copy-intelligence', x402PaymentMiddleware, handleCopyIntelligence);
app.post('/copy-intelligence', x402PaymentMiddleware, handleCopyIntelligence);
app.get('/copy-trade', x402PaymentMiddleware, handleCopyIntelligence);
app.post('/copy-trade', x402PaymentMiddleware, handleCopyIntelligence);
app.get('/copy_trade', x402PaymentMiddleware, handleCopyIntelligence);
app.post('/copy_trade', x402PaymentMiddleware, handleCopyIntelligence);

app.get('/create-position', x402PaymentMiddleware, handleCreatePosition);
app.post('/create-position', x402PaymentMiddleware, handleCreatePosition);
app.get('/create-centered', x402PaymentMiddleware, handleCreatePosition);
app.post('/create-centered', x402PaymentMiddleware, handleCreatePosition);
app.get('/create_centered', x402PaymentMiddleware, handleCreatePosition);
app.post('/create_centered', x402PaymentMiddleware, handleCreatePosition);

app.get('/withdraw', x402PaymentMiddleware, handleWithdrawPosition);
app.post('/withdraw', x402PaymentMiddleware, handleWithdrawPosition);
app.get('/withdraw-position', x402PaymentMiddleware, handleWithdrawPosition);
app.post('/withdraw-position', x402PaymentMiddleware, handleWithdrawPosition);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`x402 Server Payment Receiver Wallet: ${SERVER_PAYMENT_ADDRESS}`);
});
