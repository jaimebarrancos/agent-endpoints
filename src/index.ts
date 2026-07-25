import express, { type Express, type Request, type Response } from 'express';
import { checkUniswapPositionsHealth } from './fetcher.ts';
import { rebalancePosition } from './rebalance.ts';

const app: Express = express();

app.use(express.json());

const handleCheckHealth = async (req: Request, res: Response) => {
    try {
        const account = (
            req.query.account ||
            req.body?.account ||
            req.query.wallet ||
            req.body?.wallet
        ) as string | undefined;

        const network = ((req.query.network || req.body?.network) as string) || 'base-sepolia';

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

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
        const network = ((req.query.network || req.body?.network) as string) || 'base-sepolia';

        if (!account) {
            res.status(400).json({
                error: 'Missing required parameter "account". Provide ?account=0x... or JSON body {"account": "0x..."}',
            });
            return;
        }

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

app.get('/check-health', handleCheckHealth);
app.post('/check-health', handleCheckHealth);

app.get('/rebalance', handleRebalance);
app.post('/rebalance', handleRebalance);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});

