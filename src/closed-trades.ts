// One row per closed trade, from the records GET /api/trades/history returns.
//
// The route returns every closed Trade document, and a position close stores two kinds:
//   - the entry lot(s) it closed (positionSide 'long'/'short', or 'buy'/'sell' on spot),
//     stamped with the exit price and their share of the PnL;
//   - ONE exit record (positionSide 'flat') carrying the realised PnL of that close.
// TradeStaq's own metrics, leaderboard and risk limits count only the exit records. Listing
// both showed every trade twice with the same PnL (seen live: HYPE on Bitget, closed
// 2026-11-09, as a "sell" row and a "buy" row 100 ms apart), and summing both doubled PnL.
//
// So a closed trade is an exit record. Its direction comes from the exit's side: a buy
// closes a short, a sell closes a long. Its open time comes from the entry lots closed with
// it, when they are on the same page (they sort next to it, closed ~100 ms earlier).
//
// One exception: a lot the reconcile closed because the exchange position was already gone
// ('exchange_already_flat', 'strategy_spin_sync') gets no exit record, so TradeStaq's metrics
// never count it. Checked over every record on the live Bitget, Bybit and Hyperliquid accounts
// on 2026-11-12: those reasons had 0 exit records except one spin-sync close, and they carried
// real losses (ZEC on Bitget, 2026-10-15). Hiding them would drop losses from a "losses
// included" record, so such a lot is listed as its own trade with noExitRecord: true. Older
// unmatched lots (before 2026-02-16) are not: their exit records exist but were written without
// closedAt, so they are counted through those exits.

const LOT_SIDES = new Set(['long', 'short', 'buy', 'sell'])
const CLOSED_WITHOUT_EXIT = new Set(['exchange_already_flat', 'strategy_spin_sync'])
// Lots a close books are stamped within ~100 ms of its exit record; 5 s leaves room for a
// slow write without catching the bot's next trade (bots trade on candle closes).
const SAME_CLOSE_MS = 5000

export interface ClosedTrade {
  id: string
  symbol: string
  direction?: 'long' | 'short'
  entryPrice?: number
  exitPrice?: number
  size?: number
  pnl?: number
  /** pnl / (entryPrice x size) x 100: the return on position size, not on leveraged margin. */
  returnOnPositionPct?: number
  leverage?: number
  exchangeId?: string
  botId?: string
  isPaper?: boolean
  closeReason?: string
  openedAt?: string
  closedAt?: string
  holdingMinutes?: number
  /** Closed by the reconcile with no exit record (see above): the PnL is what TradeStaq booked then, and its metrics leave it out. */
  noExitRecord?: true
}

const idOf = (v: any): string | undefined => {
  if (v == null) return undefined
  if (typeof v === 'object') return v.id != null ? String(v.id) : v._id != null ? String(v._id) : undefined
  return String(v)
}
const num = (v: any): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const time = (v: any): number => (v ? Date.parse(String(v)) : NaN)

/** A record that is the entry side of a position (closed by a separate exit record). */
export function isEntryLot(row: any): boolean {
  return LOT_SIDES.has(row?.positionSide)
}

const sameClose = (a: any, b: any): boolean =>
  idOf(a.bot) === idOf(b.bot) &&
  idOf(a.exchange) === idOf(b.exchange) &&
  a.symbol === b.symbol &&
  Math.abs(time(a.closedAt) - time(b.closedAt)) <= SAME_CLOSE_MS

/**
 * The closed trades in a page of /api/trades/history records, in the page's order: closed exit
 * records, plus reconcile-closed lots that have no exit record (noExitRecord). A record with no
 * positionSide at all (never written by the current schema, which requires it) is kept as a
 * trade rather than hidden. Canceled records are not trades.
 */
export function closedTrades(rows: any[]): ClosedTrade[] {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  const lots = list.filter(isEntryLot)
  const exits = list.filter((r) => !isEntryLot(r) && r.status === 'closed')
  return list
    .filter((r) => r.status === 'closed' && (!isEntryLot(r) ||
      (CLOSED_WITHOUT_EXIT.has(r.closeReason) && !exits.some((e) => sameClose(e, r)))))
    .map((rec) => (isEntryLot(rec) ? lotTrade(rec) : exitTrade(rec, lots)))
}

function exitTrade(exit: any, lots: any[]): ClosedTrade {
  const closedWith = lots.filter((l) => sameClose(l, exit))
  const openedMs = closedWith.map((l) => time(l.createdAt)).filter(Number.isFinite)
  return buildTrade(exit, {
    direction: exit.positionSide === 'flat' ? (exit.side === 'buy' ? 'short' : exit.side === 'sell' ? 'long' : undefined) : undefined,
    openedMs: openedMs.length ? Math.min(...openedMs) : NaN,
  })
}

/** A reconcile-closed lot with no exit record: its own fields are the trade. */
function lotTrade(lot: any): ClosedTrade {
  return buildTrade(lot, {
    direction: lot.positionSide === 'short' || lot.positionSide === 'sell' ? 'short' : 'long',
    openedMs: time(lot.createdAt),
    noExitRecord: true,
  })
}

function buildTrade(rec: any, o: { direction?: 'long' | 'short', openedMs: number, noExitRecord?: true }): ClosedTrade {
  const closedMs = time(rec.closedAt)
  const entryPrice = num(rec.entryPrice)
  const size = num(rec.size)
  const pnl = num(rec.pnl)
  const contractSize = num(rec.contractSize)
  // Only when size is in base units (no contract multiplier), so the % can't be off by a factor.
  const returnOnPositionPct = pnl !== undefined && entryPrice && size && (contractSize === undefined || contractSize === 1)
    ? Math.round((pnl / (entryPrice * size)) * 10000) / 100
    : undefined
  const opened = o.openedMs

  const trade: ClosedTrade = {
    id: idOf(rec.id ?? rec._id) ?? '',
    symbol: rec.symbol,
    direction: o.direction,
    entryPrice,
    exitPrice: num(rec.exitPrice) ?? (o.noExitRecord ? undefined : num(rec.price)),
    size,
    pnl,
    returnOnPositionPct,
    leverage: num(rec.leverage),
    exchangeId: idOf(rec.exchange),
    botId: idOf(rec.bot),
    isPaper: typeof rec.isPaper === 'boolean' ? rec.isPaper : undefined,
    closeReason: typeof rec.closeReason === 'string' ? rec.closeReason : undefined,
    openedAt: Number.isFinite(opened) ? new Date(opened).toISOString() : undefined,
    closedAt: rec.closedAt ? String(rec.closedAt) : undefined,
    holdingMinutes: Number.isFinite(opened) && Number.isFinite(closedMs) ? Math.round((closedMs - opened) / 60000) : undefined,
    noExitRecord: o.noExitRecord,
  }
  for (const k of Object.keys(trade) as (keyof ClosedTrade)[]) if (trade[k] === undefined) delete trade[k]
  return trade
}
