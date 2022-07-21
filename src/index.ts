import { pick, uniq, get, floor } from 'lodash'
import moment from 'moment'
import { BigNumber } from 'bignumber.js'
import { BigNumber as BN } from '@ethersproject/bignumber'
import { multicall } from './utils/multicall'
import { Contract } from '@ethersproject/contracts'
import { StaticJsonRpcProvider } from '@ethersproject/providers'
import { Cache } from './utils/cache'

const BSC_BLOCK_TIME = 3
const BLOCKS_PER_YEAR = new BigNumber((60 / BSC_BLOCK_TIME) * 60 * 24 * 365)

interface FARM {
  alias: string;
  address: string;
  stakeToken: string;
  earnToken: string;
  masterChef: string;
  masterChefAddress: string;
}

interface Token {
  address: string;
  decimals: number;
  symbol: string;
  name: string;
}

interface Context {
  chainId: string;
  rpcNode: string;
  multiCallAddress: string;
  graphql: string;
  cache: Cache;
  tokens: { [key: string]: Token };
  config: any;
  getToken: (symbol: string) => Token;
}

interface AliasAddress {
  alias: string;
  address: string;
}

interface PriceResult {
  price: BigNumber;
  priceRelated: BigNumber;
}

function etherToBn(v: any) {
  return new BigNumber(v.toString())
}

function bnToNumber(n: BigNumber, decimals: number = 0) {
  return n.div(1e18).dp(decimals, BigNumber.ROUND_FLOOR).toNumber()
}

interface Options {
  chainId?: string;
  rpcNode?: string;
  others?: any;
}

async function _getTokenPrice(
  ctx: Context,
  token: string,
  pair: string,
  oracle: string
) {
  const abi = [
    'function getLatestPrice() external view returns (uint256,uint8)',
    'function token0() external view returns (address)',
    'function getReserves() external view returns (uint256,uint256)',
  ]

  const calls = [
    {
      abi,
      target: 'latestPrice',
      address: oracle,
      fn: 'getLatestPrice',
      params: []
    },
    {
      abi,
      target: 'token0',
      address: pair,
      fn: 'token0',
      params: []
    },
    {
      abi,
      target: 'getReserves',
      address: pair,
      fn: 'getReserves',
      params: []
    }
  ]

  const result = await multicall(ctx.multiCallAddress, ctx.rpcNode, calls)

  const [ _price, decimals ] = result['latestPrice']
  const tokenPrice = new BigNumber(_price.toString())
  const [ _reserve0, _reserve1 ] = result['getReserves']
  const reserve0 = new BigNumber(_reserve0.toString())
  const reserve1 = new BigNumber(_reserve1.toString())
  const token0 = token.toLowerCase() == result['token0'].toLowerCase()

  let price = new BigNumber(0)
  if (!reserve0.eq(0)) {
    if (token0) {
      price = tokenPrice.times(reserve1).div(reserve0.times(new BigNumber(10).pow(decimals)))
    } else {
      price = tokenPrice.times(reserve0).div(reserve1.times(new BigNumber(10).pow(decimals)))
    }
  }

  const priceRelated = token0 ? reserve1.div(reserve0) : reserve0.div(reserve1)
  return { price, priceRelated }
}

function _getLBRPrice(ctx: Context) {
  const lbrToken = ctx.getToken('LBR')
  const helper = ctx.config.priceHelper.find((v: any) => v.token.toLowerCase() == 'lbr')!
  const { pair, another } = helper
  const oracle = ctx.config.oracles.find((v: any) => v.token.toLowerCase() == another.toLowerCase())!
  return _getTokenPrice(
    ctx,
    lbrToken.address,
    pair,
    oracle.address
  )
}

async function getMarketCap(ctx: Context) {
  const { price } = await _getLBRPrice(ctx)
  const lbrToken = ctx.getToken('LBR')
  const abi = [
    'function totalSupply() external view returns (uint256)',
    'function balanceOf(address _owner) external view returns (uint256)'
  ]

  const lockedAddresses: string[] = uniq(ctx.config.farms.map((v: any) => v.masterChefAddress))
  const calls = [
    {
      abi,
      target: 'totalSupply',
      address: lbrToken.address,
      fn: 'totalSupply',
      params: []
    },
    ...lockedAddresses.map(v => ({
      abi,
      target: v,
      address: lbrToken.address,
      fn: 'balanceOf',
      params: [v]
    }))
  ]

  const result = await multicall(ctx.multiCallAddress, ctx.rpcNode, calls)
  const totalSupply = new BigNumber(result['totalSupply'].toString())
  const locked = lockedAddresses.reduce((sum, v) => sum = sum.plus(new BigNumber(result[v].toString())), new BigNumber(0))
  const marketCap = bnToNumber(totalSupply.minus(locked).times(price), 8)
  return {
    totalSupply,
    locked,
    price: bnToNumber(price, 8),
    marketCap
  }
}

