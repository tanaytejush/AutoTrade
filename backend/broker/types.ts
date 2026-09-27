export interface Quote {
  symbol: string;
  price: number;
  timestamp?: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  averagePrice?: number;
  marketValue?: number;
}

export interface Holding {
  symbol: string;
  securityId: string;
  quantity: number;
  averagePrice: number;
  currentPrice: number;
  pnl: number;
}

export interface HoldingsResult {
  holdings: Holding[];
  raw: unknown;
}

export interface Margin {
  currency: string;
  available: number;
  total?: number;
  intradayAvailable?: number;
  derivativeAvailable?: number;
  raw?: unknown;
}

export interface Broker {
  getQuote(symbol: string): Promise<Quote>;
  getHoldings(): Promise<HoldingsResult>;
  getPositions(): Promise<Position[]>;
  getMargin(): Promise<Margin>;
}

export class BrokerError extends Error {
  constructor(
    message: string,
    public readonly code: "AUTH_EXPIRED" | "RATE_LIMITED" | "MALFORMED_RESPONSE" | "REQUEST_FAILED",
    public readonly status?: number
  ) {
    super(message);
    this.name = "BrokerError";
  }
}
