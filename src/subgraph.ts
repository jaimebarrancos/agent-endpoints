import 'dotenv/config';
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
    effectiveTickLower: number;
    effectiveTickUpper: number;
    currentTick: number;
    inRange: boolean;
    status: 'HEALTHY' | 'OUT_OF_RANGE' | 'NO_LIQUIDITY' | 'IN_TIME_BUFFER';
    buffers?: {
        tickBuffer: number;
        timeBuffer: number;
        timeOutOfRangeSeconds?: number;
        isWithinTickBuffer: boolean;
        isWithinTimeBuffer: boolean;
    };
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
    tickBuffer?: number;
    timeBuffer?: number;
    lastOutOfRangeTimestamp?: number;
}

function resolveSubgraphUrl(options?: HealthCheckOptions): { url: string; networkName: string } {
    if (options?.subgraphUrl) {
        return { url: options.subgraphUrl, networkName: 'custom' };
    }

    const isTestnet = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    if (isTestnet) {
        return {
            url: Constants.SUBGRAPH_URL_TESTNET,
            networkName: 'base-sepolia',
        };
    }

    return {
        url: Constants.SUBGRAPH_URL_MAINNET,
        networkName: 'base-mainnet',
    };
}

function parseTickValue(val: any): number {
    if (val === null || val === undefined) return 0;
    if (typeof val === 'object') {
        if (val.tickIdx !== undefined) return Number(val.tickIdx);
        if (val.id !== undefined) return Number(val.id);
    }
    return Number(val);
}

const POSITIONS_QUERY = `
query GetPositions($owner: String!) {
  positions(where: { owner: $owner }) {
    id
    owner
    liquidity
    tickLower {
      tickIdx
    }
    tickUpper {
      tickIdx
    }
    pool {
      id
      tick
      sqrtPrice
      feeTier
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
    }
  }
}
`;

export async function checkUniswapPositionsHealth(
    account: string,
    options?: HealthCheckOptions
): Promise<WalletHealthResult> {
    const ownerLower = account.toLowerCase();
    const { url: subgraphUrl, networkName } = resolveSubgraphUrl(options);

    const response = await fetch(subgraphUrl, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            query: POSITIONS_QUERY,
            variables: {
                owner: ownerLower,
            },
        }),
    });

    if (!response.ok) {
        throw new Error(`Subgraph request failed [${subgraphUrl}] with status ${response.status}: ${response.statusText}`);
    }

    const payload = (await response.json()) as { data?: { positions?: any[] }; errors?: any[] };

    if (payload.errors && payload.errors.length > 0) {
        throw new Error(`Subgraph GraphQL errors: ${JSON.stringify(payload.errors)}`);
    }

    const rawPositions = payload.data?.positions || [];

    const positions: PositionHealth[] = rawPositions.map((pos: any) => {
        const tickLower = parseTickValue(pos.tickLower);
        const tickUpper = parseTickValue(pos.tickUpper);
        const currentTick = parseTickValue(pos.pool?.tick);
        const liquidityBig = BigInt(pos.liquidity || '0');

        const tickBuffer = options?.tickBuffer || 0;
        const timeBuffer = options?.timeBuffer || 0;

        const effectiveTickLower = tickLower - tickBuffer;
        const effectiveTickUpper = tickUpper + tickBuffer;

        const isStrictlyInRange = currentTick >= tickLower && currentTick <= tickUpper;
        const isWithinBufferedRange = currentTick >= effectiveTickLower && currentTick <= effectiveTickUpper;
        const isWithinTickBuffer = !isStrictlyInRange && isWithinBufferedRange;

        let timeOutOfRangeSeconds: number | undefined;
        let isWithinTimeBuffer = false;

        if (!isWithinBufferedRange && timeBuffer > 0) {
            const now = Math.floor(Date.now() / 1000);
            const outOfRangeStart = options?.lastOutOfRangeTimestamp || now;
            timeOutOfRangeSeconds = Math.max(0, now - outOfRangeStart);

            if (timeOutOfRangeSeconds < timeBuffer) {
                isWithinTimeBuffer = true;
            }
        }

        const inRange = isStrictlyInRange || isWithinTickBuffer || isWithinTimeBuffer;

        let status: 'HEALTHY' | 'OUT_OF_RANGE' | 'NO_LIQUIDITY' | 'IN_TIME_BUFFER' = 'HEALTHY';
        if (liquidityBig === 0n) {
            status = 'NO_LIQUIDITY';
        } else if (isWithinTimeBuffer) {
            status = 'IN_TIME_BUFFER';
        } else if (!inRange) {
            status = 'OUT_OF_RANGE';
        }

        return {
            id: pos.id,
            owner: pos.owner,
            liquidity: pos.liquidity || '0',
            tickLower,
            tickUpper,
            effectiveTickLower,
            effectiveTickUpper,
            currentTick,
            inRange,
            status,
            buffers: {
                tickBuffer,
                timeBuffer,
                timeOutOfRangeSeconds,
                isWithinTickBuffer,
                isWithinTimeBuffer,
            },
            pool: {
                id: pos.pool?.id || '',
                tick: currentTick,
                sqrtPrice: pos.pool?.sqrtPrice,
                feeTier: pos.pool?.feeTier ? Number(pos.pool.feeTier) : undefined,
                token0: {
                    id: pos.pool?.token0?.id || '',
                    symbol: pos.pool?.token0?.symbol || '',
                    name: pos.pool?.token0?.name,
                    decimals: Number(pos.pool?.token0?.decimals || 18),
                },
                token1: {
                    id: pos.pool?.token1?.id || '',
                    symbol: pos.pool?.token1?.symbol || '',
                    name: pos.pool?.token1?.name,
                    decimals: Number(pos.pool?.token1?.decimals || 18),
                },
            },
        };
    });

    const activePositions = positions.filter((p) => BigInt(p.liquidity) > 0n);
    const isHealthy = activePositions.length === 0 || activePositions.every((p) => p.inRange);

    return {
        account,
        isHealthy,
        network: networkName,
        subgraphUrl,
        totalPositionsCount: positions.length,
        activePositionsCount: activePositions.length,
        positions,
    };
}

