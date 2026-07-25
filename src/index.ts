import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { createPublicClient, http, formatEther } from 'viem';
import { base } from 'viem/chains';
import * as Constants from '../constants.ts';
import { checkUniswapPositionsHealth } from './fetcher.ts';
import { rebalancePosition } from './rebalance.ts';

const app: Express = express();
app.use(express.json());

// Server Payment Receiver Wallet (3rd Foundry Account)
export const SERVER_PAYMENT_ADDRESS = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC' as `0x${string}`;

const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';
const publicClient = createPublicClient({
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
        console.log(` [x402 Server] Payment Received for ${route}`);
        console.log(` Receiver Wallet: ${SERVER_PAYMENT_ADDRESS}`);
        console.log(` Current ETH Balance:  ${formatEther(ethBal)} ETH`);
        console.log(` Current USDC Balance: $${(Number(usdcBal) / 1e6).toFixed(2)} USDC (${usdcBal.toString()} units)`);
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
                    amount: '10000', // 0.01 USDC (6 decimals)
                    payTo: SERVER_PAYMENT_ADDRESS,
                    maxTimeoutSeconds: 60,
                    extra: {},
                },
            ],
        };

        const encodedHeader = Buffer.from(JSON.stringify(paymentRequirements)).toString('base64');
        res.setHeader('PAYMENT-REQUIRED', encodedHeader);
        res.status(402).json(paymentRequirements);
        return;
    }

    // Payment signature present
    console.log(`[x402 Server] Valid payment header detected for ${req.path}`);
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

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

        console.log(`[Server] Checking health for account: ${account} on network: ${network}`);
        const health = await checkUniswapPositionsHealth(account, { network });
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

        console.log(`[Server] Executing rebalance for account: ${account} on network: ${network}`);
        const result = await rebalancePosition({
            account,
            tokenId: tokenId ? String(tokenId) : undefined,
            network,
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

// Protect routes with x402 payment middleware
app.get('/check-health', x402PaymentMiddleware, handleCheckHealth);
app.post('/check-health', x402PaymentMiddleware, handleCheckHealth);

app.get('/rebalance', x402PaymentMiddleware, handleRebalance);
app.post('/rebalance', x402PaymentMiddleware, handleRebalance);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
    console.log(`x402 Server Payment Receiver Wallet: ${SERVER_PAYMENT_ADDRESS}`);
});
