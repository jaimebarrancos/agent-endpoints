import 'dotenv/config';
import { createPublicClient, http, parseAbi } from 'viem';
import { base, baseSepolia } from 'viem/chains';
import * as Constants from '../constants.ts';

export interface TokenInfo {
    id: string;
    symbol: string;
    name?: string;
    decimals: number;
}

export interface PoolInfo {
    id: string;
    tick: number;
    sqrtPrice?: string;
    feeTier?: number | string;
    token0: TokenInfo;
    token1: TokenInfo;
}

export interface PositionHealth {
    id: string;
    owner: string;
    liquidity: string;
    tickLower: number;
    tickUpper: number;
    currentTick: number;
    inRange: boolean;
    status: 'HEALTHY' | 'OUT_OF_RANGE' | 'NO_LIQUIDITY';
    pool: PoolInfo;
}

export interface WalletHealthResult {
    account: string;
    isHealthy: boolean;
    network: string;
    subgraphUrl: string;
    totalPositionsCount: number;
    activePositionsCount: number;
    positions: PositionHealth[];
}

export interface HealthCheckOptions {
    network?: 'base-mainnet' | 'base-sepolia' | string;
    subgraphUrl?: string;
}

const extendedErc20Abi = parseAbi([
    'function symbol() external view returns (string)',
    'function name() external view returns (string)',
    'function decimals() external view returns (uint8)',
]);

