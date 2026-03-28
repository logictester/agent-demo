import { useEffect, useMemo, useState } from "react";
import { STORAGE_KEYS, useApp } from "../context/AppContext";
import { formatCurrency, formatShortTimestamp } from "../utils/format";
import * as api from "../api/client";
import "./StockAgentView.css";

function formatSignedCurrency(value) {
  const amount = Number(value) || 0;
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${formatCurrency(amount)}`;
}

function formatSignedPercent(value) {
  const amount = Number(value) || 0;
  const prefix = amount > 0 ? "+" : "";
  return `${prefix}${amount.toFixed(2)}%`;
}

function formatVolume(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    return "N/A";
  }
  return amount.toLocaleString("en-US");
}

function buildPath(history) {
  if (!Array.isArray(history) || history.length < 2) {
    return "";
  }
  const prices = history.map((point) => Number(point.price) || 0);
  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const span = Math.max(1, max - min);
  return history
    .map((point, index) => {
      const x = (index / (history.length - 1)) * 100;
      const y = 100 - (((Number(point.price) || 0) - min) / span) * 100;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

function buildChartSeries(ticker) {
  const history = Array.isArray(ticker?.history) ? ticker.history.filter((point) => Number(point?.price) > 0) : [];
  if (history.length >= 4) {
    return history;
  }

  const synthetic = [
    { at: "previousClose", price: Number(ticker?.previousClose) || 0 },
    { at: "open", price: Number(ticker?.openPrice) || 0 },
    { at: "dayLow", price: Number(ticker?.dayLow) || 0 },
    { at: "dayHigh", price: Number(ticker?.dayHigh) || 0 },
    { at: "current", price: Number(ticker?.price) || 0 }
  ].filter((point) => point.price > 0);

  const deduped = synthetic.filter((point, index, list) =>
    index === 0 || point.price !== list[index - 1].price || index === list.length - 1
  );

  return deduped.length >= 2 ? deduped : [];
}

function buildPortfolioSeries(positions, cash, fallbackTicker, pulseHistory) {
  const persistedPulse = Array.isArray(pulseHistory)
    ? pulseHistory.filter((point) => Number(point?.value) > 0 && point?.at)
    : [];
  if (persistedPulse.length >= 2) {
    return persistedPulse;
  }

  const activePositions = Array.isArray(positions) ? positions : [];
  const histories = activePositions
    .map((position) => {
      const ticker = position?.historySource;
      return ticker && Array.isArray(ticker.history) && ticker.history.length ? { position, history: ticker.history } : null;
    })
    .filter(Boolean);

  if (!histories.length && fallbackTicker?.history?.length) {
    return fallbackTicker.history.map((point) => ({
      at: point.at,
      value: Number(cash || 0)
    }));
  }

  const dateMap = new Map();
  for (const item of histories) {
    for (const point of item.history) {
      const key = point.at;
      if (!dateMap.has(key)) {
        dateMap.set(key, Number(cash || 0));
      }
    }
  }

  const orderedDates = Array.from(dateMap.keys()).sort();
  return orderedDates.map((date) => {
    let total = Number(cash || 0);
    for (const item of histories) {
      const match = item.history.find((point) => point.at === date) || item.history[item.history.length - 1];
      total += (Number(match?.price) || 0) * (Number(item.position?.shares) || 0);
    }
    return { at: date, value: total };
  });
}

function computePortfolioMetrics(positions, cash) {
  const baseCash = Number(cash || 0);
  const activePositions = Array.isArray(positions) ? positions : [];
  const equity = activePositions.reduce((sum, position) => sum + (Number(position.marketValue) || 0), 0);
  const dayPnl = activePositions.reduce((sum, position) => {
    const shares = Number(position.shares) || 0;
    const livePrice = Number(position.price) || 0;
    const previousClose = Number(position.historySource?.previousClose) || livePrice;
    return sum + ((livePrice - previousClose) * shares);
  }, 0);

  return {
    cash: baseCash,
    equity,
    totalValue: baseCash + equity,
    dayPnl
  };
}

function buildAreaPath(series, accessor = "value") {
  if (!Array.isArray(series) || series.length < 2) {
    return "";
  }
  const points = series.map((point) => Number(point?.[accessor]) || 0);
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = Math.max(1, max - min);
  return series
    .map((point, index) => {
      const x = (index / (series.length - 1)) * 100;
      const y = 100 - (((Number(point?.[accessor]) || 0) - min) / span) * 100;
      return `${index === 0 ? "M" : "L"} ${x.toFixed(2)} ${y.toFixed(2)}`;
    })
    .join(" ");
}

export default function StockAgentView() {
  const { stockDashboard, loadStockDashboard, sendStockMessage } = useApp();
  const [message, setMessage] = useState("");
  const [status, setStatus] = useState("Stock broker online. I'm scanning momentum and rotating the mock portfolio automatically.");
  const [sending, setSending] = useState(false);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [approvedPendingTicket, setApprovedPendingTicket] = useState("");

  const watchlist = Array.isArray(stockDashboard.market?.watchlist)
    ? stockDashboard.market.watchlist
    : [];
  const selectedTicker =
    watchlist.find((ticker) => ticker.symbol === selectedSymbol) ||
    watchlist[0] ||
    null;
  const enrichedPositions = useMemo(() => {
    const positions = Array.isArray(stockDashboard.portfolio?.positions)
      ? stockDashboard.portfolio.positions
      : [];
    return positions.map((position) => ({
      ...position,
      historySource: watchlist.find((ticker) => ticker.symbol === position.symbol) || null
    }));
  }, [stockDashboard.portfolio?.positions, watchlist]);
  const chartPath = useMemo(
    () => buildPath(buildChartSeries(selectedTicker)),
    [selectedTicker]
  );
  const portfolioSeries = useMemo(
    () => buildPortfolioSeries(
      enrichedPositions,
      stockDashboard.portfolio?.cash || 0,
      selectedTicker,
      stockDashboard.portfolio?.pulseHistory || []
    ),
    [enrichedPositions, stockDashboard.portfolio?.cash, stockDashboard.portfolio?.pulseHistory, selectedTicker]
  );
  const portfolioMetrics = useMemo(
    () => computePortfolioMetrics(enrichedPositions, stockDashboard.portfolio?.cash || 0),
    [enrichedPositions, stockDashboard.portfolio?.cash]
  );
  const portfolioPath = useMemo(
    () => buildAreaPath(portfolioSeries),
    [portfolioSeries]
  );
  const emptyStateMessage =
    stockDashboard.market?.status === "needs_config"
      ? "Add `FINNHUB_API_KEY` in `backend/.env` to load Finnhub market data for the chart and watchlist."
      : stockDashboard.market?.statusMessage || "No stock data is available right now.";
  const isPositiveTicker = Number(selectedTicker?.change || 0) >= 0;
  const pendingTrade = stockDashboard.portfolio?.pendingTrade || null;
  const approvalAlreadySubmitted =
    pendingTrade?.type === "approval" &&
    pendingTrade?.approvalTicket &&
    approvedPendingTicket === pendingTrade.approvalTicket;

  useEffect(() => {
    loadStockDashboard();
    const id = setInterval(() => {
      loadStockDashboard();
    }, 4000);
    return () => clearInterval(id);
  }, [loadStockDashboard]);

  useEffect(() => {
    if (!watchlist.length) {
      if (selectedSymbol) {
        setSelectedSymbol("");
      }
      return;
    }
    if (!selectedTicker) {
      setSelectedSymbol(watchlist[0].symbol);
    }
  }, [watchlist, selectedTicker, selectedSymbol]);

  async function handleSend() {
    const trimmed = String(message || "").trim();
    if (!trimmed) {
      setStatus('Try a broker instruction like "pause auto trading", "resume", "buy NVDA 2", or "sell AAPL 1".');
      return;
    }

    setSending(true);
    try {
      const data = await sendStockMessage(trimmed);
      setStatus(data?.output || "The Trading Agent processed your instruction.");
      setMessage("");
    } catch (error) {
      setStatus(`Error: ${error.message}`);
    } finally {
      setSending(false);
    }
  }

  async function handleApproveNow() {
    if (!pendingTrade?.approvalTicket) {
      return;
    }
    setSending(true);
    try {
      await api.approveOperation(pendingTrade.approvalTicket);
      localStorage.setItem(STORAGE_KEYS.stockApprovalTicket, String(pendingTrade.approvalTicket));
      setApprovedPendingTicket(String(pendingTrade.approvalTicket));
      const data = await loadStockDashboard();
      setStatus(
        data?.portfolio?.pendingTrade
          ? "Approval recorded. Waiting for the Trading Agent to finalize the protected trade."
          : "Approval recorded. The protected trade has now been resolved."
      );
    } catch (error) {
      setStatus(`Error: ${error.message}`);
    } finally {
      setSending(false);
    }
  }

  return (
    <section className="stock-shell">
      <article className="card stock-hero">
        <div className="stock-hero-copy">
          <div className="stock-eyebrow">Trading Agent</div>
          <h1>Live market pulse with a simulated autonomous broker</h1>
          <p>
            This lane tracks a live-updating mock market, summarizes momentum,
            and lets the agent place paper trades on its own based on trend
            strength.
          </p>
        </div>

        <div className="stock-hero-stats">
          <div className="market-chip">
            <span>Market Sentiment</span>
            <strong>{Number(stockDashboard.market?.sentiment || 0).toFixed(2)}</strong>
          </div>
          <div className="market-chip">
            <span>Advancers</span>
            <strong>{stockDashboard.market?.breadth?.advancers || 0}</strong>
          </div>
          <div className="market-chip">
            <span>Decliners</span>
            <strong>{stockDashboard.market?.breadth?.decliners || 0}</strong>
          </div>
          <div className="market-chip">
            <span>Portfolio Value</span>
            <strong>{formatCurrency(portfolioMetrics.totalValue || stockDashboard.portfolio?.totalValue || 0)}</strong>
          </div>
        </div>
      </article>

      <article className={`card live-status ${stockDashboard.market?.isLive ? "ok" : "warn"}`}>
        <div>
          <strong>
            {stockDashboard.market?.sourceLabel || "Market feed"}{" "}
            {stockDashboard.market?.isLive ? "connected" : "not connected"}
          </strong>
          <p>
            {stockDashboard.market?.statusMessage || "Waiting for market data."}
            {stockDashboard.market?.source === "finnhub" ? " Quotes refresh on a short cadence with intraday candles for context." : ""}
          </p>
        </div>
        {stockDashboard.market?.error && (
          <div className="live-status-error">{stockDashboard.market.error}</div>
        )}
      </article>

      <section className="stock-grid">
        <article className="card market-stage">
          <div className="stock-section-head">
            <div>
              <h2>Live Market Board</h2>
              <p>
                Updated {formatShortTimestamp(stockDashboard.market?.updatedAt)}
              </p>
            </div>
            {selectedTicker && (
              <div className={`signal-pill ${selectedTicker.signal || "hold"}`}>
                {selectedTicker.symbol} {selectedTicker.signal}
              </div>
            )}
          </div>

          {!!watchlist.length && (
            <div className="symbol-rail" role="tablist" aria-label="Tracked stocks">
              {watchlist.map((ticker) => (
                <button
                  type="button"
                  key={ticker.symbol}
                  className={`symbol-pill ${selectedTicker?.symbol === ticker.symbol ? "active" : ""}`}
                  onClick={() => setSelectedSymbol(ticker.symbol)}
                >
                  <strong>{ticker.symbol}</strong>
                  <span className={ticker.change >= 0 ? "up" : "down"}>
                    {formatSignedPercent(ticker.changePct)}
                  </span>
                </button>
              ))}
            </div>
          )}

          {selectedTicker ? (
            <>
              <div className="selected-ticker">
                <div className="ticker-identity">
                  <div className="ticker-symbol">{selectedTicker.symbol}</div>
                  <div className="ticker-name">{selectedTicker.name}</div>
                  <div className="ticker-sector">{selectedTicker.sector}</div>
                </div>
                <div className="ticker-price-wrap">
                  <div className="ticker-price">{formatCurrency(selectedTicker.price)}</div>
                  <div className={`ticker-change ${selectedTicker.change >= 0 ? "up" : "down"}`}>
                    {formatSignedCurrency(selectedTicker.change)} · {formatSignedPercent(selectedTicker.changePct)}
                  </div>
                </div>
              </div>

              <div className="ticker-stats-strip">
                <div className="ticker-stat-pill">
                  <span>Open</span>
                  <strong>{formatCurrency(selectedTicker.openPrice)}</strong>
                </div>
                <div className="ticker-stat-pill">
                  <span>Day High</span>
                  <strong>{formatCurrency(selectedTicker.dayHigh)}</strong>
                </div>
                <div className="ticker-stat-pill">
                  <span>Day Low</span>
                  <strong>{formatCurrency(selectedTicker.dayLow)}</strong>
                </div>
                <div className="ticker-stat-pill">
                  <span>Volume</span>
                  <strong>{formatVolume(selectedTicker.volume)}</strong>
                </div>
              </div>

              <div className="market-chart">
                {chartPath ? (
                  <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label={`${selectedTicker.symbol} live chart`}>
                    <defs>
                      <linearGradient id="stock-chart-fill" x1="0" y1="0" x2="0" y2="1">
                        <stop
                          offset="0%"
                          stopColor={isPositiveTicker ? "rgba(22, 163, 74, 0.34)" : "rgba(239, 68, 68, 0.30)"}
                        />
                        <stop
                          offset="100%"
                          stopColor={isPositiveTicker ? "rgba(22, 163, 74, 0.02)" : "rgba(239, 68, 68, 0.02)"}
                        />
                      </linearGradient>
                    </defs>
                    <path className="chart-area" d={`${chartPath} L 100 100 L 0 100 Z`} />
                    <path className={`chart-line ${isPositiveTicker ? "up" : "down"}`} d={chartPath} />
                  </svg>
                ) : (
                  <div className="market-chart-empty">Waiting for enough market ticks to draw the chart.</div>
                )}
              </div>
            </>
          ) : (
            <div className="market-empty">
              {emptyStateMessage}
            </div>
          )}

          {!!watchlist.length && (
            <div className="watchlist-grid">
              {watchlist.map((ticker) => (
                <button
                  type="button"
                  className={`ticker-card ${selectedTicker?.symbol === ticker.symbol ? "active" : ""}`}
                  key={ticker.symbol}
                  onClick={() => setSelectedSymbol(ticker.symbol)}
                >
                  <div className="ticker-top">
                    <div>
                      <strong>{ticker.symbol}</strong>
                      <span>{ticker.sector}</span>
                    </div>
                    <div className={`signal-badge ${ticker.signal}`}>{ticker.signal}</div>
                  </div>
                  <div className="ticker-value">{formatCurrency(ticker.price)}</div>
                  <div className={`ticker-delta ${ticker.change >= 0 ? "up" : "down"}`}>
                    {formatSignedPercent(ticker.changePct)}
                  </div>
                  <div className="ticker-meta">
                    <span>Trend {ticker.trendScore}</span>
                    <span>Vol {formatVolume(ticker.volume)}</span>
                  </div>
                </button>
              ))}
            </div>
          )}
        </article>

        <article className="card broker-panel">
          <div className="stock-section-head">
            <div>
              <h2>Broker Console</h2>
              <p>{stockDashboard.portfolio?.autoTradingEnabled ? "Auto trading enabled" : "Auto trading paused"}</p>
            </div>
            <div className="data-badge">paper broker</div>
          </div>

          <div className="broker-metrics">
            <div className="broker-stat">
              <span>Cash</span>
              <strong>{formatCurrency(portfolioMetrics.cash || stockDashboard.portfolio?.cash || 0)}</strong>
            </div>
            <div className="broker-stat">
              <span>Equity</span>
              <strong>{formatCurrency(portfolioMetrics.equity || stockDashboard.portfolio?.equity || 0)}</strong>
            </div>
            <div className="broker-stat">
              <span>Day P&amp;L</span>
              <strong className={(portfolioMetrics.dayPnl || stockDashboard.portfolio?.dayPnl || 0) >= 0 ? "up" : "down"}>
                {formatSignedCurrency(portfolioMetrics.dayPnl || stockDashboard.portfolio?.dayPnl || 0)}
              </strong>
            </div>
          </div>

          <div className="portfolio-pulse">
            <div className="portfolio-pulse-head">
              <div>
                <strong>Portfolio Pulse</strong>
                <span>Approximate equity curve for current paper holdings</span>
              </div>
              <div className={(portfolioMetrics.dayPnl || stockDashboard.portfolio?.dayPnl || 0) >= 0 ? "up" : "down"}>
                {formatSignedCurrency(portfolioMetrics.dayPnl || stockDashboard.portfolio?.dayPnl || 0)}
              </div>
            </div>
            <div className="portfolio-pulse-chart">
              {portfolioPath ? (
                <svg viewBox="0 0 100 100" preserveAspectRatio="none" aria-label="Portfolio pulse chart">
                  <defs>
                    <linearGradient id="portfolio-chart-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgba(59, 130, 246, 0.32)" />
                      <stop offset="100%" stopColor="rgba(59, 130, 246, 0.02)" />
                    </linearGradient>
                  </defs>
                  <path className="portfolio-area" d={`${portfolioPath} L 100 100 L 0 100 Z`} />
                  <path className="portfolio-line" d={portfolioPath} />
                </svg>
              ) : (
                <div className="portfolio-pulse-empty">No position history yet.</div>
              )}
            </div>
          </div>

          <div className="stock-input-row">
            <input
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder='Try: "pause auto trading", "resume", or "buy NVDA 2"'
              disabled={sending}
            />
            <button className="btn btn-save" onClick={handleSend} disabled={sending}>
              <span className="material-symbols-outlined">send</span>Send
            </button>
          </div>

          <div className="stock-status">{status}</div>

          {pendingTrade && (
            <div className={`protected-trade ${pendingTrade.type}`}>
              <div className="protected-trade-copy">
                <strong>
                  {pendingTrade.type === "approval" ? "Approval required" : "Re-authentication required"}
                </strong>
                <p>
                  {pendingTrade.action.toUpperCase()} {pendingTrade.shares} {pendingTrade.symbol} shares at{" "}
                  {formatCurrency(pendingTrade.price)} for {formatCurrency(pendingTrade.notional)}.
                </p>
                <span>{pendingTrade.reason}</span>
              </div>
              <div className="protected-trade-actions">
                {pendingTrade.type === "reauth" ? (
                  <button
                    className="btn btn-login"
                    onClick={() => {
                      window.location.href = "/auth/login?stepup=1&returnTo=/";
                    }}
                  >
                    <span className="material-symbols-outlined">lock_reset</span>
                    Re-authenticate
                  </button>
                ) : (
                  <button
                    className="btn btn-save"
                    onClick={handleApproveNow}
                    disabled={sending || approvalAlreadySubmitted}
                  >
                    <span className="material-symbols-outlined">check_circle</span>
                    {approvalAlreadySubmitted ? "Approved" : "Approve Trade"}
                  </button>
                )}
              </div>
            </div>
          )}

          <div className="positions-list">
            <h3>Open Positions</h3>
            {stockDashboard.portfolio?.positions?.length ? (
              stockDashboard.portfolio.positions.map((position) => (
                <div className="position-row" key={position.symbol}>
                  <div>
                    <strong>{position.symbol}</strong>
                    <span>{position.shares} shares @ {formatCurrency(position.avgCost)}</span>
                  </div>
                  <div>
                    <strong>{formatCurrency(position.marketValue)}</strong>
                    <span className={position.unrealizedPnL >= 0 ? "up" : "down"}>
                      {formatSignedCurrency(position.unrealizedPnL)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-note">No open positions yet. The broker is waiting for a stronger setup.</div>
            )}
          </div>
        </article>
      </section>

      <section className="stock-grid secondary">
        <article className="card log-panel">
          <div className="stock-section-head">
            <div>
              <h2>Autonomous Decisions</h2>
              <p>What the broker is doing on its own right now</p>
            </div>
          </div>
          <div className="log-list">
            {(stockDashboard.portfolio?.agentLog || []).map((entry) => (
              <div className="log-row" key={entry.id}>
                <div className={`log-dot ${entry.type || "system"}`} />
                <div>
                  <strong>{entry.title}</strong>
                  <p>{entry.detail}</p>
                </div>
                <time>{formatShortTimestamp(entry.at)}</time>
              </div>
            ))}
          </div>
        </article>

        <article className="card trades-panel">
          <div className="stock-section-head">
            <div>
              <h2>Mock Executions</h2>
              <p>Paper trades placed by the agent</p>
            </div>
          </div>
          <div className="trade-list">
            {(stockDashboard.portfolio?.tradeHistory || []).map((trade) => (
              <div className="trade-row" key={trade.id}>
                <div>
                  <strong>{trade.side.toUpperCase()} {trade.symbol}</strong>
                  <span>{trade.shares} shares at {formatCurrency(trade.price)}</span>
                </div>
                <div>
                  <strong>{formatCurrency(trade.notional)}</strong>
                  <span>{formatShortTimestamp(trade.at)}</span>
                </div>
              </div>
            ))}
          </div>
        </article>
      </section>
    </section>
  );
}
