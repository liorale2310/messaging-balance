export interface LotRemaining {
  orderId: string;
  remaining: number;
}

export interface Allocation {
  pieces: { orderId: string; quantity: number }[];
  uncovered: number;
}

export function allocateFifo(
  lots: readonly LotRemaining[],
  amount: number,
): Allocation {
  const pieces: { orderId: string; quantity: number }[] = [];
  let uncovered = amount;
  for (const lot of lots) {
    if (uncovered === 0) {
      break;
    }
    if (lot.remaining <= 0) {
      continue;
    }
    const quantity = Math.min(lot.remaining, uncovered);
    pieces.push({ orderId: lot.orderId, quantity });
    uncovered -= quantity;
  }
  return { pieces, uncovered };
}

export interface CoverRequest {
  lots: readonly LotRemaining[];
  unbackedMessageIds: readonly string[];
  shortfalls: readonly { campaignId: string; missing: number }[];
  debtMessageIds: readonly string[];
}

export interface CoverPlan {
  assignments: { messageId: string; orderId: string }[];
  reservationAdds: { campaignId: string; orderId: string; quantity: number }[];
}

export function coverOutstanding(request: CoverRequest): CoverPlan {
  const lots = request.lots.map((lot) => ({ ...lot }));
  const assignments: { messageId: string; orderId: string }[] = [];
  const adds = new Map<string, number>();

  const take = (needed: number): { orderId: string; quantity: number }[] => {
    const taken: { orderId: string; quantity: number }[] = [];
    let left = needed;
    for (const lot of lots) {
      if (left === 0) {
        break;
      }
      if (lot.remaining <= 0) {
        continue;
      }
      const quantity = Math.min(lot.remaining, left);
      lot.remaining -= quantity;
      left -= quantity;
      taken.push({ orderId: lot.orderId, quantity });
    }
    return taken;
  };

  for (const messageId of request.unbackedMessageIds) {
    const taken = take(1);
    if (taken.length === 1) {
      assignments.push({ messageId, orderId: taken[0].orderId });
    }
  }

  for (const shortfall of request.shortfalls) {
    for (const piece of take(shortfall.missing)) {
      const key = `${shortfall.campaignId}|${piece.orderId}`;
      adds.set(key, (adds.get(key) ?? 0) + piece.quantity);
    }
  }

  for (const messageId of request.debtMessageIds) {
    const taken = take(1);
    if (taken.length === 1) {
      assignments.push({ messageId, orderId: taken[0].orderId });
    }
  }

  return {
    assignments,
    reservationAdds: [...adds.entries()].map(([key, quantity]) => {
      const separator = key.indexOf('|');
      return {
        campaignId: key.slice(0, separator),
        orderId: key.slice(separator + 1),
        quantity,
      };
    }),
  };
}
