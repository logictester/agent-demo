import crypto from "crypto";
import axios from "axios";
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";
import { Ollama } from "@langchain/ollama";
import { dbQuery, getDbPool } from "./db.js";
import { createOperationApproval, getOperationApprovalById, verifyApprovedOperation, upsertUserByClaims } from "./delegation.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const STARTING_CASH = 100000;
const MAX_HISTORY_POINTS = 60;
const MAX_LOG_ENTRIES = 24;
const MAX_PULSE_POINTS = 72;
const USER_KEY_GUEST = "guest-demo";
const FINNHUB_BASE_URL = process.env.FINNHUB_BASE_URL || "https://finnhub.io/api/v1";
const FINNHUB_API_KEY = String(process.env.FINNHUB_API_KEY || "").trim();
const REFRESH_MS = Math.max(15_000, Number(process.env.STOCK_REFRESH_MS) || 15_000);
const WARMUP_REFRESH_MS = Math.max(15_000, Number(process.env.STOCK_WARMUP_REFRESH_MS) || 15_000);
const HISTORY_REFRESH_MS = Math.max(60_000, Number(process.env.STOCK_HISTORY_REFRESH_MS) || 5 * 60 * 1000);
const CANDLE_RESOLUTION = String(process.env.STOCK_CANDLE_RESOLUTION || "5").trim();
const HISTORY_LOOKBACK_SECONDS = Math.max(6 * 60 * 60, Number(process.env.STOCK_HISTORY_LOOKBACK_SECONDS) || 3 * 24 * 60 * 60);
const DAILY_HISTORY_DAYS = Math.max(14, Number(process.env.STOCK_DAILY_HISTORY_DAYS) || 45);
const AUTO_TRADE_EVALUATION_MS = Math.max(15_000, Number(process.env.STOCK_AI_EVALUATION_MS) || 20_000);
const TARGET_POSITION_COUNT = Math.max(3, Number(process.env.STOCK_TARGET_POSITION_COUNT) || 4);
const MAX_POSITION_NOTIONAL = Math.max(120, Number(process.env.STOCK_MAX_POSITION_NOTIONAL) || 650);
const MIN_POSITION_HOLD_MS = Math.max(60_000, Number(process.env.STOCK_MIN_HOLD_MS) || 8 * 60 * 1000);
const SYMBOL_TRADE_COOLDOWN_MS = Math.max(30_000, Number(process.env.STOCK_SYMBOL_TRADE_COOLDOWN_MS) || 5 * 60 * 1000);
const BUY_SIGNAL_MIN_TREND = Math.max(0.6, Number(process.env.STOCK_BUY_MIN_TREND_SCORE) || 1.2);
const BUY_SIGNAL_MIN_MOMENTUM = Math.max(0.1, Number(process.env.STOCK_BUY_MIN_MOMENTUM) || 0.35);
const PROFIT_LOCK_MIN_PCT = Math.max(0.5, Number(process.env.STOCK_PROFIT_LOCK_MIN_PCT) || 3);
const PROFIT_LOCK_STRONG_PCT = Math.max(PROFIT_LOCK_MIN_PCT, Number(process.env.STOCK_PROFIT_LOCK_STRONG_PCT) || 6.5);
const MAX_DRAWDOWN_PCT = Math.min(-0.5, Number(process.env.STOCK_MAX_DRAWDOWN_PCT) || -6);
const STOCK_REAUTH_THRESHOLD = Math.max(1, Number(process.env.STOCK_REAUTH_THRESHOLD) || 1000);
const STOCK_APPROVAL_THRESHOLD = Math.max(STOCK_REAUTH_THRESHOLD + 1, Number(process.env.STOCK_APPROVAL_THRESHOLD) || 5000);
const STOCK_APPROVAL_TTL_SECONDS = Math.max(60, Number(process.env.STOCK_APPROVAL_TTL_SECONDS) || 900);
const ollamaBaseUrl = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const ollamaModel = process.env.OLLAMA_MODEL || "llama3.1:8b";
const WATCHLIST = String(process.env.STOCK_SYMBOLS || "AAPL,MSFT,NVDA,AMZN,META")
  .split(",")
  .map((item) => item.trim().toUpperCase())
  .filter(Boolean)
  .slice(0, 8);

const SYMBOL_METADATA = {
  AAPL: { name: "Apple", sector: "Consumer Tech" },
  MSFT: { name: "Microsoft", sector: "Cloud" },
  NVDA: { name: "NVIDIA", sector: "AI Semis" },
  AMZN: { name: "Amazon", sector: "Commerce" },
  META: { name: "Meta", sector: "Platforms" },
  TSLA: { name: "Tesla", sector: "EV" },
  AMD: { name: "AMD", sector: "Chips" },
  GOOGL: { name: "Alphabet", sector: "Search" }
};

const marketState = new Map();
const portfolios = new Map();
const marketMeta = {
  provider: "finnhub",
  sourceLabel: "Finnhub",
  configured: Boolean(FINNHUB_API_KEY),
  isLive: false,
  status: FINNHUB_API_KEY ? "starting" : "needs_config",
  message: FINNHUB_API_KEY
    ? "Connecting to Finnhub for stock data."
    : "Add FINNHUB_API_KEY in backend/.env to load stock data.",
  lastUpdatedAt: null,
  lastError: null
};

