import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AccountingError } from './accounting.errors';
import {
  Balance,
  Books,
  assertConservation,
  emptyBalance,
  projectBalance,
} from './domain/balance.projection';
import { Campaign } from './entities/campaign.entity';
import { Customer } from './entities/customer.entity';
import { Message } from './entities/message.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { Recipient } from './entities/recipient.entity';
import { Reservation } from './entities/reservation.entity';

const MAX_QUANTITY = 1_000_000;

export interface PlaceOrderInput {
  orderId: string;
  customerId: string;
  quantity: number;
}

export interface OrderView {
  id: string;
  customerId: string;
  quantity: number;
  status: OrderStatus;
  placedAt: Date;
  cancelledAt: Date | null;
}

@Injectable()
export class AccountingService {
  constructor(private readonly dataSource: DataSource) {}

  async placeOrder(input: PlaceOrderInput): Promise<OrderView> {
    assertQuantity(input.quantity);
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const existing = await manager.findOne(Order, {
        where: { id: input.orderId },
      });
      if (existing) {
        return this.replayOrder(manager, existing, input);
      }

      await manager.query(
        `INSERT INTO customers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [input.customerId],
      );
      await this.lockCustomer(manager, input.customerId);
      await this.lockBooks(manager, input.customerId);

      const raced = await manager.findOne(Order, {
        where: { id: input.orderId },
      });
      if (raced) {
        return this.replayOrder(manager, raced, input);
      }

      await manager.query('SAVEPOINT order_insert');
      try {
        await manager.insert(Order, {
          id: input.orderId,
          customerId: input.customerId,
          quantity: input.quantity,
          status: OrderStatus.ACTIVE,
          placedAt: new Date(),
          cancelledAt: null,
        });
        await manager.query('RELEASE SAVEPOINT order_insert');
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT order_insert');
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const stored = await manager.findOne(Order, {
          where: { id: input.orderId },
        });
        if (!stored) {
          throw error;
        }
        return this.replayOrder(manager, stored, input);
      }

      await this.assertCustomer(manager, input.customerId);
      const stored = await manager.findOneOrFail(Order, {
        where: { id: input.orderId },
      });
      return toOrderView(stored);
    });
  }

  async cancelOrder(orderId: string): Promise<OrderView> {
    const existing = await this.dataSource.getRepository(Order).findOne({
      where: { id: orderId },
    });
    if (!existing) {
      throw new AccountingError(
        'ORDER_NOT_FOUND',
        `Order ${orderId} was not found.`,
      );
    }

    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, existing.customerId);
      await this.lockBooks(manager, existing.customerId);
      const order = await manager.findOne(Order, { where: { id: orderId } });
      if (!order || order.customerId !== existing.customerId) {
        throw new AccountingError(
          'ORDER_NOT_FOUND',
          `Order ${orderId} was not found.`,
        );
      }
      if (order.status === OrderStatus.ACTIVE) {
        order.status = OrderStatus.CANCELLED;
        order.cancelledAt = new Date();
        await manager.update(Order, order.id, {
          status: order.status,
          cancelledAt: order.cancelledAt,
        });
      }
      await this.assertCustomer(manager, order.customerId);
      return toOrderView(order);
    });
  }

  async getBalance(customerId: string): Promise<Balance> {
    const customer = await this.dataSource.getRepository(Customer).findOne({
      where: { id: customerId },
    });
    if (!customer) {
      return emptyBalance();
    }

    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, customerId);
      await this.lockBooks(manager, customerId);
      return projectBalance(await this.loadBooks(manager, customerId));
    });
  }

  private async replayOrder(
    manager: EntityManager,
    stored: Order,
    input: PlaceOrderInput,
  ): Promise<OrderView> {
    if (!sameOrderPayload(stored, input)) {
      throw orderConflict(input.orderId);
    }
    await this.lockCustomer(manager, stored.customerId);
    await this.lockBooks(manager, stored.customerId);
    const current = await manager.findOne(Order, {
      where: { id: stored.id },
    });
    if (!current || !sameOrderPayload(current, input)) {
      throw orderConflict(input.orderId);
    }
    await this.assertCustomer(manager, current.customerId);
    return toOrderView(current);
  }

  private async lockCustomer(
    manager: EntityManager,
    customerId: string,
  ): Promise<void> {
    const customer = await manager
      .createQueryBuilder(Customer, 'customer')
      .setLock('pessimistic_write')
      .where('customer.id = :customerId', { customerId })
      .getOne();
    if (!customer) {
      throw new AccountingError(
        'ORDER_NOT_FOUND',
        `Customer ${customerId} was not found.`,
      );
    }
  }

  private async lockBooks(
    manager: EntityManager,
    customerId: string,
  ): Promise<void> {
    await manager
      .createQueryBuilder(Order, 'ord')
      .setLock('pessimistic_write')
      .where('ord.customerId = :customerId', { customerId })
      .orderBy('ord.id', 'ASC')
      .getMany();
    await manager
      .createQueryBuilder(Campaign, 'campaign')
      .setLock('pessimistic_write')
      .where('campaign.customerId = :customerId', { customerId })
      .orderBy('campaign.id', 'ASC')
      .getMany();
    await manager
      .createQueryBuilder(Message, 'message')
      .innerJoin('message.campaign', 'campaign')
      .setLock('pessimistic_write', undefined, ['message'])
      .where('campaign.customerId = :customerId', { customerId })
      .orderBy('message.id', 'ASC')
      .getMany();
  }

  private async assertCustomer(
    manager: EntityManager,
    customerId: string,
  ): Promise<void> {
    assertConservation(await this.loadBooks(manager, customerId));
  }

  private async loadBooks(
    manager: EntityManager,
    customerId: string,
  ): Promise<Books> {
    const orders = await manager.find(Order, {
      where: { customerId },
      order: { id: 'ASC' },
    });
    const campaigns = await manager.find(Campaign, {
      where: { customerId },
      order: { id: 'ASC' },
    });
    const campaignIds = campaigns.map((campaign) => campaign.id);
    const recipients =
      campaignIds.length === 0
        ? []
        : await manager
            .createQueryBuilder(Recipient, 'recipient')
            .where('recipient.campaignId IN (:...campaignIds)', { campaignIds })
            .getMany();
    const reservations =
      campaignIds.length === 0
        ? []
        : await manager
            .createQueryBuilder(Reservation, 'reservation')
            .where('reservation.campaignId IN (:...campaignIds)', {
              campaignIds,
            })
            .getMany();
    const messages =
      campaignIds.length === 0
        ? []
        : await manager
            .createQueryBuilder(Message, 'message')
            .where('message.campaignId IN (:...campaignIds)', { campaignIds })
            .getMany();
    const recipientCount = new Map<string, number>();
    for (const recipient of recipients) {
      recipientCount.set(
        recipient.campaignId,
        (recipientCount.get(recipient.campaignId) ?? 0) + 1,
      );
    }

    return {
      orders: orders.map((order) => ({
        id: order.id,
        quantity: order.quantity,
        status: order.status,
        placedAt: order.placedAt,
        cancelledAt: order.cancelledAt,
      })),
      campaigns: campaigns.map((campaign) => ({
        id: campaign.id,
        status: campaign.status,
        scheduledAt: campaign.scheduledAt,
        fundingNote: campaign.fundingNote,
        notSentReason: campaign.notSentReason,
        recipientCount: recipientCount.get(campaign.id) ?? 0,
      })),
      reservations: reservations.map((reservation) => ({
        campaignId: reservation.campaignId,
        orderId: reservation.orderId,
        quantity: reservation.quantity,
      })),
      messages: messages.map((message) => ({
        id: message.id,
        campaignId: message.campaignId,
        orderId: message.orderId,
        outcome: message.outcome,
        creditState: message.creditState,
      })),
    };
  }
}

function sameOrderPayload(order: Order, input: PlaceOrderInput): boolean {
  return (
    order.customerId === input.customerId && order.quantity === input.quantity
  );
}

function orderConflict(orderId: string): AccountingError {
  return new AccountingError(
    'ORDER_CONFLICT',
    `Order ${orderId} already exists with a different customer or quantity.`,
  );
}

function assertQuantity(quantity: number): void {
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw new AccountingError(
      'INVALID_QUANTITY',
      'Order quantity must be a whole number from 1 to 1000000.',
    );
  }
}

function toOrderView(order: Order): OrderView {
  return {
    id: order.id,
    customerId: order.customerId,
    quantity: order.quantity,
    status: order.status,
    placedAt: order.placedAt,
    cancelledAt: order.cancelledAt,
  };
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string }).code === '23505'
  );
}