async function getTVL(ctx: Context) {
  const abi = [
    'function getTokenBalance(uint8 index) external view returns (uint256)',
    'function getLatestPrice() external view returns (uint256,uint8)',
    'function token0() external view returns (address)',
    'function getReserves() external view returns (uint256,uint256)',
    'function balanceOf(address _owner) external view returns (uint256)'
  ]
  const basePool = ctx.config.basePools[0]
  const baseTokens = basePool.tokens.map((v: string) => ctx.getToken(v))
  const metaPool = ctx.config.metaPools[0]
  const lbrToken = ctx.getToken('LBR')
  const farm = ctx.config.farms[0]

  const lbrHelper = ctx.config.priceHelper.find((v: any) => v.token.toLowerCase() == 'lbr')
  const usdmHelper = ctx.config.priceHelper.find((v: any) => v.token.toLowerCase() == 'usdm')

  const calls = [
    ...baseTokens.map((v: any, i: number) => ({
      abi,
      target: 'getTokenBalance' + i,
      address: basePool.address,
      fn: 'getTokenBalance',
      params: [i]
    })),
    ...baseTokens.map((v: any, i: number) => ({
      abi,
      target: 'price' + i,
      address: ctx.config.oracles.find((x: any) => x.token.toLowerCase() == v.symbol.toLowerCase()).address,
      fn: 'getLatestPrice',
      params: []
    })),
    {
      abi,
      target: 'priceWBNB',
      address: ctx.config.oracles.find((v: any) => v.token.toLowerCase() == 'wbnb').address,
      fn: 'getLatestPrice',
      params: []
    },
    {
      abi,
      target: 'usdmBalance',
      address: metaPool.address,
      fn: 'getTokenBalance',
      params: [0]
    },
    {
      abi,
      target: 'lbrBalance',
      address: lbrToken.address,
      fn: 'balanceOf',
      params: [farm.masterChefAddress]
    },
    {
      abi,
      target: 'lbrHelperToken0',
      address: lbrHelper.pair,
      fn: 'token0',
      params: []
    },
    {
      abi,
      target: 'lbrHelperReserves',
      address: lbrHelper.pair,
      fn: 'getReserves',
      params: []
    },
    {
      abi,
      target: 'usdmHelperToken0',
      address: usdmHelper.pair,
      fn: 'token0',
      params: []
    },
    {
      abi,
      target: 'usdmHelperReserves',
      address: usdmHelper.pair,
      fn: 'getReserves',
      params: []
    },
  ]

  const result = await multicall(ctx.multiCallAddress, ctx.rpcNode, calls)
  
  let basePoolTVL = new BigNumber(0)
  baseTokens.forEach((v: any, i: number) => {
    const [ _price, decimals ] = result['price' + i]
    const balance = new BigNumber(result['getTokenBalance' + i].toString())
    const price = new BigNumber(_price.toString()).div(new BigNumber(10).pow(decimals))
    v.price = price
    basePoolTVL = basePoolTVL.plus(balance.times(price).div(new BigNumber(10).pow(v.decimals)))
  })

  const busd = baseTokens.find((v: any) => v.symbol.toLowerCase() == 'busd')
  const usdm = ctx.getToken('USDm')
  let metaPoolTVL = new BigNumber(0)
  {
    const usdmBalance = new BigNumber(result['usdmBalance'].toString())
    const [ _reserve0, _reserve1 ] = result['usdmHelperReserves']
    const reserve0 = new BigNumber(_reserve0.toString())
    const reserve1 = new BigNumber(_reserve1.toString())
    const token0 = usdm.address.toLowerCase() == result['usdmHelperToken0'].toLowerCase()
    let price = new BigNumber(0)
    if (!reserve0.eq(0)) {
      if (token0) {
        price = busd.price.times(reserve1).div(reserve0)
      } else {
        price = busd.price.times(reserve0).div(reserve1)
      }
    }
    metaPoolTVL = price.times(usdmBalance).div(new BigNumber(10).pow(usdm.decimals))
  }

  let lbrTVL = new BigNumber(0)
  {
    const [ _price, decimals ] = result['priceWBNB']
    const priceWBNB = new BigNumber(_price.toString()).div(new BigNumber(10).pow(decimals))
    const lbrBalance = new BigNumber(result['lbrBalance'].toString())
    const [ _reserve0, _reserve1 ] = result['lbrHelperReserves']
    const reserve0 = new BigNumber(_reserve0.toString())
    const reserve1 = new BigNumber(_reserve1.toString())
    const token0 = usdm.address.toLowerCase() == result['lbrHelperToken0'].toLowerCase()
    let price = new BigNumber(0)
    if (!reserve0.eq(0)) {
      if (token0) {
        price = priceWBNB.times(reserve1).div(reserve0)
      } else {
        price = priceWBNB.times(reserve0).div(reserve1)
      }
    }
    lbrTVL = price.times(lbrBalance).div(new BigNumber(10).pow(usdm.decimals))
  }

  const total = basePoolTVL.plus(metaPoolTVL).plus(lbrTVL)
  return {
    total,
    basePoolTVL,
    metaPoolTVL,
    lbrTVL
  }
}

