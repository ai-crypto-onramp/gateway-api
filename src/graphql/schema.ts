export const typeDefs = `#graphql
  type User {
    userId: ID!
    email: String
    emailVerified: Boolean
    displayName: String
    locale: String
  }

  type KycStatus {
    userId: ID!
    status: String!
    referenceId: String
    updatedAt: String
    reasons: [String!]
  }

  type Me {
    user: User!
    kyc: KycStatus!
  }

  type Quote {
    quoteId: ID!
    baseCurrency: String!
    quoteCurrency: String!
    baseAmount: String!
    quoteAmount: String!
    rate: String!
    expiresAt: String!
    paymentMethod: String!
    fees: QuoteFees!
  }

  type QuoteFees {
    network: String!
    partner: String!
    total: String!
  }

  type Transaction {
    transactionId: ID!
    status: String!
    quoteId: String
    createdAt: String!
    updatedAt: String
    failureReason: String
    redirectUrl: String
    ledger: TransactionLedger
  }

  type TransactionLedger {
    debited: Boolean
    credited: Boolean
    txHash: String
  }

  type Pagination {
    cursor: String
    hasNext: Boolean!
    limit: Int!
  }

  type TransactionList {
    items: [Transaction!]!
    pagination: Pagination!
  }

  type Query {
    me: Me!
    kycStatus: KycStatus!
    transaction(id: ID!): Transaction
    transactions(limit: Int = 20, cursor: String): TransactionList!
  }

  input QuoteInput {
    baseCurrency: String!
    quoteCurrency: String!
    baseAmount: String!
    paymentMethod: String!
    lockWindowSeconds: Int
    partnerId: String
  }

  input InitiateTransactionInput {
    quoteId: String!
    paymentMethod: String!
    paymentInstrumentToken: String
    partnerId: String
  }

  type Mutation {
    createQuote(input: QuoteInput!): Quote!
    initiateTransaction(input: InitiateTransactionInput!, idempotencyKey: String!): Transaction!
    startKyc(flow: String, redirectUrl: String): KycStatus!
  }
`;