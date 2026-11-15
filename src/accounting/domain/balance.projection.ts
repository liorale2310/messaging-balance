import { CampaignStatus } from '../entities/campaign.entity';
import { CreditState, MessageOutcome } from '../entities/message.entity';
import { OrderStatus } from '../entities/order.entity';

export interface OrderSnapshot {
  id: string;
  quantity: number;
  status: OrderStatus;
  placedAt: Date;
  cancelledAt: Date | null;
}

export interface CampaignSnapshot {
  id: string;
  status: CampaignStatus;
  scheduledAt: Date | null;
  fundingNote: string | null;
  notSentReason: string | null;
  recipientCount: number;
}

export interface ReservationSnapshot {
  campaignId: string;
  orderId: string;
  quantity: number;
}

export interface MessageSnapshot {
  id: string;
  campaignId: string;
  orderId: string | null;
  outcome: MessageOutcome;
  creditState: CreditState;
}

export interface Books {
  orders: OrderSnapshot[];
  campaigns: CampaignSnapshot[];
  reservations: ReservationSnapshot[];
  messages: MessageSnapshot[];
}

export interface OrderBalance {
  id: string;
  status: OrderStatus;
  quantity: number;
  reserved: number;
  consumed: number;
  placedAt: Date;
  cancelledAt: Date | null;
}

export interface CampaignBalance {
  id: string;
  status: CampaignStatus;
  scheduledAt: Date | null;
  recipientCount: number;
  funded: number;
  shortfall: number;
  pending: number;
  accepted: number;
  rejected: number;
}

export interface Balance {
  available: number;
  reserved: number;
  consumed: number;
  debt: number;
  unbackedInFlight: number;
  orders: OrderBalance[];
  campaigns: CampaignBalance[];
  explanations: string[];
}

export function emptyBalance(): Balance {
  return {
    available: 0,
    reserved: 0,
    consumed: 0,
    debt: 0,
    unbackedInFlight: 0,
    orders: [],
    campaigns: [],
    explanations: [],
  };
}

function isActive(order: OrderSnapshot): boolean {
  return order.status === OrderStatus.ACTIVE;
}

function reservedOn(orderId: string, books: Books): number {
  const held =
    books.reservations
      .filter((reservation) => reservation.orderId === orderId)
      .reduce((sum, reservation) => sum + reservation.quantity, 0) +
    books.messages.filter(
      (message) =>
        message.orderId === orderId &&
        message.creditState === CreditState.RESERVED,
    ).length;
  return held;
}

function consumedOn(orderId: string, books: Books): number {
  return books.messages.filter(
    (message) =>
      message.orderId === orderId &&
      message.creditState === CreditState.CONSUMED,
  ).length;
}

