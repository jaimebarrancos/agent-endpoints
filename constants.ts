import { parseAbi } from 'viem';

// ===========================================================================
// BASE MAINNET (anvil and mainnet)
// ===========================================================================
export const POSITION_MANAGER_MAINNET = '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1';
export const SWAP_ROUTER_MAINNET = '0x2626664c2603336E57B271c5C0b26F421741e481';
export const WETH_ADDRESS_MAINNET = '0x4200000000000000000000000000000000000006';
export const USDC_ADDRESS_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const USDC_WETH_POOL_500_MAINNET = '0xd0b53D9277642d899DF5C87A3966A349A798F224';

export const SUBGRAPH_URL_MAINNET = 'http://localhost:8000/subgraphs/name/uniswap-v3-base'; //`https://gateway.thegraph.com/api/${process.env.SUBGRAPH_API_KEY || ''}/subgraphs/id/43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG`;

// ===========================================================================
// BASE TESTNET (BASE SEPOLIA)
// ===========================================================================
export const POSITION_MANAGER_TESTNET = '0x27F971cb582BF9E50F397e4d29a5C7A34f11faA2';
export const SWAP_ROUTER_TESTNET = '0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4';
export const WETH_ADDRESS_TESTNET = '0x4200000000000000000000000000000000000006';
export const USDC_ADDRESS_TESTNET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
export const USDC_WETH_POOL_500_TESTNET = '0xb3404E269FA916f1947bE0dAE6dff430eAbe8361';

export const SUBGRAPH_URL_TESTNET = 'http://localhost:8000/subgraphs/name/uniswap-v3-base'; //'https://api.studio.thegraph.com/query/48043/uniswap-v3-base-sepolia/version/latest';

// ===========================================================================
// ACTIVE SELECTION (DEFAULT)
// ===========================================================================
export const IS_TESTNET = process.env.NETWORK === 'base-sepolia';

export const POSITION_MANAGER = IS_TESTNET ? POSITION_MANAGER_TESTNET : POSITION_MANAGER_MAINNET;
export const SWAP_ROUTER = IS_TESTNET ? SWAP_ROUTER_TESTNET : SWAP_ROUTER_MAINNET;
export const WETH_ADDRESS = IS_TESTNET ? WETH_ADDRESS_TESTNET : WETH_ADDRESS_MAINNET;
export const USDC_ADDRESS = IS_TESTNET ? USDC_ADDRESS_TESTNET : USDC_ADDRESS_MAINNET;
export const USDC_WETH_POOL_500 = IS_TESTNET ? USDC_WETH_POOL_500_TESTNET : USDC_WETH_POOL_500_MAINNET;
export const SUBGRAPH_URL = IS_TESTNET ? SUBGRAPH_URL_TESTNET : SUBGRAPH_URL_MAINNET;

// ===========================================================================
// ABIs
// ===========================================================================
export const WETH_ABI = parseAbi([
    'function deposit() external payable',
    'function balanceOf(address owner) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
]);

export const ERC20_ABI = parseAbi([
    'function balanceOf(address owner) external view returns (uint256)',
    'function approve(address spender, uint256 amount) external returns (bool)',
]);

export const ROUTER_ABI = parseAbi([
    'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
]);

export const POOL_ABI = parseAbi([
    'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
    'function tickSpacing() external view returns (int24)',
]);

export const NPM_ABI = parseAbi([
    'function mint((address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
    'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
    'function decreaseLiquidity((uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) external payable returns (uint256 amount0, uint256 amount1)',
    'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external payable returns (uint256 amount0, uint256 amount1)',
    'function burn(uint256 tokenId) external payable',
    'function balanceOf(address owner) external view returns (uint256)',
    'function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)',
    'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
    'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
]);