let refreshIntervalHandle = null;
let refreshInFlight = false;
let refreshCursor = 0;
let nextRefreshAt = 0;
let nextHistoryRefreshAt = 0;
let stockSchemaReady = null;
let candleAccessBlocked = false;
const stockDecisionModel = new Ollama({
  baseUrl: ollamaBaseUrl,
  model: ollamaModel,
  temperature: 0
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundMoney(value) {
  return Number(Number(value || 0).toFixed(2));
}

function roundNumber(value, decimals = 2) {
  return Number(Number(value || 0).toFixed(decimals));
}

function makeId(prefix) {
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

function signedPercent(value) {
  const amount = roundNumber(value, 2);
  return amount > 0 ? `+${amount}%` : `${amount}%`;
}

function currentTimestamp() {
  return new Date().toISOString();
}

function timestampMs(value) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function createPlaceholderTicker(symbol) {
  const metadata = SYMBOL_METADATA[symbol] || {};
  return {
    symbol,
    name: metadata.name || symbol,
    sector: metadata.sector || "Equity",
    price: 0,
    openPrice: 0,
    previousClose: 0,
    dayHigh: 0,
    dayLow: 0,
    volume: null,
    momentum: 0,
    trendScore: 0,
    signal: "hold",
    history: [],
    lastUpdatedAt: null
  };
}

async function ensureStockSchema() {
  if (!getDbPool()) {
    return;
  }

  if (!stockSchemaReady) {
    stockSchemaReady = (async () => {
      await dbQuery(`
        CREATE TABLE IF NOT EXISTS stock_portfolios (
          user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          auto_trading_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          cash NUMERIC(14,2) NOT NULL DEFAULT 100000.00,
          positions JSONB NOT NULL DEFAULT '{}'::jsonb,
          trade_history JSONB NOT NULL DEFAULT '[]'::jsonb,
          agent_log JSONB NOT NULL DEFAULT '[]'::jsonb,
          pending_trade JSONB,
          pulse_history JSONB NOT NULL DEFAULT '[]'::jsonb,
          last_decision_at BIGINT NOT NULL DEFAULT 0,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((error) => {
      stockSchemaReady = null;
      throw error;
    });
  }

  await stockSchemaReady;
}

function safeJsonObject(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function safeJsonArray(value) {
  if (Array.isArray(value)) {
    return value;
  }
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function ensureMarketSeed() {
  for (const symbol of WATCHLIST) {
    if (!marketState.has(symbol)) {
      marketState.set(symbol, createPlaceholderTicker(symbol));
    }
  }
}

function normalizeBatchPayload(payload, symbols) {
  if (!payload || typeof payload !== "object") {
    return {};
  }

  if (symbols.length === 1 && !payload[symbols[0]] && (payload.symbol || payload.meta || payload.values)) {
    return { [symbols[0]]: payload };
  }

  return payload;
}

function assertNoProviderError(payload, label) {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const note = String(payload.Note || payload.Information || payload["Error Message"] || payload.error || "").trim();
    if (note) {
      throw new Error(note);
    }
  }

  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    String(payload.status || "").toLowerCase() === "error"
  ) {
    throw new Error(payload.message || `${label} failed`);
  }

  if (
    payload &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    Number(payload.code) >= 400
  ) {
    throw new Error(payload.message || `${label} failed`);
  }

  return payload;
}

function parseFinnhubCandles(payload) {
  if (!payload || typeof payload !== "object" || payload.s !== "ok") {
    return [];
  }

  const opens = Array.isArray(payload.o) ? payload.o : [];
  const highs = Array.isArray(payload.h) ? payload.h : [];
  const lows = Array.isArray(payload.l) ? payload.l : [];
  const closes = Array.isArray(payload.c) ? payload.c : [];
  const volumes = Array.isArray(payload.v) ? payload.v : [];
  const timestamps = Array.isArray(payload.t) ? payload.t : [];

  return timestamps
    .map((stamp, index) => ({
      at: new Date(Number(stamp) * 1000).toISOString(),
      open: roundMoney(toNumber(opens[index])),
      high: roundMoney(toNumber(highs[index])),
      low: roundMoney(toNumber(lows[index])),
      price: roundMoney(toNumber(closes[index])),
      volume: Math.floor(toNumber(volumes[index]))
    }))
    .filter((item) => item.price > 0)
    .slice(-MAX_HISTORY_POINTS);
}

function computeTrend(history) {
  const recent = history.slice(-6);
  const medium = history.slice(-12);
  const latest = recent.at(-1)?.price || 0;
  const shortBase = recent[0]?.price || latest || 1;
  const mediumBase = medium[0]?.price || latest || 1;
  const shortMove = ((latest - shortBase) / shortBase) * 100;
  const mediumMove = ((latest - mediumBase) / mediumBase) * 100;
  const trendScore = roundNumber(shortMove * 0.65 + mediumMove * 0.35, 2);
  return {
    momentum: roundNumber(shortMove, 2),
    trendScore,
    signal: trendScore >= 1.9 ? "buy" : trendScore <= -1.4 ? "sell" : "hold"
  };
}

function computeQuoteFallbackTrend(quotePayload, current = {}) {
  const previousClose = roundMoney(toNumber(quotePayload?.pc, current.previousClose || current.price));
  const openPrice = roundMoney(toNumber(quotePayload?.o, current.openPrice || previousClose));
  const dayHigh = roundMoney(toNumber(quotePayload?.h, current.dayHigh || openPrice || previousClose));
  const dayLow = roundMoney(toNumber(quotePayload?.l, current.dayLow || openPrice || previousClose));
  const price = roundMoney(toNumber(quotePayload?.c, current.price || previousClose));
  const changePct = previousClose > 0 ? ((price - previousClose) / previousClose) * 100 : 0;
  const intradayPct = openPrice > 0 ? ((price - openPrice) / openPrice) * 100 : changePct;
  const rangePct = previousClose > 0 ? ((dayHigh - dayLow) / previousClose) * 100 : 0;
  const trendScore = roundNumber((changePct * 0.7) + (intradayPct * 0.3), 2);
  return {
    momentum: roundNumber(intradayPct, 2),
    trendScore,
    signal: trendScore >= 1.2 ? "buy" : trendScore <= -1.2 ? "sell" : "hold",
    rangePct: roundNumber(rangePct, 2)
  };
}

function buildQuoteFallbackHistory(quotePayload, current = {}) {
  const previousClose = roundMoney(toNumber(quotePayload?.pc, current.previousClose || current.price));
  const openPrice = roundMoney(toNumber(quotePayload?.o, current.openPrice || previousClose));
  const dayHigh = roundMoney(toNumber(quotePayload?.h, current.dayHigh || openPrice || previousClose));
  const dayLow = roundMoney(toNumber(quotePayload?.l, current.dayLow || openPrice || previousClose));
  const price = roundMoney(toNumber(quotePayload?.c, current.price || previousClose));
  const points = [
    { at: "prev-close", price: previousClose },
    { at: "open", price: openPrice },
    { at: "low", price: dayLow },
    { at: "high", price: dayHigh },
    { at: "current", price }
  ].filter((point) => point.price > 0);

  const deduped = [];
  for (const point of points) {
    if (!deduped.length || point.price !== deduped[deduped.length - 1].price || point.at === "current") {
      deduped.push(point);
    }
  }
  return deduped;
}

function pushAgentLog(portfolio, entry) {
  portfolio.agentLog = [entry, ...portfolio.agentLog].slice(0, MAX_LOG_ENTRIES);
  portfolio.needsPersistence = true;
}

function pushTrade(portfolio, trade) {
  portfolio.tradeHistory = [trade, ...portfolio.tradeHistory].slice(0, MAX_LOG_ENTRIES);
  portfolio.needsPersistence = true;
}

function getUserKey(userSub) {
  return String(userSub || USER_KEY_GUEST).trim() || USER_KEY_GUEST;
}

function ensurePortfolio(userSub) {
  const userKey = getUserKey(userSub);
  if (!portfolios.has(userKey)) {
    portfolios.set(userKey, {
      userKey,
      userSub: userSub || null,
      userId: null,
      autoTradingEnabled: true,
      cash: STARTING_CASH,
      positions: {},
      tradeHistory: [],
      pendingTrade: null,
      pulseHistory: [],
      lastDecisionAt: 0,
      lastPulseAt: 0,
      needsPersistence: false,
      agentLog: [
        {
          id: makeId("boot"),
          at: currentTimestamp(),
          type: "system",
          title: "Trading Agent initialized",
          detail: "Watching real market symbols and waiting for the next trend signal."
        }
      ]
    });
  }
  const portfolio = portfolios.get(userKey);
  if (userSub && !portfolio.userSub) {
    portfolio.userSub = userSub;
  }
  return portfolio;
}

function normalizeStoredPositionMap(value) {
  const raw = safeJsonObject(value);
  return Object.entries(raw).reduce((acc, [symbol, position]) => {
    if (!position || typeof position !== "object") {
      return acc;
    }
    acc[symbol] = {
      symbol,
      shares: Math.max(0, Math.floor(Number(position.shares) || 0)),
      avgCost: roundMoney(position.avgCost),
      openedAt: position.openedAt || null,
      lastBoughtAt: position.lastBoughtAt || null,
      lastSoldAt: position.lastSoldAt || null
    };
    return acc;
  }, {});
}

async function getPortfolio(userSub) {
  const portfolio = ensurePortfolio(userSub);
  if (!userSub || !getDbPool() || portfolio.loadedFromDb) {
    return portfolio;
  }

  await ensureStockSchema();
  const user = await upsertUserByClaims({ sub: userSub });
  if (!user?.id) {
    portfolio.loadedFromDb = true;
    return portfolio;
  }

  portfolio.userId = user.id;
  const result = await dbQuery(
    `
      SELECT auto_trading_enabled, cash, positions, trade_history, agent_log, pending_trade, pulse_history, last_decision_at
      FROM stock_portfolios
      WHERE user_id = $1
      LIMIT 1
    `,
    [user.id]
  );

  if (result.rows.length) {
    const row = result.rows[0];
    portfolio.autoTradingEnabled = Boolean(row.auto_trading_enabled);
    portfolio.cash = roundMoney(row.cash);
    portfolio.positions = normalizeStoredPositionMap(row.positions);
    portfolio.tradeHistory = safeJsonArray(row.trade_history).slice(0, MAX_LOG_ENTRIES);
    portfolio.agentLog = safeJsonArray(row.agent_log).slice(0, MAX_LOG_ENTRIES);
    portfolio.pendingTrade = row.pending_trade && typeof row.pending_trade === "object" ? row.pending_trade : null;
    portfolio.pulseHistory = safeJsonArray(row.pulse_history).slice(-MAX_PULSE_POINTS);
    portfolio.lastDecisionAt = Number(row.last_decision_at) || 0;
  } else {
    portfolio.needsPersistence = true;
    await savePortfolio(portfolio, { force: true });
  }

  portfolio.loadedFromDb = true;
  return portfolio;
}

async function savePortfolio(portfolio, options = {}) {
  if (!portfolio || !portfolio.userSub || !getDbPool()) {
    portfolio.needsPersistence = false;
    return;
  }
  if (!options.force && !portfolio.needsPersistence) {
    return;
  }

  await ensureStockSchema();
  const user = portfolio.userId
    ? { id: portfolio.userId }
    : await upsertUserByClaims({ sub: portfolio.userSub });
  if (!user?.id) {
    return;
  }

  portfolio.userId = user.id;
  await dbQuery(
    `
      INSERT INTO stock_portfolios (
        user_id, auto_trading_enabled, cash, positions, trade_history, agent_log, pending_trade, pulse_history, last_decision_at, updated_at
      )
      VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8::jsonb, $9, NOW())
      ON CONFLICT (user_id)
      DO UPDATE SET
        auto_trading_enabled = EXCLUDED.auto_trading_enabled,
        cash = EXCLUDED.cash,
        positions = EXCLUDED.positions,
        trade_history = EXCLUDED.trade_history,
        agent_log = EXCLUDED.agent_log,
        pending_trade = EXCLUDED.pending_trade,
        pulse_history = EXCLUDED.pulse_history,
        last_decision_at = EXCLUDED.last_decision_at,
        updated_at = NOW()
    `,
    [
      user.id,
      Boolean(portfolio.autoTradingEnabled),
      roundMoney(portfolio.cash),
      JSON.stringify(portfolio.positions || {}),
      JSON.stringify((portfolio.tradeHistory || []).slice(0, MAX_LOG_ENTRIES)),
      JSON.stringify((portfolio.agentLog || []).slice(0, MAX_LOG_ENTRIES)),
      JSON.stringify(portfolio.pendingTrade || null),
      JSON.stringify((portfolio.pulseHistory || []).slice(-MAX_PULSE_POINTS)),
      Number(portfolio.lastDecisionAt) || 0
    ]
  );

  portfolio.needsPersistence = false;
}

function summarizePortfolio(portfolio) {
  const positions = Object.values(portfolio.positions).map((position) => {
    const ticker = marketState.get(position.symbol);
    const price = ticker?.price || position.avgCost;
    const marketValue = roundMoney(price * position.shares);
    const costBasis = roundMoney(position.avgCost * position.shares);
    const unrealizedPnL = roundMoney(marketValue - costBasis);
    const unrealizedPnLPct = costBasis > 0 ? roundNumber((unrealizedPnL / costBasis) * 100, 2) : 0;
    return {
      symbol: position.symbol,
      shares: position.shares,
      avgCost: roundMoney(position.avgCost),
      price: roundMoney(price),
      marketValue,
      unrealizedPnL,
      unrealizedPnLPct,
      openedAt: position.openedAt || null
    };
  });

  const equity = roundMoney(positions.reduce((sum, item) => sum + item.marketValue, 0));
  const totalValue = roundMoney(portfolio.cash + equity);
  const dayPnl = roundMoney(
    positions.reduce((sum, item) => {
      const ticker = marketState.get(item.symbol);
      if (!ticker) {
        return sum;
      }
      return sum + (ticker.price - ticker.previousClose) * item.shares;
    }, 0)
  );

  return {
    autoTradingEnabled: portfolio.autoTradingEnabled,
    cash: roundMoney(portfolio.cash),
    equity,
    totalValue,
    dayPnl,
    positions: positions.sort((a, b) => b.marketValue - a.marketValue),
    tradeHistory: portfolio.tradeHistory,
    agentLog: portfolio.agentLog,
    pendingTrade: portfolio.pendingTrade,
    pulseHistory: Array.isArray(portfolio.pulseHistory) ? portfolio.pulseHistory.slice(-MAX_PULSE_POINTS) : []
  };
}

async function enrichPortfolioApprovalState(portfolioSummary, portfolio) {
  const pendingTrade = portfolioSummary?.pendingTrade;
  if (
    !pendingTrade ||
    pendingTrade.type !== "approval" ||
    !pendingTrade.approvalTicket ||
    !portfolio?.userSub
  ) {
    return portfolioSummary;
  }

  const approval = await getOperationApprovalById(pendingTrade.approvalTicket);
  if (!approval || approval.sub !== portfolio.userSub) {
    return portfolioSummary;
  }

  return {
    ...portfolioSummary,
    pendingTrade: {
      ...pendingTrade,
      approvalStatus: approval.status || "pending",
      approvalResolvedAt: approval.resolvedAt || null
    }
  };
}

function getHeldShares(portfolio, symbol) {
  return Math.max(0, Number(portfolio.positions?.[symbol]?.shares) || 0);
}

function normalizeTradeQuantity(portfolio, action, symbol, requestedShares) {
  const quantity = Math.max(1, Math.floor(Number(requestedShares) || 0));
  if (action !== "sell") {
    return quantity;
  }

  const heldShares = getHeldShares(portfolio, symbol);
  return Math.min(quantity, heldShares);
}

function describeTradeBlock(action, symbol, requestedShares, heldShares) {
  if (action === "sell") {
    if (!heldShares) {
      return `Cannot sell ${symbol}: the portfolio does not currently hold that stock.`;
    }
    return `Cannot sell ${requestedShares} ${symbol} shares: only ${heldShares} share${heldShares === 1 ? "" : "s"} are available.`;
  }
  return `Cannot ${action} ${symbol}: portfolio limits blocked the trade.`;
}

function executeTrade(portfolio, side, ticker, shares, reason, confidence) {
  const quantity = Math.max(1, Math.floor(shares));
  const notional = roundMoney(quantity * ticker.price);
  const tradeAt = currentTimestamp();
  if (!ticker.price) {
    return false;
  }
  if (side === "buy" && portfolio.cash < notional) {
    return false;
  }

  const currentPosition = portfolio.positions[ticker.symbol] || {
    symbol: ticker.symbol,
    shares: 0,
    avgCost: 0
  };

  if (side === "sell" && currentPosition.shares < quantity) {
    return false;
  }

  if (side === "buy") {
    const newShares = currentPosition.shares + quantity;
    const blendedCost =
      newShares > 0
        ? ((currentPosition.avgCost * currentPosition.shares) + notional) / newShares
        : ticker.price;
    portfolio.positions[ticker.symbol] = {
      symbol: ticker.symbol,
      shares: newShares,
      avgCost: roundMoney(blendedCost),
      openedAt: currentPosition.openedAt || tradeAt,
      lastBoughtAt: tradeAt,
      lastSoldAt: currentPosition.lastSoldAt || null
    };
    portfolio.cash = roundMoney(portfolio.cash - notional);
  } else {
    const newShares = currentPosition.shares - quantity;
    if (newShares <= 0) {
      delete portfolio.positions[ticker.symbol];
    } else {
      portfolio.positions[ticker.symbol] = {
        ...currentPosition,
        shares: newShares,
        lastSoldAt: tradeAt
      };
    }
    portfolio.cash = roundMoney(portfolio.cash + notional);
  }

  const trade = {
    id: makeId("trade"),
    at: tradeAt,
    symbol: ticker.symbol,
    side,
    shares: quantity,
    price: roundMoney(ticker.price),
    notional,
    confidence: roundNumber(confidence, 2),
    reason
  };

  pushTrade(portfolio, trade);
  pushAgentLog(portfolio, {
    id: makeId("log"),
    at: trade.at,
    type: side,
    title: `${side === "buy" ? "Opened" : "Trimmed"} ${ticker.symbol} position`,
    detail: `${side.toUpperCase()} ${quantity} shares at $${trade.price}. ${reason}`
  });
  return true;
}

function maybeAutoTrade(portfolio) {
  if (!portfolio.autoTradingEnabled) {
    return;
  }

  const tickers = Array.from(marketState.values())
    .filter((ticker) => ticker.price > 0)
    .sort((a, b) => b.trendScore - a.trendScore);
  const leaders = tickers.filter((ticker) => isPositiveBuySetup({
    ...ticker,
    changePct: ticker.previousClose ? roundNumber(((ticker.price - ticker.previousClose) / ticker.previousClose) * 100, 2) : 0
  })).slice(0, 3);
  const trimCandidates = Object.values(portfolio.positions)
    .filter((position) => canSellPosition(portfolio, position.symbol))
    .map((position) => ({
      position,
      ticker: marketState.get(position.symbol),
      sellCheck: shouldSellPosition(portfolio, position.symbol)
    }))
    .filter((item) => item.sellCheck.ok)
    .sort((a, b) => {
      const aProfit = getPositionProfitPct(portfolio, a.position.symbol);
      const bProfit = getPositionProfitPct(portfolio, b.position.symbol);
      return aProfit - bProfit;
    })
    .slice(0, 2);

  for (const ticker of leaders) {
    const currentPosition = portfolio.positions[ticker.symbol];
    const exposure = currentPosition ? currentPosition.shares * ticker.price : 0;
    const confidence = clamp(ticker.trendScore / 4.5, 0.2, 1);
    if (exposure > 18000 || portfolio.cash < 2500) {
      continue;
    }
    const shares = Math.max(1, Math.round((2200 + confidence * 1800) / ticker.price));
    if (executeTrade(portfolio, "buy", ticker, shares, `Momentum ${signedPercent(ticker.momentum)} with trend score ${ticker.trendScore}.`, confidence)) {
      break;
    }
  }

  for (const item of trimCandidates) {
    const currentPosition = item.position;
    const ticker = item.ticker;
    if (!currentPosition?.shares || !ticker?.price) {
      continue;
    }
    const shares = Math.max(1, Math.ceil(currentPosition.shares / 2));
    executeTrade(
      portfolio,
      "sell",
      ticker,
      shares,
      item.sellCheck.reason,
      clamp(Math.abs(ticker.trendScore) / 4.5, 0.2, 1)
    );
  }
}

function portfolioExposure(portfolio) {
  return Object.values(portfolio.positions).reduce((sum, item) => {
    const ticker = marketState.get(item.symbol);
    return sum + (ticker?.price || 0) * item.shares;
  }, 0);
}

function getRecentTrade(portfolio, symbol) {
  return portfolio.tradeHistory.find((trade) => trade.symbol === symbol) || null;
}

function getHeldSymbols(portfolio) {
  return Object.values(portfolio.positions)
    .filter((position) => Number(position.shares) > 0)
    .map((position) => position.symbol);
}

function getPositionAgeMs(position) {
  return Math.max(0, Date.now() - timestampMs(position?.openedAt));
}

function canSellPosition(portfolio, symbol) {
  const position = portfolio.positions?.[symbol];
  if (!position?.shares) {
    return false;
  }

  if (getPositionAgeMs(position) < MIN_POSITION_HOLD_MS) {
    return false;
  }

  const recentTrade = getRecentTrade(portfolio, symbol);
  if (recentTrade && Date.now() - timestampMs(recentTrade.at) < SYMBOL_TRADE_COOLDOWN_MS) {
    return false;
  }

  return true;
}

function canBuySymbol(portfolio, symbol) {
  const recentTrade = getRecentTrade(portfolio, symbol);
  if (recentTrade && Date.now() - timestampMs(recentTrade.at) < SYMBOL_TRADE_COOLDOWN_MS) {
    return false;
  }

  const position = portfolio.positions?.[symbol];
  if (!position?.shares) {
    return true;
  }

  const ticker = marketState.get(symbol);
  const exposure = (ticker?.price || 0) * position.shares;
  return exposure < MAX_POSITION_NOTIONAL;
}

function getPositionProfitPct(portfolio, symbol) {
  const position = portfolio.positions?.[symbol];
  const ticker = marketState.get(symbol);
  if (!position?.shares || !ticker?.price || !position.avgCost) {
    return 0;
  }
  return roundNumber(((ticker.price - position.avgCost) / position.avgCost) * 100, 2);
}

function isPositiveBuySetup(ticker) {
  if (!ticker?.price) {
    return false;
  }

  return (
    ticker.signal === "buy" &&
    Number(ticker.trendScore || 0) >= BUY_SIGNAL_MIN_TREND &&
    Number(ticker.momentum || 0) >= BUY_SIGNAL_MIN_MOMENTUM &&
    Number(ticker.changePct || 0) >= 0
  );
}

function shouldSellPosition(portfolio, symbol) {
  const ticker = marketState.get(symbol);
  const profitPct = getPositionProfitPct(portfolio, symbol);
  if (!ticker?.price) {
    return { ok: false, reason: "No live quote available." };
  }

  if (profitPct <= MAX_DRAWDOWN_PCT) {
    return {
      ok: true,
      reason: `Cutting risk after a ${profitPct}% drawdown.`
    };
  }

  if (profitPct >= PROFIT_LOCK_STRONG_PCT) {
    return {
      ok: true,
      reason: `Locking gains after a ${profitPct}% run.`
    };
  }

  if (
    profitPct >= PROFIT_LOCK_MIN_PCT &&
    (Number(ticker.trendScore || 0) <= -0.75 || Number(ticker.momentum || 0) <= -0.3)
  ) {
    return {
      ok: true,
      reason: `Protecting gains as momentum fades with ${profitPct}% profit still intact.`
    };
  }

  return {
    ok: false,
    reason: "Holding to avoid selling into ordinary weakness without enough profit cushion."
  };
}

function buildDeterministicDecision(portfolio, watchlist) {
  const candidates = watchlist
    .filter((ticker) => ticker.price > 0)
    .sort((a, b) => {
      if ((b.trendScore || 0) !== (a.trendScore || 0)) {
        return (b.trendScore || 0) - (a.trendScore || 0);
      }
      return (b.momentum || 0) - (a.momentum || 0);
    });
  const heldSymbols = new Set(getHeldSymbols(portfolio));
  const heldPositions = Object.values(portfolio.positions)
    .filter((position) => position.shares > 0)
    .map((position) => {
      const ticker = marketState.get(position.symbol);
      const profitPct = getPositionProfitPct(portfolio, position.symbol);
      return {
        position,
        ticker,
        profitPct
      };
    });

  if (heldPositions.length < TARGET_POSITION_COUNT) {
    const newIdea = candidates.find((ticker) => (
      !heldSymbols.has(ticker.symbol) &&
      canBuySymbol(portfolio, ticker.symbol) &&
      isPositiveBuySetup(ticker)
    ));
    if (newIdea) {
      return {
        action: "buy",
        symbol: newIdea.symbol,
        budget: Math.min(STOCK_REAUTH_THRESHOLD - 5, Math.max(55, roundMoney(65 + Math.max(0, newIdea.trendScore) * 12))),
        confidence: clamp(0.58 + Math.max(0, newIdea.trendScore) / 8, 0.45, 0.86),
        reason: `Building breadth with ${newIdea.symbol}; momentum is ${signedPercent(newIdea.momentum)} and trend score is ${newIdea.trendScore}.`
      };
    }
  }

  const addOnIdea = candidates.find((ticker) => canBuySymbol(portfolio, ticker.symbol) && isPositiveBuySetup(ticker));
  if (addOnIdea && portfolio.cash > addOnIdea.price * 2) {
    return {
      action: "buy",
      symbol: addOnIdea.symbol,
      budget: Math.min(STOCK_REAUTH_THRESHOLD - 5, Math.max(45, roundMoney(52 + Math.max(0, addOnIdea.trendScore) * 10))),
      confidence: clamp(0.55 + Math.max(0, addOnIdea.trendScore) / 9, 0.42, 0.82),
      reason: `Adding exposure to ${addOnIdea.symbol} on sustained momentum (${signedPercent(addOnIdea.momentum)}).`
    };
  }

  const trimIdea = heldPositions
    .filter(({ position }) => canSellPosition(portfolio, position.symbol))
    .sort((a, b) => {
      if ((a.ticker?.trendScore || 0) !== (b.ticker?.trendScore || 0)) {
        return (a.ticker?.trendScore || 0) - (b.ticker?.trendScore || 0);
      }
      return a.profitPct - b.profitPct;
    })[0];

  const trimDecision = trimIdea ? shouldSellPosition(portfolio, trimIdea.position.symbol) : null;
  if (trimIdea && trimDecision?.ok) {
    const sellNotional = Math.min(STOCK_REAUTH_THRESHOLD - 5, Math.max(45, roundMoney((trimIdea.ticker?.price || 0) * Math.max(1, Math.ceil(trimIdea.position.shares / 3)))));
    return {
      action: "sell",
      symbol: trimIdea.position.symbol,
      budget: sellNotional,
      confidence: clamp(0.6 + Math.abs(trimIdea.ticker?.trendScore || 0) / 8, 0.48, 0.84),
      reason: trimDecision.reason
    };
  }

  return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: "Holding current allocation while the portfolio settles." };
}

function normalizeAutonomousDecision(portfolio, decision) {
  if (!decision || !decision.symbol || !["buy", "sell", "hold"].includes(decision.action)) {
    return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: "No valid trade idea." };
  }

  const ticker = marketState.get(decision.symbol);
  if (decision.action === "sell" && !canSellPosition(portfolio, decision.symbol)) {
    return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: `Waiting before trimming ${decision.symbol}; the holding is still in its cooldown window.` };
  }

  if (decision.action === "sell") {
    const sellCheck = shouldSellPosition(portfolio, decision.symbol);
    if (!sellCheck.ok) {
      return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: sellCheck.reason };
    }
  }

  if (decision.action === "buy" && !canBuySymbol(portfolio, decision.symbol)) {
    return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: `Skipping ${decision.symbol}; the position was just traded or is already sized up.` };
  }

  if (decision.action === "buy" && !isPositiveBuySetup({ ...ticker, changePct: ticker?.previousClose ? roundNumber(((ticker.price - ticker.previousClose) / ticker.previousClose) * 100, 2) : 0 })) {
    return { action: "hold", symbol: "", budget: 0, confidence: 0.5, reason: `Skipping ${decision.symbol}; the setup is not positive enough to justify a new buy.` };
  }

  return {
    ...decision,
    budget: Math.min(MAX_POSITION_NOTIONAL, Math.max(0, roundMoney(decision.budget)))
  };
}

function extractJsonObject(text) {
  const source = String(text || "").trim();
  if (!source) {
    return "";
  }
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  const start = source.indexOf("{");
  const end = source.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return source.slice(start, end + 1);
  }
  return "";
}

function parseStockDecision(rawText) {
  const jsonText = extractJsonObject(rawText);
  if (!jsonText) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonText);
    const action = String(parsed?.action || "").toLowerCase();
    if (!["buy", "sell", "hold"].includes(action)) {
      return null;
    }
    const symbol = String(parsed?.symbol || "").toUpperCase();
    const budget = roundMoney(Number(parsed?.budget) || 0);
    const confidence = clamp(Number(parsed?.confidence) || 0.5, 0, 1);
    const reason = String(parsed?.reason || "").trim() || "No reason provided.";
    return { action, symbol, budget, confidence, reason };
  } catch {
    return null;
  }
}

async function decideTradeWithLlama(portfolio) {
  const watchlist = buildMarketSnapshot().watchlist.slice(0, 5).map((ticker) => ({
    symbol: ticker.symbol,
    price: ticker.price,
    changePct: ticker.changePct,
    momentum: ticker.momentum,
    trendScore: ticker.trendScore,
    signal: ticker.signal
  }));
  const holdings = Object.values(portfolio.positions).map((position) => ({
    symbol: position.symbol,
    shares: position.shares,
    avgCost: roundMoney(position.avgCost)
  }));

  const prompt = `You are an autonomous stock paper-trading broker.
Return JSON only with this exact schema:
{"action":"buy|sell|hold","symbol":"AAPL","budget":120,"confidence":0.72,"reason":"short explanation"}

Rules:
1) Use only these symbols: ${WATCHLIST.join(", ")}.
2) Budget means target notional in USD for the trade.
3) Prefer visible moves. Typical autonomous budget should be between 45 and ${Math.min(STOCK_REAUTH_THRESHOLD - 5, 95)}.
4) If no compelling move exists, return hold with budget 0.
5) Favor stronger trend scores and momentum for buys, weak momentum or profit protection for sells.
6) Only choose "sell" for symbols that already exist in holdings with shares > 0.
7) Prefer building a portfolio of about ${TARGET_POSITION_COUNT} names before aggressively trimming.
8) Do not rotate in and out of the same symbol repeatedly. Avoid symbols traded in the last ${Math.round(SYMBOL_TRADE_COOLDOWN_MS / 60000)} minutes.
9) Do not sell positions opened in the last ${Math.round(MIN_POSITION_HOLD_MS / 60000)} minutes.
10) Never buy symbols with negative momentum or a negative day change.
11) Prefer selling only to lock in gains or to stop a meaningful drawdown. Do not sell a mildly red position just because the latest candle is down.
12) Keep reasoning concise and factual.