import { getClient } from './utils/apollo'
import gql from 'graphql-tag'

const APR_SUMMARY = gql`
query Summary($ids: [String!]!, $dvIds: [String!]!) {
  swaps(
    where: {
      address_in: $ids
    }
  ) {
    address
    adminFee
    swapFee
  }
  dailyVolumes(
    where: {
      id_in: $dvIds
    }
  ) {
    id
    volume
  }
}
`

async function getAPR(ctx: Context) {
  const { basePoolTVL, metaPoolTVL } = await getTVL(ctx)

  const ONE_DAY_SECONDS = 86400
  const timestamp = floor(moment().unix() / ONE_DAY_SECONDS) * ONE_DAY_SECONDS - ONE_DAY_SECONDS
  const basePools = ctx.config.basePools
  const metaPools = ctx.config.metaPools
  const ids = [ ...basePools, ...metaPools ].map(v => v.address.toLowerCase())
  const dvIds = ids.map(v => `${v}-day-${timestamp}`)
  const client = getClient(ctx.graphql)
  const {
    data,
    errors
  } = await client.query({
    query: APR_SUMMARY,
    fetchPolicy: 'no-cache',
    variables: {
      ids,
      dvIds
    }
  })

  const basePoolVolume = get(data, 'dailyVolumes', []).find((v: any) => v.id == basePools[0].address.toLowerCase() + `-day-${timestamp}`)
  const basePoolSwap = get(data, 'swaps', []).find((v: any) => v.address == basePools[0].address.toLowerCase())
  let volume = get(basePoolVolume, 'volume', '0')
  let adminFee = get(basePoolSwap, 'adminFee', '0')
  let swapFee = get(basePoolSwap, 'swapFee', '0')

  const basePoolAPR = new BigNumber(volume).times(new BigNumber(swapFee).times(new BigNumber(1e10).minus(adminFee))).times(365).div(1e20).div(basePoolTVL)

  const metaPoolVolume = get(data, 'dailyVolumes', []).find((v: any) => v.id == metaPools[0].address.toLowerCase() + `-day-${timestamp}`)
  const metaPoolSwap = get(data, 'swaps', []).find((v: any) => v.address == metaPools[0].address.toLowerCase())
  volume = get(metaPoolVolume, 'volume', '0')
  adminFee = get(metaPoolSwap, 'adminFee', '0')
  swapFee = get(metaPoolSwap, 'swapFee', '0')

  const metaPoolAPR = metaPoolTVL.eq(0) ? metaPoolTVL :
    new BigNumber(volume).times(new BigNumber(swapFee).times(new BigNumber(1e10).minus(adminFee))).times(365).div(1e20).div(metaPoolTVL)

  return { basePoolAPR, metaPoolAPR }
}

export class LibraSdk {

  provider: StaticJsonRpcProvider
  cache: Cache

  public tokens: {[key: string]: Token}
  public config: any
  public multiCallAddress: string
  public chainId: string;
  public rpcNode: string
  public graphql: string

  constructor(options: Options = {}) {
    const { chainId = '56', rpcNode } = options

    this.chainId = chainId
    if (!rpcNode) {
      this.rpcNode = (chainId == '56') ? 'https://bsc-dataseed.binance.org/' : 'https://data-seed-prebsc-2-s2.binance.org:8545/'
    } else {
      this.rpcNode = rpcNode
    }

    this.provider = new StaticJsonRpcProvider(rpcNode)
    this.cache = new Cache()
    this.config = require(`../json/${chainId}/config.json`)
    this.multiCallAddress = this.config.multiCall
    this.graphql = this.config.graphql

    const tokenMap: {[key: string]: Token} = {}
    const _tokens = require(`../json/${chainId}/tokenlist.json`).tokens
    _tokens.forEach((v: any) => tokenMap[v.symbol.toLowerCase()] = pick(v, ['address','decimals','symbol','name']))
    this.tokens = tokenMap
  }

  public getToken(symbol: string) {
    return this.tokens[symbol.toLowerCase()]
  }

  public async marketCap(withCache: boolean = true) {
    if (!withCache)
      return getMarketCap(this)

    const self = this
    return self.cache.remember('getMarketCap', async () => {
      return getMarketCap(self)
    })
  }

  public async tvl(withCache: boolean = true) {
    if (!withCache)
      return getTVL(this)

    const self = this
    return self.cache.remember('getTVL', async () => {
      return getTVL(self)
    })
  }

  public apr() {
    return getAPR(this)
  }
}