export interface TopWalletInfo {
    address: string;
    activePositionsCount: number;
    totalLiquidity: string;
}

export interface CopyTradingIntelligence {
    network: string;
    subgraphUrl: string;
    recommendedPool: PoolInfo;
    workingTickWidth: number;
    suggestedRange: {
        tickLower: number;
        tickUpper: number;
        alignedTickWidth: number;
    };
    topWalletsAnalyzed: TopWalletInfo[];
    totalPositionsAnalyzed: number;
}

const TOP_POSITIONS_QUERY = `
query GetTopPositions($first: Int!) {
  positions(first: $first, orderBy: liquidity, orderDirection: desc) {
    id
    owner
    liquidity
    tickLower {
      tickIdx
    }
    tickUpper {
      tickIdx
    }
    pool {
      id
      tick
      sqrtPrice
      feeTier
      token0 {
        id
        symbol
        name
        decimals
      }
      token1 {
        id
        symbol
        name
        decimals
      }
    }
  }
}
`;

export async function getCopyTradingIntelligence(
    options?: HealthCheckOptions
): Promise<CopyTradingIntelligence> {
    const { url: subgraphUrl, networkName } = resolveSubgraphUrl(options);

    let rawPositions: any[] = [];
    try {
        const response = await fetch(subgraphUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                query: TOP_POSITIONS_QUERY,
                variables: { first: 100 },
            }),
        });

        if (response.ok) {
            const payload = (await response.json()) as { data?: { positions?: any[] }; errors?: any[] };
            if (!payload.errors && payload.data?.positions) {
                rawPositions = payload.data.positions;
            }
        }
    } catch (err) {
        console.warn(`[Subgraph] Querying top positions from ${subgraphUrl} failed, using intelligent fallback.`, err);
    }

    // Default pool fallback derived from central constants
    const defaultPoolAddress = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia'
        ? Constants.USDC_WETH_POOL_500_TESTNET
        : Constants.USDC_WETH_POOL_500_MAINNET;

    const defaultToken0Address = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia'
        ? Constants.WETH_ADDRESS_TESTNET
        : Constants.WETH_ADDRESS_MAINNET;

    const defaultToken1Address = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia'
        ? Constants.USDC_ADDRESS_TESTNET
        : Constants.USDC_ADDRESS_MAINNET;

    const fallbackPool: PoolInfo = {
        id: defaultPoolAddress,
        tick: 200000,
        sqrtPrice: '0',
        feeTier: 500,
        token0: {
            id: defaultToken0Address,
            symbol: 'WETH',
            name: 'Wrapped Ether',
            decimals: 18,
        },
        token1: {
            id: defaultToken1Address,
            symbol: 'USDC',
            name: 'USD Coin',
            decimals: 6,
        },
    };

    if (rawPositions.length === 0) {
        // Fallback response when subgraph returns no positions
        const feeTier = 500;
        const tickSpacing = 10;
        const defaultWidth = 200;
        const currentTick = fallbackPool.tick;
        const currentTickAligned = Math.floor(currentTick / tickSpacing) * tickSpacing;

        return {
            network: networkName,
            subgraphUrl,
            recommendedPool: fallbackPool,
            workingTickWidth: defaultWidth,
            suggestedRange: {
                tickLower: currentTickAligned - defaultWidth / 2,
                tickUpper: currentTickAligned + defaultWidth / 2,
                alignedTickWidth: defaultWidth,
            },
            topWalletsAnalyzed: [],
            totalPositionsAnalyzed: 0,
        };
    }

    // Process positions
    const activePositions = rawPositions.filter((p) => BigInt(p.liquidity || '0') > 0n);

    // Group by owner
    const walletMap = new Map<string, { address: string; activePositionsCount: number; totalLiquidity: bigint }>();
    const poolMap = new Map<string, { poolInfo: PoolInfo; totalLiquidity: bigint; tickWidths: number[] }>();

    for (const pos of activePositions) {
        const owner = pos.owner.toLowerCase();
        const liquidity = BigInt(pos.liquidity || '0');
        const tickLower = parseTickValue(pos.tickLower);
        const tickUpper = parseTickValue(pos.tickUpper);
        const tickWidth = Math.abs(tickUpper - tickLower);

        // Wallet tracking
        if (!walletMap.has(owner)) {
            walletMap.set(owner, { address: owner, activePositionsCount: 0, totalLiquidity: 0n });
        }
        const wallet = walletMap.get(owner)!;
        wallet.activePositionsCount += 1;
        wallet.totalLiquidity += liquidity;

        // Pool tracking
        const poolId = pos.pool?.id?.toLowerCase() || fallbackPool.id.toLowerCase();
        if (!poolMap.has(poolId)) {
            const currentTick = parseTickValue(pos.pool?.tick);
            const poolInfo: PoolInfo = {
                id: pos.pool?.id || fallbackPool.id,
                tick: currentTick,
                sqrtPrice: pos.pool?.sqrtPrice,
                feeTier: pos.pool?.feeTier ? Number(pos.pool.feeTier) : 500,
                token0: {
                    id: pos.pool?.token0?.id || fallbackPool.token0.id,
                    symbol: pos.pool?.token0?.symbol || fallbackPool.token0.symbol,
                    name: pos.pool?.token0?.name,
                    decimals: Number(pos.pool?.token0?.decimals || 18),
                },
                token1: {
                    id: pos.pool?.token1?.id || fallbackPool.token1.id,
                    symbol: pos.pool?.token1?.symbol || fallbackPool.token1.symbol,
                    name: pos.pool?.token1?.name,
                    decimals: Number(pos.pool?.token1?.decimals || 6),
                },
            };
            poolMap.set(poolId, { poolInfo, totalLiquidity: 0n, tickWidths: [] });
        }

        const poolEntry = poolMap.get(poolId)!;
        poolEntry.totalLiquidity += liquidity;
        if (tickWidth > 0) {
            poolEntry.tickWidths.push(tickWidth);
        }
    }

    // Top wallets list sorted by total liquidity
    const topWalletsAnalyzed: TopWalletInfo[] = Array.from(walletMap.values())
        .sort((a, b) => (b.totalLiquidity > a.totalLiquidity ? 1 : -1))
        .slice(0, 10)
        .map((w) => ({
            address: w.address,
            activePositionsCount: w.activePositionsCount,
            totalLiquidity: w.totalLiquidity.toString(),
        }));

    // Find recommended pool with highest total liquidity
    const sortedPools = Array.from(poolMap.values()).sort((a, b) =>
        b.totalLiquidity > a.totalLiquidity ? 1 : -1
    );

    const bestPoolEntry = sortedPools[0] || {
        poolInfo: fallbackPool,
        totalLiquidity: 0n,
        tickWidths: [200],
    };

    const recommendedPool = bestPoolEntry.poolInfo;
    const tickWidths = bestPoolEntry.tickWidths.length > 0 ? bestPoolEntry.tickWidths : [200];

    // Compute median tick width
    tickWidths.sort((a, b) => a - b);
    const midIndex = Math.floor(tickWidths.length / 2);
    const rawWorkingTickWidth =
        tickWidths.length % 2 !== 0
            ? tickWidths[midIndex]
            : Math.round((tickWidths[midIndex - 1] + tickWidths[midIndex]) / 2);

    const feeTierNum = Number(recommendedPool.feeTier || 500);
    const tickSpacing = feeTierNum === 500 ? 10 : feeTierNum === 3000 ? 60 : 200;
    const alignedTickWidth = Math.max(
        tickSpacing * 2,
        Math.round(rawWorkingTickWidth / tickSpacing) * tickSpacing
    );

    const currentTick = recommendedPool.tick;
    const halfWidth = Math.floor(alignedTickWidth / 2 / tickSpacing) * tickSpacing;
    const currentTickAligned = Math.floor(currentTick / tickSpacing) * tickSpacing;

    const tickLower = currentTickAligned - halfWidth;
    const tickUpper = tickLower + alignedTickWidth;

    return {
        network: networkName,
        subgraphUrl,
        recommendedPool,
        workingTickWidth: rawWorkingTickWidth,
        suggestedRange: {
            tickLower,
            tickUpper,
            alignedTickWidth,
        },
        topWalletsAnalyzed,
        totalPositionsAnalyzed: activePositions.length,
    };
}