export function projectBalance(books: Books): Balance {
  const ordersById = new Map(books.orders.map((order) => [order.id, order]));
  const activeIds = new Set(
    books.orders.filter(isActive).map((order) => order.id),
  );

  const orders = [...books.orders]
    .sort(
      (left, right) =>
        left.placedAt.getTime() - right.placedAt.getTime() ||
        left.id.localeCompare(right.id),
    )
    .map((order) => ({
      id: order.id,
      status: order.status,
      quantity: order.quantity,
      reserved: reservedOn(order.id, books),
      consumed: consumedOn(order.id, books),
      placedAt: order.placedAt,
      cancelledAt: order.cancelledAt,
    }));

  const reserved = orders
    .filter((order) => activeIds.has(order.id))
    .reduce((sum, order) => sum + order.reserved, 0);
  const consumed = orders
    .filter((order) => activeIds.has(order.id))
    .reduce((sum, order) => sum + order.consumed, 0);
  const activeQuantity = orders
    .filter((order) => activeIds.has(order.id))
    .reduce((sum, order) => sum + order.quantity, 0);

  const debtMessages = books.messages.filter((message) => {
    if (message.creditState !== CreditState.CONSUMED) {
      return false;
    }
    if (message.orderId === null) {
      return true;
    }
    const order = ordersById.get(message.orderId);
    return order === undefined || order.status === OrderStatus.CANCELLED;
  });
  const unbackedMessages = books.messages.filter((message) => {
    if (message.creditState !== CreditState.RESERVED) {
      return false;
    }
    return message.orderId === null || !activeIds.has(message.orderId);
  });

  const campaigns = books.campaigns
    .slice()
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((campaign) => {
      const campaignMessages = books.messages.filter(
        (message) => message.campaignId === campaign.id,
      );
      const fundedFromReservations = books.reservations
        .filter(
          (reservation) =>
            reservation.campaignId === campaign.id &&
            activeIds.has(reservation.orderId),
        )
        .reduce((sum, reservation) => sum + reservation.quantity, 0);
      const fundedFromMessages = campaignMessages.filter(
        (message) =>
          (message.creditState === CreditState.RESERVED ||
            message.creditState === CreditState.CONSUMED) &&
          message.orderId !== null &&
          activeIds.has(message.orderId),
      ).length;
      const funded =
        campaign.status === CampaignStatus.SCHEDULED
          ? fundedFromReservations
          : campaign.status === CampaignStatus.DISPATCHED
            ? fundedFromMessages
            : 0;
      const shortfall =
        campaign.status === CampaignStatus.SCHEDULED
          ? Math.max(0, campaign.recipientCount - funded)
          : 0;
      return {
        id: campaign.id,
        status: campaign.status,
        scheduledAt: campaign.scheduledAt,
        recipientCount: campaign.recipientCount,
        funded,
        shortfall,
        pending: campaignMessages.filter(
          (message) => message.outcome === MessageOutcome.PENDING,
        ).length,
        accepted: campaignMessages.filter(
          (message) => message.outcome === MessageOutcome.ACCEPTED,
        ).length,
        rejected: campaignMessages.filter(
          (message) => message.outcome === MessageOutcome.REJECTED,
        ).length,
      };
    });

  const explanations: string[] = [];
  if (debtMessages.length > 0) {
    const cancelledOrderIds = [
      ...new Set(
        debtMessages
          .map((message) => message.orderId)
          .filter((orderId): orderId is string => orderId !== null),
      ),
    ].sort();
    const where =
      cancelledOrderIds.length > 0
        ? ` on cancelled order(s) ${cancelledOrderIds.join(', ')}`
        : ' with no order';
    explanations.push(
      `${debtMessages.length} accepted message(s) are debt${where}.`,
    );
  }
  if (unbackedMessages.length > 0) {
    explanations.push(
      `${unbackedMessages.length} in-flight message(s) have no order backing them.`,
    );
  }
  for (const campaign of campaigns) {
    const source = books.campaigns.find((item) => item.id === campaign.id);
    if (campaign.shortfall > 0) {
      explanations.push(
        source?.fundingNote ??
          `Campaign ${campaign.id} is short by ${campaign.shortfall} credit(s).`,
      );
    }
    if (source?.notSentReason) {
      explanations.push(source.notSentReason);
    }
  }

  return {
    available: activeQuantity - reserved - consumed,
    reserved,
    consumed,
    debt: debtMessages.length,
    unbackedInFlight: unbackedMessages.length,
    orders,
    campaigns,
    explanations,
  };
}

export function assertConservation(books: Books): void {
  const balance = projectBalance(books);
  const active = balance.orders.filter(
    (order) => order.status === OrderStatus.ACTIVE,
  );
  const activeQuantity = active.reduce((sum, order) => sum + order.quantity, 0);
  if (
    activeQuantity !==
    balance.available + balance.reserved + balance.consumed
  ) {
    throw new Error(
      `Credit conservation failed: active quantity ${activeQuantity} does not equal available ${balance.available} + reserved ${balance.reserved} + consumed ${balance.consumed}.`,
    );
  }
  for (const order of active) {
    if (order.reserved + order.consumed > order.quantity) {
      throw new Error(
        `Credit conservation failed: order ${order.id} holds ${order.reserved + order.consumed} of ${order.quantity}.`,
      );
    }
  }
  if (balance.available < 0) {
    throw new Error(
      `Credit conservation failed: available is ${balance.available}.`,
    );
  }
  const shortfall = balance.campaigns.reduce(
    (sum, campaign) => sum + campaign.shortfall,
    0,
  );
  if (
    balance.available > 0 &&
    (balance.debt > 0 || balance.unbackedInFlight > 0 || shortfall > 0)
  ) {
    throw new Error(
      `Credit conservation failed: available is ${balance.available} while debt is ${balance.debt}, unbacked in-flight is ${balance.unbackedInFlight}, and scheduled shortfall is ${shortfall}.`,
    );
  }
}
