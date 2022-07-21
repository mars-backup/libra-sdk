import { ApolloClient, HttpLink, DefaultOptions, InMemoryCache } from '@apollo/client/core'
import fetch from 'cross-fetch'

const defaultOptions: DefaultOptions = {
  watchQuery: {
    fetchPolicy: 'no-cache',
    errorPolicy: 'ignore',
  },
  query: {
    fetchPolicy: 'no-cache',
    errorPolicy: 'all',
  },
}

export function getClient(uri: string) {
  return new ApolloClient({
    link: new HttpLink({
      fetch,
      uri,
    }),
    cache: new InMemoryCache(),
    defaultOptions
  })
}