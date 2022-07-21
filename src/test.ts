import { LibraSdk } from "./index"

async function main() {

  const sdk = new LibraSdk({ chainId: '97' })
/*
  const mc = await sdk.marketCap()
  console.log(mc)

  const tvl = await sdk.tvl()
  console.log(tvl)
*/
  const { basePoolAPR, metaPoolAPR } = await sdk.apr()
  console.log(basePoolAPR.toString(10))
  console.log(metaPoolAPR.toString(10))
}

main()