Context:
${JSON.stringify(
    {
      cash: roundMoney(portfolio.cash),
      currentExposure: roundMoney(portfolioExposure(portfolio)),
      watchlist,
      holdings
    },
    null,
    2
  )}`;

  try {
    const raw = await stockDecisionModel.invoke(prompt);
    const parsed = parseStockDecision(raw);
    if (parsed) {
      return normalizeAutonomousDecision(portfolio, parsed);
    }
  } catch {
    // Fall through to deterministic fallback
  }

  return buildDeterministicDecision(portfolio, watchlist);
}

function createPendingTradePayload({ action, ticker, shares, notional, confidence, reason, requirement, approvalTicket = null }) {
  return {
    id: makeId("pending_stock"),
    type: requirement,
    action,
    symbol: ticker.symbol,
    shares,
    price: roundMoney(ticker.price),
    notional,
    confidence: roundNumber(confidence, 2),
    reason,
    approvalTicket,
    createdAt: currentTimestamp()
  };
}

function clearPendingTrade(portfolio) {
  portfolio.pendingTrade = null;
  portfolio.needsPersistence = true;
}

function setPendingTrade(portfolio, pendingTrade) {
  portfolio.pendingTrade = pendingTrade;
  portfolio.needsPersistence = true;
}

function recordPortfolioPulse(portfolio) {
  const now = Date.now();
  if (now - Number(portfolio.lastPulseAt || 0) < 60_000) {
    return;
  }

  const snapshot = summarizePortfolio(portfolio);
  const entry = {
    at: currentTimestamp(),
    value: roundMoney(snapshot.totalValue)
  };
  const history = Array.isArray(portfolio.pulseHistory) ? [...portfolio.pulseHistory] : [];
  history.push(entry);
  portfolio.pulseHistory = history.slice(-MAX_PULSE_POINTS);
  portfolio.lastPulseAt = now;
  portfolio.needsPersistence = true;
}

function reconcilePendingTrade(portfolio) {
  const pendingTrade = portfolio.pendingTrade;
  if (!pendingTrade) {
    return null;
  }

  if (pendingTrade.action === "sell") {
    const heldShares = getHeldShares(portfolio, pendingTrade.symbol);
    if (heldShares < pendingTrade.shares) {
      pushAgentLog(portfolio, {
        id: makeId("log"),
        at: currentTimestamp(),
        type: "system",
        title: "Protected stock trade cleared",
        detail: describeTradeBlock("sell", pendingTrade.symbol, pendingTrade.shares, heldShares)
      });
      clearPendingTrade(portfolio);
      return null;
    }
  }

  return pendingTrade;
}

async function maybeExecutePendingTrade(portfolio, authorization = {}) {
  const pendingTrade = reconcilePendingTrade(portfolio);
  if (!pendingTrade) {
    return null;
  }

  const ticker = marketState.get(pendingTrade.symbol);
  if (!ticker?.price) {
    return null;
  }

  if (pendingTrade.type === "reauth" && !authorization.stepUpVerified) {
    return pendingTrade;
  }

  if (pendingTrade.type === "approval") {
    const approvalId = String(authorization.approvalTicket || pendingTrade.approvalTicket || "").trim();
    if (!approvalId || !portfolio.userSub) {
      return pendingTrade;
    }
    const verification = await verifyApprovedOperation(portfolio.userSub, approvalId, "stock_trade_approval");
    if (!verification.ok) {
      if (verification.reason === "approval_denied" || verification.reason === "approval_expired") {
        pushAgentLog(portfolio, {
          id: makeId("log"),
          at: currentTimestamp(),
          type: "system",
          title: "Protected stock trade cancelled",
          detail:
            verification.reason === "approval_denied"
              ? `Approval for ${pendingTrade.action.toUpperCase()} ${pendingTrade.symbol} was denied.`
              : `Approval for ${pendingTrade.action.toUpperCase()} ${pendingTrade.symbol} expired.`
        });
        clearPendingTrade(portfolio);
        return null;
      }
      return pendingTrade;
    }
  }

  const executed = executeTrade(
    portfolio,
    pendingTrade.action,
    ticker,
    pendingTrade.shares,
    `Protected stock trade completed after ${pendingTrade.type}. ${pendingTrade.reason}`,
    pendingTrade.confidence
  );
  if (executed) {
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Protected stock trade completed",
      detail: `${pendingTrade.action.toUpperCase()} ${pendingTrade.shares} ${pendingTrade.symbol} shares executed after ${pendingTrade.type}.`
    });
    clearPendingTrade(portfolio);
  } else {
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Protected stock trade failed",
      detail:
        pendingTrade.action === "sell"
          ? `Could not execute approved sell for ${pendingTrade.symbol}: portfolio does not hold enough shares.`
          : `Could not execute protected ${pendingTrade.action} for ${pendingTrade.symbol}: portfolio limits blocked it.`
    });
    clearPendingTrade(portfolio);
  }
  return null;
}

async function evaluateAutonomousTrade(portfolio, authorization = {}) {
  if (!portfolio.autoTradingEnabled || portfolio.pendingTrade) {
    return;
  }

  const now = Date.now();
  if (now - Number(portfolio.lastDecisionAt || 0) < AUTO_TRADE_EVALUATION_MS) {
    return;
  }
  portfolio.lastDecisionAt = now;

  const decision = await decideTradeWithLlama(portfolio);
  if (!decision || decision.action === "hold" || !decision.symbol) {
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Llama held position",
      detail: decision?.reason || "No compelling move."
    });
    return;
  }

  const ticker = marketState.get(decision.symbol);
  if (!ticker?.price) {
    return;
  }

  const shares = normalizeTradeQuantity(portfolio, decision.action, decision.symbol, (decision.budget || 0) / ticker.price);
  if (!shares) {
    if (decision.action === "sell") {
      pushAgentLog(portfolio, {
        id: makeId("log"),
        at: currentTimestamp(),
        type: "system",
        title: "Skipped impossible sell",
        detail: describeTradeBlock("sell", decision.symbol, 0, getHeldShares(portfolio, decision.symbol))
      });
    }
    return;
  }
  const notional = roundMoney(shares * ticker.price);
  const reason = `${decision.reason} Proposed by ${ollamaModel}.`;

  if (notional > STOCK_APPROVAL_THRESHOLD) {
    let approvalTicket = null;
    if (portfolio.userSub) {
      const approval = await createOperationApproval(portfolio.userSub, {
        approvalType: "stock_trade_approval",
        reason: `Approval required for ${decision.action} ${decision.symbol} stock trade.`,
        payload: {
          symbol: decision.symbol,
          shares,
          action: decision.action,
          notional
        },
        ttlSeconds: STOCK_APPROVAL_TTL_SECONDS
      });
      approvalTicket = approval?.id || null;
    }
    setPendingTrade(portfolio, createPendingTradePayload({
      action: decision.action,
      ticker,
      shares,
      notional,
      confidence: decision.confidence,
      reason,
      requirement: "approval",
      approvalTicket
    }));
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Approval required for stock trade",
      detail: `${decision.action.toUpperCase()} ${shares} ${decision.symbol} shares (${formatCurrencyLike(notional)}) needs approval.`
    });
    return;
  }

  if (notional > STOCK_REAUTH_THRESHOLD) {
    setPendingTrade(portfolio, createPendingTradePayload({
      action: decision.action,
      ticker,
      shares,
      notional,
      confidence: decision.confidence,
      reason,
      requirement: "reauth"
    }));
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Re-authentication required for stock trade",
      detail: `${decision.action.toUpperCase()} ${shares} ${decision.symbol} shares (${formatCurrencyLike(notional)}) requires re-authentication.`
    });
    return;
  }

  executeTrade(portfolio, decision.action, ticker, shares, reason, decision.confidence);
}

function formatCurrencyLike(amount) {
  return `$${Number(amount || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function fetchCandles(symbol, resolution, from, to) {
  const response = await axios.get(`${FINNHUB_BASE_URL}/stock/candle`, {
    params: {
      symbol,
      resolution,
      from,
      to,
      token: FINNHUB_API_KEY
    },
    timeout: 10_000
  });
  return assertNoProviderError(response.data, `Candle request for ${symbol}`);
}

async function fetchSymbolHistory(symbol) {
  const now = Math.floor(Date.now() / 1000);
  const intradayPayload = await fetchCandles(symbol, CANDLE_RESOLUTION, now - HISTORY_LOOKBACK_SECONDS, now);
  const intradaySeries = parseFinnhubCandles(intradayPayload);
  if (intradaySeries.length >= 2) {
    return intradayPayload;
  }

  return fetchCandles(symbol, "D", now - (DAILY_HISTORY_DAYS * 24 * 60 * 60), now);
}

async function fetchSymbolQuote(symbol) {
  const response = await axios.get(`${FINNHUB_BASE_URL}/quote`, {
    params: {
      symbol,
      token: FINNHUB_API_KEY
    },
    timeout: 10_000
  });
  return assertNoProviderError(response.data, `Quote request for ${symbol}`);
}

function upsertQuoteHistory(currentHistory, price, at) {
  const timestamp = at || currentTimestamp();
  const history = Array.isArray(currentHistory) ? [...currentHistory] : [];
  if (!price) {
    return history.slice(-MAX_HISTORY_POINTS);
  }

  if (history.length && history[history.length - 1]?.at === timestamp) {
    history[history.length - 1] = { at: timestamp, price };
    return history.slice(-MAX_HISTORY_POINTS);
  }

  history.push({ at: timestamp, price });
  return history.slice(-MAX_HISTORY_POINTS);
}

function mergeTickerSnapshot(symbol, quotePayload, historyPayload = null) {
  const current = marketState.get(symbol) || createPlaceholderTicker(symbol);
  const parsedSeries = parseFinnhubCandles(historyPayload);
  const candleHistory = parsedSeries.map((item) => ({ at: item.at, price: item.price }));
  const previousClose = roundMoney(toNumber(quotePayload?.pc, current.previousClose || current.price));
  const price = roundMoney(toNumber(quotePayload?.c, current.price));
  const openPrice = roundMoney(toNumber(quotePayload?.o, current.openPrice || price));
  const quoteTimestamp = Number(quotePayload?.t) > 0
    ? new Date(Number(quotePayload.t) * 1000).toISOString()
    : currentTimestamp();
  const nextHistory = candleHistory.length
    ? upsertQuoteHistory(candleHistory, price || candleHistory.at(-1)?.price || 0, quoteTimestamp)
    : candleAccessBlocked
      ? buildQuoteFallbackHistory(quotePayload, current)
      : upsertQuoteHistory(current.history, price, quoteTimestamp);
  const trend = nextHistory.length >= 4
    ? computeTrend(nextHistory)
    : computeQuoteFallbackTrend(quotePayload, current);

  return {
    ...current,
    symbol,
    name:
      SYMBOL_METADATA[symbol]?.name ||
      current.name,
    sector: current.sector,
    price,
    openPrice,
    previousClose,
    dayHigh: roundMoney(toNumber(quotePayload?.h, current.dayHigh || price)),
    dayLow: roundMoney(toNumber(quotePayload?.l, current.dayLow || price)),
    volume: parsedSeries.at(-1)?.volume != null
      ? Math.floor(parsedSeries.at(-1).volume)
      : current.volume ?? null,
    history: nextHistory,
    lastUpdatedAt: currentTimestamp(),
    ...trend
  };
}

function nextSymbolsToRefresh() {
  const missingSymbols = WATCHLIST.filter((symbol) => (marketState.get(symbol)?.price || 0) <= 0);
  if (missingSymbols.length) {
    return { symbols: missingSymbols, warmup: true };
  }

  const orderedSymbols = [];
  for (let index = 0; index < WATCHLIST.length; index += 1) {
    orderedSymbols.push(WATCHLIST[(refreshCursor + index) % WATCHLIST.length]);
  }
  refreshCursor = (refreshCursor + 1) % Math.max(1, WATCHLIST.length);
  return { symbols: orderedSymbols, warmup: false };
}

async function refreshMarketData(options = {}) {
  if (!FINNHUB_API_KEY || refreshInFlight) {
    return;
  }

  const now = Date.now();
  if (!options.force && nextRefreshAt && now < nextRefreshAt) {
    return;
  }

  refreshInFlight = true;
  try {
    ensureMarketSeed();
    const shouldRefreshHistory = options.force || !nextHistoryRefreshAt || now >= nextHistoryRefreshAt;
    const quotes = await Promise.all(
      WATCHLIST.map(async (symbol) => ({
        symbol,
        quote: await fetchSymbolQuote(symbol)
      }))
    );

    const historyPayloads = new Map();
    if (shouldRefreshHistory && !candleAccessBlocked) {
      const nextTarget = nextSymbolsToRefresh();
      for (const symbol of nextTarget.symbols) {
        try {
          const historyPayload = await fetchSymbolHistory(symbol);
          historyPayloads.set(symbol, historyPayload);
        } catch (error) {
          if (Number(error?.response?.status) === 403) {
            candleAccessBlocked = true;
          }
          marketMeta.lastError = error?.response?.data?.message || error?.message || "History refresh failed";
        }
      }
      nextHistoryRefreshAt = Date.now() + HISTORY_REFRESH_MS;
    }

    for (const { symbol, quote } of quotes) {
      const tickerHistory = historyPayloads.get(symbol) || null;
      marketState.set(symbol, mergeTickerSnapshot(symbol, quote, tickerHistory));
    }

    marketMeta.isLive = true;
    marketMeta.status = "ready";
    const loadedCount = Array.from(marketState.values()).filter((ticker) => ticker.price > 0).length;
    marketMeta.message = loadedCount < WATCHLIST.length
      ? `Loading watchlist ${loadedCount}/${WATCHLIST.length} from Finnhub quotes.`
      : candleAccessBlocked
        ? `Tracking ${WATCHLIST.join(", ")} with Finnhub live quotes. Intraday candle history is unavailable on the current plan, so charts build from quote snapshots over time.`
        : `Tracking ${WATCHLIST.join(", ")} with Finnhub quotes and intraday candles.`;
    marketMeta.lastUpdatedAt = currentTimestamp();
    marketMeta.lastError = null;
    nextRefreshAt = Date.now() + (loadedCount < WATCHLIST.length ? WARMUP_REFRESH_MS : REFRESH_MS);

    await Promise.all(
      Array.from(portfolios.values()).map(async (portfolio) => {
        await evaluateAutonomousTrade(portfolio, {});
        recordPortfolioPulse(portfolio);
        await savePortfolio(portfolio);
      })
    );
  } catch (error) {
    const statusCode = Number(error?.response?.status) || 0;
    const providerMessage = error?.response?.data?.error || error?.response?.data?.message || error?.message || "Unknown stock feed error";
    marketMeta.isLive = Array.from(marketState.values()).some((ticker) => ticker.price > 0);
    marketMeta.status = statusCode === 429 ? "rate_limited" : "error";
    marketMeta.message = statusCode === 429
      ? "Finnhub rate limit reached. Reusing the latest stock snapshot until the next refresh window."
      : "Finnhub market data is temporarily unavailable.";
    marketMeta.lastError = providerMessage;
    nextRefreshAt = Date.now() + WARMUP_REFRESH_MS;
  } finally {
    refreshInFlight = false;
  }
}

function buildMarketSnapshot() {
  const tickers = Array.from(marketState.values()).map((ticker) => {
    const change = roundMoney(ticker.price - ticker.previousClose);
    const changePct = ticker.previousClose
      ? roundNumber((change / ticker.previousClose) * 100, 2)
      : 0;
    return {
      symbol: ticker.symbol,
      name: ticker.name,
      sector: ticker.sector,
      price: roundMoney(ticker.price),
      change,
      changePct,
      openPrice: roundMoney(ticker.openPrice),
      dayHigh: roundMoney(ticker.dayHigh),
      dayLow: roundMoney(ticker.dayLow),
      volume: ticker.volume,
      momentum: ticker.momentum,
      trendScore: ticker.trendScore,
      signal: ticker.signal,
      history: ticker.history
    };
  });

  const populated = tickers.filter((ticker) => ticker.price > 0);
  const advancers = populated.filter((ticker) => ticker.changePct >= 0).length;
  const decliners = Math.max(0, populated.length - advancers);
  const strongest = [...populated].sort((a, b) => b.changePct - a.changePct).slice(0, 3);
  const weakest = [...populated].sort((a, b) => a.changePct - b.changePct).slice(0, 3);
  const sentiment = populated.length
    ? roundNumber(populated.reduce((sum, ticker) => sum + ticker.trendScore, 0) / populated.length, 2)
    : 0;

  return {
    updatedAt: marketMeta.lastUpdatedAt,
    sentiment,
    breadth: {
      advancers,
      decliners,
      ratio: populated.length ? roundNumber(advancers / populated.length, 2) : 0
    },
    strongest,
    weakest,
    watchlist: populated,
    source: marketMeta.provider,
    sourceLabel: marketMeta.sourceLabel,
    isLive: marketMeta.isLive,
    status: marketMeta.status,
    statusMessage: marketMeta.message,
    error: marketMeta.lastError
  };
}

function parseAgentMessage(message) {
  const text = String(message || "").trim();
  const normalized = text.toLowerCase();
  if (!normalized) {
    return { action: "empty" };
  }
  if (normalized.includes("pause")) {
    return { action: "pause" };
  }
  if (normalized.includes("resume") || normalized.includes("start")) {
    return { action: "resume" };
  }
  const symbolFirstTradeMatch = normalized.match(/\b(buy|sell)\s+([a-z]{1,5})(?:\s+(\d+))?\b/i);
  if (symbolFirstTradeMatch) {
    return {
      action: String(symbolFirstTradeMatch[1]).toLowerCase(),
      symbol: String(symbolFirstTradeMatch[2]).toUpperCase(),
      shares: Number(symbolFirstTradeMatch[3]) || 1
    };
  }
  const quantityFirstTradeMatch = normalized.match(/\b(buy|sell)\s+(\d+)\s+([a-z]{1,5})\b/i);
  if (quantityFirstTradeMatch) {
    return {
      action: String(quantityFirstTradeMatch[1]).toLowerCase(),
      symbol: String(quantityFirstTradeMatch[3]).toUpperCase(),
      shares: Number(quantityFirstTradeMatch[2]) || 1
    };
  }
  const focusMatch = normalized.match(/\b(?:focus on|watch|prioritize)\s+([a-z]{1,5})\b/i);
  if (focusMatch) {
    return {
      action: "focus",
      symbol: String(focusMatch[1]).toUpperCase()
    };
  }
  return { action: "summary" };
}

export async function getStockDashboard(userSub, authorization = {}) {
  const portfolio = await getPortfolio(userSub);
  const currentWatchlistCount = buildMarketSnapshot().watchlist.length;
  if (
    FINNHUB_API_KEY &&
    !refreshInFlight &&
    (!marketMeta.lastUpdatedAt || currentWatchlistCount < WATCHLIST.length)
  ) {
    await refreshMarketData({ force: !marketMeta.lastUpdatedAt });
  } else if (!FINNHUB_API_KEY) {
    ensureMarketSeed();
  }

  await maybeExecutePendingTrade(portfolio, authorization);
  await evaluateAutonomousTrade(portfolio, authorization);
  recordPortfolioPulse(portfolio);
  await savePortfolio(portfolio);

  const portfolioSummary = await enrichPortfolioApprovalState(summarizePortfolio(portfolio), portfolio);

  return {
    market: buildMarketSnapshot(),
    portfolio: portfolioSummary
  };
}

export async function handleStockAgentMessage(userSub, message, authorization = {}) {
  const portfolio = await getPortfolio(userSub);
  const parsed = parseAgentMessage(message);

  await maybeExecutePendingTrade(portfolio, authorization);

  if (parsed.action === "pause") {
    portfolio.autoTradingEnabled = false;
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Auto-trading paused",
      detail: "The Trading Agent will continue monitoring prices but will stop placing mock trades."
    });
    return {
      output: "Auto-trading is now paused. I'll keep monitoring the market without placing new mock trades.",
      dashboard: await getStockDashboard(userSub, authorization)
    };
  }

  if (parsed.action === "resume") {
    portfolio.autoTradingEnabled = true;
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: "Auto-trading resumed",
      detail: "The Trading Agent is back to trend-based mock execution."
    });
    return {
      output: "Auto-trading is active again. I'll resume mocked buy and sell decisions from the live watchlist.",
      dashboard: await getStockDashboard(userSub, authorization)
    };
  }

  if (parsed.action === "focus" && parsed.symbol) {
    const ticker = marketState.get(parsed.symbol);
    if (!ticker?.price) {
      return {
        output: `I'm not tracking ${parsed.symbol} in the live feed yet. Try one of: ${WATCHLIST.join(", ")}.`,
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }
    pushAgentLog(portfolio, {
      id: makeId("log"),
      at: currentTimestamp(),
      type: "system",
      title: `Watching ${parsed.symbol} closely`,
      detail: `${parsed.symbol} moved ${signedPercent(ticker.momentum)} over the latest trend window and currently signals ${ticker.signal}.`
    });
    return {
      output: `${parsed.symbol} is now at the top of my live watchlist. Current signal: ${ticker.signal}, trend score ${ticker.trendScore}.`,
      dashboard: await getStockDashboard(userSub, authorization)
    };
  }

  if ((parsed.action === "buy" || parsed.action === "sell") && parsed.symbol) {
    const ticker = marketState.get(parsed.symbol);
    if (!ticker?.price) {
      return {
        output: `I can't trade ${parsed.symbol} because I don't have a live quote for it right now.`,
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }
    const requestedShares = Math.max(1, Number(parsed.shares) || 1);
    const normalizedShares = normalizeTradeQuantity(portfolio, parsed.action, parsed.symbol, requestedShares);
    if (!normalizedShares) {
      return {
        output: describeTradeBlock(parsed.action, parsed.symbol, requestedShares, getHeldShares(portfolio, parsed.symbol)),
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }
    if (parsed.action === "sell" && normalizedShares < requestedShares) {
      return {
        output: describeTradeBlock(parsed.action, parsed.symbol, requestedShares, getHeldShares(portfolio, parsed.symbol)),
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }
    const notional = roundMoney(normalizedShares * ticker.price);
    let success = false;

    if (notional > STOCK_APPROVAL_THRESHOLD) {
      let approvalTicket = portfolio.pendingTrade?.approvalTicket || null;
      if (!approvalTicket && portfolio.userSub) {
        const approval = await createOperationApproval(portfolio.userSub, {
          approvalType: "stock_trade_approval",
          reason: `Approval required for ${parsed.action} ${parsed.symbol} stock trade.`,
          payload: {
            symbol: parsed.symbol,
            shares: normalizedShares,
            action: parsed.action,
            notional
          },
          ttlSeconds: STOCK_APPROVAL_TTL_SECONDS
        });
        approvalTicket = approval?.id || null;
      }
      setPendingTrade(portfolio, createPendingTradePayload({
        action: parsed.action,
        ticker,
        shares: normalizedShares,
        notional,
        confidence: 0.82,
        reason: `Manual broker instruction: "${String(message || "").trim()}".`,
        requirement: "approval",
        approvalTicket
      }));
      return {
        output: `Approval required before I can ${parsed.action} ${normalizedShares} ${parsed.symbol} shares (${formatCurrencyLike(notional)}).`,
        requiresApproval: true,
        approvalTicket,
        approvalPrompt: "Approve in User Settings or from this panel, then refresh the Trading Agent.",
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }

    if (notional > STOCK_REAUTH_THRESHOLD && !authorization.stepUpVerified) {
      setPendingTrade(portfolio, createPendingTradePayload({
        action: parsed.action,
        ticker,
        shares: normalizedShares,
        notional,
        confidence: 0.82,
        reason: `Manual broker instruction: "${String(message || "").trim()}".`,
        requirement: "reauth"
      }));
      return {
        output: `Re-authentication required before I can ${parsed.action} ${normalizedShares} ${parsed.symbol} shares (${formatCurrencyLike(notional)}).`,
        requiresReauth: true,
        reauthUrl: "/auth/login?stepup=1&returnTo=/",
        dashboard: await getStockDashboard(userSub, authorization)
      };
    }

    success = executeTrade(
      portfolio,
      parsed.action,
      ticker,
      normalizedShares,
      `Manual broker instruction: "${String(message || "").trim()}".`,
      0.82
    );
    return {
      output: success
        ? `Mock ${parsed.action} order placed for ${normalizedShares} ${parsed.symbol} share${normalizedShares === 1 ? "" : "s"} at $${ticker.price}.`
        : `I couldn't place that mock ${parsed.action} order because the portfolio limits would be violated.`,
      dashboard: await getStockDashboard(userSub, authorization)
    };
  }

  const dashboard = await getStockDashboard(userSub, authorization);
  const topMover = dashboard.market.strongest[0];
  const topPosition = dashboard.portfolio.positions[0];
  if (!topMover) {
    return {
      output: dashboard.market.statusMessage || "Live market data is not ready yet.",
      dashboard
    };
  }
  return {
    output: topPosition
      ? `${topMover.symbol} is leading the tape at ${signedPercent(topMover.changePct)}. Your largest simulated position is ${topPosition.symbol}, with unrealized P&L of $${topPosition.unrealizedPnL}.`
      : `${topMover.symbol} is leading the tape at ${signedPercent(topMover.changePct)}. I'm still waiting for a high-conviction setup before opening the first mock position.`,
    dashboard
  };
}

export function startStockMarket() {
  ensureMarketSeed();

  if (!FINNHUB_API_KEY) {
    return;
  }

  if (!refreshIntervalHandle) {
    refreshMarketData({ force: true }).catch(() => {});
    refreshIntervalHandle = setInterval(() => {
      refreshMarketData().catch(() => {});
    }, 5000);
  }
}
