import 'dotenv/config';
import { SUBGRAPH_URL_MAINNET, SUBGRAPH_URL_TESTNET } from '../constants.ts';

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

function resolveSubgraphUrl(options?: HealthCheckOptions): { url: string; networkName: string } {
    if (options?.subgraphUrl) {
        return { url: options.subgraphUrl, networkName: 'custom' };
    }

    const isTestnet = options?.network === 'base-sepolia' || process.env.NETWORK === 'base-sepolia';
    if (isTestnet) {
        return {
            url: SUBGRAPH_URL_TESTNET,
            networkName: 'base-sepolia',
        };
    }

    return {
        url: SUBGRAPH_URL_MAINNET,
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

        const inRange = currentTick >= tickLower && currentTick <= tickUpper;

        let status: 'HEALTHY' | 'OUT_OF_RANGE' | 'NO_LIQUIDITY' = 'HEALTHY';
        if (liquidityBig === 0n) {
            status = 'NO_LIQUIDITY';
        } else if (!inRange) {
            status = 'OUT_OF_RANGE';
        }

        return {
            id: pos.id,
            owner: pos.owner,
            liquidity: pos.liquidity || '0',
            tickLower,
            tickUpper,
            currentTick,
            inRange,
            status,
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
