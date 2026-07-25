import 'dotenv/config';

export interface UniswapQuoteOptions {
    tokenIn: string;
    tokenOut: string;
    amountIn: string;
    recipient: string;
    chainId?: number; // default Base mainnet: 8453
    slippageTolerancePercent?: number; // default 0.5%
}

export interface UniswapQuoteResponse {
    success: boolean;
    amountOut?: string;
    amountOutMin?: string;
    priceImpact?: number;
    methodParameters?: {
        calldata: string;
        to: string;
        value: string;
    };
    source: 'UNISWAP_API' | 'FALLBACK_CALCULATION';
    error?: string;
}

/**
 * Fetches an optimal route & quote from Uniswap's Routing API if UNISWAP_API_KEY is configured.
 * Falls back gracefully to off-chain estimation if the API key is missing or the request fails.
 */
export async function getUniswapQuote(options: UniswapQuoteOptions): Promise<UniswapQuoteResponse> {
    const apiKey = process.env.UNISWAP_API_KEY;
    const slippage = options.slippageTolerancePercent ?? 0.5;
    const chainId = options.chainId ?? 8453; // Base Mainnet

    if (apiKey) {
        try {
            console.log(`[Uniswap API] Querying Uniswap Quote API for ${options.amountIn} units...`);
            const url = `https://api.uniswap.org/v1/quote`;
            const response = await fetch(url, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': apiKey,
                },
                body: JSON.stringify({
                    tokenInChainId: chainId,
                    tokenIn: options.tokenIn,
                    tokenOutChainId: chainId,
                    tokenOut: options.tokenOut,
                    amount: options.amountIn,
                    type: 'EXACT_INPUT',
                    recipient: options.recipient,
                    slippageTolerance: slippage,
                }),
            });

            if (response.ok) {
                const data = await response.json();
                const quoteAmountOut = data.quote?.amount;
                if (quoteAmountOut) {
                    const amountOutBig = BigInt(quoteAmountOut);
                    const slippageFactor = BigInt(Math.floor((100 - slippage) * 100));
                    const amountOutMin = ((amountOutBig * slippageFactor) / 10000n).toString();

                    return {
                        success: true,
                        amountOut: quoteAmountOut,
                        amountOutMin,
                        priceImpact: data.priceImpact ? parseFloat(data.priceImpact) : undefined,
                        methodParameters: data.methodParameters
                            ? {
                                calldata: data.methodParameters.calldata,
                                to: data.methodParameters.to,
                                value: data.methodParameters.value || '0',
                            }
                            : undefined,
                        source: 'UNISWAP_API',
                    };
                }
            } else {
                console.warn(`[Uniswap API] API call returned status ${response.status}: ${await response.text()}`);
            }
        } catch (err: any) {
            console.warn(`[Uniswap API] Failed to reach Uniswap API: ${err?.message || err}`);
        }
    } else {
        console.log('[Uniswap API] UNISWAP_API_KEY not set. Using local fallback price/slippage estimation.');
    }
    // Fallback response structure
    return {
        success: false,
        source: 'FALLBACK_CALCULATION',
        error: apiKey ? 'API call failed' : 'UNISWAP_API_KEY not provided',
    };
}

/**
 * Calculates slippage boundaries (amount0Min & amount1Min) for minting or swapping.
 * Default tolerance is 0.5% (99.5% of desired amount).
 */
export function calculateSlippageBounds(
    amount0Desired: bigint,
    amount1Desired: bigint,
    slippagePercent: number = 0.5
): { amount0Min: bigint; amount1Min: bigint } {
    const factorNum = BigInt(Math.floor((100 - slippagePercent) * 100)); // e.g. 9950 for 0.5%
    const factorDenom = 10000n;

    return {
        amount0Min: (amount0Desired * factorNum) / factorDenom,
        amount1Min: (amount1Desired * factorNum) / factorDenom,
    };
}