export async function checkUniswapPositionsHealth(
    account: string,
    options?: HealthCheckOptions
): Promise<WalletHealthResult> {
    const isTestnet = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    const networkName = isTestnet ? 'base-sepolia' : 'base-mainnet';
    const chain = isTestnet ? baseSepolia : base;
    const rpcUrl = process.env.RPC_URL || 'http://127.0.0.1:8545';

    const publicClient = createPublicClient({
        chain,
        transport: http(rpcUrl),
    });

    const positionManager = (isTestnet ? Constants.POSITION_MANAGER_TESTNET : Constants.POSITION_MANAGER_MAINNET) as `0x${string}`;
    const poolAddress = isTestnet ? Constants.USDC_WETH_POOL_500_TESTNET : Constants.USDC_WETH_POOL_500_MAINNET;

    // 1. Get total number of LP NFTs owned by the wallet
    let balance = 0n;
    try {
        balance = await publicClient.readContract({
            address: positionManager,
            abi: Constants.NPM_ABI,
            functionName: 'balanceOf',
            args: [account as `0x${string}`],
        });
    } catch (err) {
        console.warn(`[Fetcher] Error reading balanceOf for ${account}:`, err);
    }

    // 2. Fetch current pool tick & sqrtPrice
    let poolCurrentTick = 0;
    let poolSqrtPrice = '0';
    try {
        const [sqrtPriceX96, tick] = await publicClient.readContract({
            address: poolAddress as `0x${string}`,
            abi: Constants.POOL_ABI,
            functionName: 'slot0',
        });
        poolCurrentTick = tick;
        poolSqrtPrice = sqrtPriceX96.toString();
    } catch (err) {
        console.warn('[Fetcher] Error reading pool slot0:', err);
    }

    if (balance === 0n) {
        return {
            account,
            isHealthy: true,
            network: networkName,
            subgraphUrl: 'viem-rpc-fetcher',
            totalPositionsCount: 0,
            activePositionsCount: 0,
            positions: [],
        };
    }

    // 3. Fetch all Token IDs using multicall with direct read fallback
    let tokenIds: bigint[] = [];
    try {
        const tokenIdCalls = Array.from({ length: Number(balance) }, (_, i) => ({
            address: positionManager,
            abi: Constants.NPM_ABI,
            functionName: 'tokenOfOwnerByIndex' as const,
            args: [account as `0x${string}`, BigInt(i)],
        }));

        const tokenIdResults = await publicClient.multicall({ contracts: tokenIdCalls });
        tokenIds = tokenIdResults
            .map((res) => (res.status === 'success' ? (res.result as bigint) : null))
            .filter((id): id is bigint => id !== null);
    } catch (err) {
        console.warn('[Fetcher] Multicall for tokenOfOwnerByIndex failed, falling back to direct reads:', err);
    }

    // Direct read fallback if multicall returned no tokenIds
    if (tokenIds.length === 0 && balance > 0n) {
        for (let i = 0n; i < balance; i++) {
            try {
                const tokenId = await publicClient.readContract({
                    address: positionManager,
                    abi: Constants.NPM_ABI,
                    functionName: 'tokenOfOwnerByIndex',
                    args: [account as `0x${string}`, i],
                });
                tokenIds.push(tokenId);
            } catch (err) {
                console.warn(`[Fetcher] Direct read tokenOfOwnerByIndex failed at index ${i}:`, err);
            }
        }
    }

    if (tokenIds.length === 0) {
        return {
            account,
            isHealthy: true,
            network: networkName,
            subgraphUrl: 'viem-rpc-fetcher',
            totalPositionsCount: 0,
            activePositionsCount: 0,
            positions: [],
        };
    }

    // 4. Fetch position details for all Token IDs (multicall + direct fallback)
    let positionResults: any[] = [];
    try {
        const positionCalls = tokenIds.map((tokenId) => ({
            address: positionManager,
            abi: Constants.NPM_ABI,
            functionName: 'positions' as const,
            args: [tokenId],
        }));
        positionResults = await publicClient.multicall({ contracts: positionCalls });
    } catch (err) {
        console.warn('[Fetcher] Multicall for positions failed, falling back to direct reads:', err);
    }

    const tokenCache = new Map<string, TokenInfo>();

    async function getTokenInfo(tokenAddress: `0x${string}`): Promise<TokenInfo> {
        const lower = tokenAddress.toLowerCase();
        if (tokenCache.has(lower)) return tokenCache.get(lower)!;

        if (lower === Constants.WETH_ADDRESS_MAINNET.toLowerCase()) {
            const info = { id: lower, symbol: 'WETH', name: 'Wrapped Ether', decimals: 18 };
            tokenCache.set(lower, info);
            return info;
        }
        if (lower === Constants.USDC_ADDRESS_MAINNET.toLowerCase()) {
            const info = { id: lower, symbol: 'USDC', name: 'USD Coin', decimals: 6 };
            tokenCache.set(lower, info);
            return info;
        }

        try {
            const [symbol, name, decimals] = await Promise.all([
                publicClient.readContract({ address: tokenAddress, abi: extendedErc20Abi, functionName: 'symbol' }),
                publicClient.readContract({ address: tokenAddress, abi: extendedErc20Abi, functionName: 'name' }),
                publicClient.readContract({ address: tokenAddress, abi: extendedErc20Abi, functionName: 'decimals' }),
            ]);
            const info = { id: lower, symbol, name, decimals: Number(decimals) };
            tokenCache.set(lower, info);
            return info;
        } catch {
            const info = { id: lower, symbol: 'UNKNOWN', name: 'Unknown Token', decimals: 18 };
            tokenCache.set(lower, info);
            return info;
        }
    }

    const positions: PositionHealth[] = [];

    for (let i = 0; i < tokenIds.length; i++) {
        const tokenId = tokenIds[i];
        let posData: any = null;

        if (positionResults[i] && positionResults[i].status === 'success') {
            posData = positionResults[i].result;
        } else {
            try {
                posData = await publicClient.readContract({
                    address: positionManager,
                    abi: Constants.NPM_ABI,
                    functionName: 'positions',
                    args: [tokenId],
                });
            } catch (err) {
                console.warn(`[Fetcher] Error reading position for tokenId ${tokenId}:`, err);
            }
        }

        if (!posData) continue;

        const [, , token0Address, token1Address, feeTier, tickLower, tickUpper, liquidity] = posData as [
            bigint, `0x${string}`, `0x${string}`, `0x${string}`, number, number, number, bigint, bigint, bigint, bigint, bigint
        ];

        const [token0Info, token1Info] = await Promise.all([
            getTokenInfo(token0Address as `0x${string}`),
            getTokenInfo(token1Address as `0x${string}`),
        ]);

        const inRange = poolCurrentTick >= tickLower && poolCurrentTick <= tickUpper;
        let status: 'HEALTHY' | 'OUT_OF_RANGE' | 'NO_LIQUIDITY' = 'HEALTHY';
        if (liquidity === 0n) {
            status = 'NO_LIQUIDITY';
        } else if (!inRange) {
            status = 'OUT_OF_RANGE';
        }

        positions.push({
            id: tokenId.toString(),
            owner: account,
            liquidity: liquidity.toString(),
            tickLower,
            tickUpper,
            currentTick: poolCurrentTick,
            inRange,
            status,
            pool: {
                id: poolAddress,
                tick: poolCurrentTick,
                sqrtPrice: poolSqrtPrice,
                feeTier: Number(feeTier),
                token0: token0Info,
                token1: token1Info,
            },
        });
    }

    const activePositions = positions.filter((p) => BigInt(p.liquidity) > 0n);
    const isHealthy = activePositions.length === 0 || activePositions.every((p) => p.inRange);

    return {
        account,
        isHealthy,
        network: networkName,
        subgraphUrl: 'viem-rpc-fetcher',
        totalPositionsCount: positions.length,
        activePositionsCount: activePositions.length,
        positions,
    };
}
