import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError } from 'typeorm';
import { AccountingError } from './accounting.errors';
import { allocateFifo, coverOutstanding } from './domain/allocation.policy';
import { decideHandoff, HandoffReport } from './domain/handoff.policy';
import {
  Balance,
  Books,
  assertConservation,
  emptyBalance,
  projectBalance,
} from './domain/balance.projection';
import { Campaign, CampaignStatus } from './entities/campaign.entity';
import { Customer } from './entities/customer.entity';
import {
  CreditState,
  Message,
  MessageOutcome,
} from './entities/message.entity';
import { Order, OrderStatus } from './entities/order.entity';
import { Recipient } from './entities/recipient.entity';
import { Reservation } from './entities/reservation.entity';

const MAX_QUANTITY = 1_000_000;

export interface PlaceOrderInput {
  orderId: string;
  customerId: string;
  quantity: number;
}

export interface CampaignView {
  id: string;
  customerId: string;
  status: CampaignStatus;
  scheduledAt: Date | null;
  fundingNote: string | null;
  notSentReason: string | null;
}

export interface RecipientView {
  id: string;
  campaignId: string;
  address: string;
}

export interface SendDueResult {
  dispatched: string[];
  notSent: string[];
}

export interface HandoffInput {
  eventId: string;
  messageId: string;
  outcome: 'ACCEPTED' | 'REJECTED';
  sequence: bigint;
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
      await manager.query(
        `INSERT INTO customers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [input.customerId],
      );
      await this.lockCustomer(manager, input.customerId);
      await this.lockBooks(manager, input.customerId);

      const existing = await manager.findOne(Order, {
        where: { id: input.orderId },
      });
      if (existing) {
        return this.replayOrder(manager, existing, input);
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

      await this.settle(manager, input.customerId);
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
        await manager.delete(Reservation, { orderId: order.id });
        await manager
          .createQueryBuilder()
          .update(Message)
          .set({ orderId: null })
          .where('order_id = :orderId', { orderId: order.id })
          .andWhere('credit_state = :creditState', {
            creditState: CreditState.RESERVED,
          })
          .execute();
        await this.settle(manager, order.customerId, {
          cancelledOrderId: order.id,
        });
      } else {
        await this.settle(manager, order.customerId);
      }
      return toOrderView(order);
    });
  }

  async createCampaign(input: {
    campaignId: string;
    customerId: string;
  }): Promise<CampaignView> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      const existing = await manager.findOne(Campaign, {
        where: { id: input.campaignId },
      });
      if (existing) {
        if (existing.customerId !== input.customerId) {
          throw new AccountingError(
            'CAMPAIGN_CONFLICT',
            `Campaign ${input.campaignId} already exists for another customer.`,
          );
        }
        await this.lockCustomer(manager, existing.customerId);
        await this.lockBooks(manager, existing.customerId);
        await this.settle(manager, existing.customerId);
        return toCampaignView(existing);
      }

      await this.ensureCustomer(manager, input.customerId);
      await this.lockCustomer(manager, input.customerId);
      await this.lockBooks(manager, input.customerId);
      const raced = await manager.findOne(Campaign, {
        where: { id: input.campaignId },
      });
      if (raced) {
        if (raced.customerId !== input.customerId) {
          throw new AccountingError(
            'CAMPAIGN_CONFLICT',
            `Campaign ${input.campaignId} already exists for another customer.`,
          );
        }
        await this.settle(manager, input.customerId);
        return toCampaignView(raced);
      }

      await manager.query('SAVEPOINT campaign_insert');
      try {
        await manager.insert(Campaign, {
          id: input.campaignId,
          customerId: input.customerId,
          status: CampaignStatus.DRAFT,
          scheduledAt: null,
          fundingNote: null,
          notSentReason: null,
        });
        await manager.query('RELEASE SAVEPOINT campaign_insert');
      } catch (error) {
        await manager.query('ROLLBACK TO SAVEPOINT campaign_insert');
        if (!isUniqueViolation(error)) {
          throw error;
        }
        const stored = await manager.findOne(Campaign, {
          where: { id: input.campaignId },
        });
        if (!stored || stored.customerId !== input.customerId) {
          throw new AccountingError(
            'CAMPAIGN_CONFLICT',
            `Campaign ${input.campaignId} already exists for another customer.`,
          );
        }
        await this.settle(manager, input.customerId);
        return toCampaignView(stored);
      }

      await this.settle(manager, input.customerId);
      return toCampaignView(
        await manager.findOneOrFail(Campaign, {
          where: { id: input.campaignId },
        }),
      );
    });
  }

  async addRecipient(input: {
    campaignId: string;
    recipientId: string;
    address: string;
  }): Promise<RecipientView> {
    const address = input.address.trim();
    if (address.length === 0 || address.length > 64) {
      throw new AccountingError(
        'CAMPAIGN_CONFLICT',
        'Recipient address must be a trimmed non-empty string of at most 64 characters.',
      );
    }
    const campaign = await this.requireCampaign(input.campaignId);
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, campaign.customerId);
      await this.lockBooks(manager, campaign.customerId);
      const current = await this.requireCampaignIn(
        manager,
        input.campaignId,
        campaign.customerId,
      );
      this.assertEditable(current, 'Recipients');
      const sameId = await manager.findOne(Recipient, {
        where: { id: input.recipientId },
      });
      if (sameId) {
        if (sameId.campaignId === current.id && sameId.address === address) {
          await this.settle(manager, current.customerId);
          return toRecipientView(sameId);
        }
        throw new AccountingError(
          'CAMPAIGN_CONFLICT',
          `Recipient ${input.recipientId} already exists with a different address.`,
        );
      }
      const duplicate = await manager.findOne(Recipient, {
        where: { campaignId: current.id, address },
      });
      if (duplicate) {
        throw new AccountingError(
          'DUPLICATE_RECIPIENT',
          `Campaign ${current.id} already includes ${address}.`,
        );
      }

      if (current.status === CampaignStatus.SCHEDULED) {
        const books = await this.loadBooks(manager, current.customerId);
        const balance = projectBalance(books);
        const allocation = allocateFifo(freeLots(balance), 1);
        if (balance.available < 1 || allocation.uncovered > 0) {
          throw insufficientCredit(balance);
        }
        await manager.insert(Recipient, {
          id: input.recipientId,
          campaignId: current.id,
          address,
        });
        await this.addReservationPieces(manager, current.id, allocation.pieces);
      } else {
        await manager.insert(Recipient, {
          id: input.recipientId,
          campaignId: current.id,
          address,
        });
      }

      await this.settle(manager, current.customerId);
      return toRecipientView(
        await manager.findOneOrFail(Recipient, {
          where: { id: input.recipientId },
        }),
      );
    });
  }

  async removeRecipient(input: {
    campaignId: string;
    recipientId: string;
  }): Promise<void> {
    const campaign = await this.requireCampaign(input.campaignId);
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, campaign.customerId);
      await this.lockBooks(manager, campaign.customerId);
      const current = await this.requireCampaignIn(
        manager,
        input.campaignId,
        campaign.customerId,
      );
      this.assertEditable(current, 'Recipients');
      const recipient = await manager.findOne(Recipient, {
        where: { id: input.recipientId, campaignId: current.id },
      });
      if (!recipient) {
        throw new AccountingError(
          'RECIPIENT_NOT_FOUND',
          `Recipient ${input.recipientId} was not found on campaign ${current.id}.`,
        );
      }
      if (current.status === CampaignStatus.SCHEDULED) {
        const books = await this.loadBooks(manager, current.customerId);
        const shortfall =
          projectBalance(books).campaigns.find((item) => item.id === current.id)
            ?.shortfall ?? 0;
        if (shortfall === 0) {
          await this.releaseNewestCredit(manager, books, current.id);
        }
      }
      await manager.delete(Recipient, recipient.id);
      await this.settle(manager, current.customerId);
    });
  }

  async scheduleCampaign(input: {
    campaignId: string;
    scheduledAt: Date;
  }): Promise<CampaignView> {
    if (
      !(input.scheduledAt instanceof Date) ||
      Number.isNaN(input.scheduledAt.getTime())
    ) {
      throw new AccountingError(
        'SCHEDULE_CONFLICT',
        'Scheduled time is not a valid date.',
      );
    }
    const campaign = await this.requireCampaign(input.campaignId);
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, campaign.customerId);
      await this.lockBooks(manager, campaign.customerId);
      const current = await this.requireCampaignIn(
        manager,
        input.campaignId,
        campaign.customerId,
      );
      if (
        current.status === CampaignStatus.SCHEDULED &&
        current.scheduledAt?.getTime() === input.scheduledAt.getTime()
      ) {
        await this.settle(manager, current.customerId);
        return toCampaignView(current);
      }
      if (current.status === CampaignStatus.SCHEDULED) {
        throw new AccountingError(
          'SCHEDULE_CONFLICT',
          `Campaign ${current.id} is already scheduled. Cancel the schedule before choosing another time.`,
        );
      }
      if (current.status !== CampaignStatus.DRAFT) {
        throw new AccountingError(
          'CAMPAIGN_NOT_EDITABLE',
          `Campaign ${current.id} cannot be scheduled from ${current.status}.`,
        );
      }
      const books = await this.loadBooks(manager, current.customerId);
      const recipientCount =
        books.campaigns.find((item) => item.id === current.id)
          ?.recipientCount ?? 0;
      if (recipientCount === 0) {
        throw new AccountingError(
          'EMPTY_CAMPAIGN',
          `Campaign ${current.id} has no recipients.`,
        );
      }
      const balance = projectBalance(books);
      const allocation = allocateFifo(freeLots(balance), recipientCount);
      if (balance.available < recipientCount || allocation.uncovered > 0) {
        throw insufficientCredit(balance);
      }
      await this.addReservationPieces(manager, current.id, allocation.pieces);
      await manager.update(Campaign, current.id, {
        status: CampaignStatus.SCHEDULED,
        scheduledAt: input.scheduledAt,
        fundingNote: null,
      });
      await this.settle(manager, current.customerId);
      return toCampaignView(
        await manager.findOneOrFail(Campaign, { where: { id: current.id } }),
      );
    });
  }

  async cancelSchedule(campaignId: string): Promise<CampaignView> {
    const campaign = await this.requireCampaign(campaignId);
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, campaign.customerId);
      await this.lockBooks(manager, campaign.customerId);
      const current = await this.requireCampaignIn(
        manager,
        campaignId,
        campaign.customerId,
      );
      if (current.status !== CampaignStatus.SCHEDULED) {
        throw new AccountingError(
          'CAMPAIGN_NOT_EDITABLE',
          `Campaign ${current.id} is ${current.status} and has no schedule to cancel.`,
        );
      }
      await manager.delete(Reservation, { campaignId: current.id });
      await manager.update(Campaign, current.id, {
        status: CampaignStatus.DRAFT,
        scheduledAt: null,
        fundingNote: null,
      });
      await this.settle(manager, current.customerId);
      return toCampaignView(
        await manager.findOneOrFail(Campaign, { where: { id: current.id } }),
      );
    });
  }

  async sendDue(at: Date): Promise<SendDueResult> {
    if (!(at instanceof Date) || Number.isNaN(at.getTime())) {
      return { dispatched: [], notSent: [] };
    }
    const customers = await this.dataSource.query<{ customerId: string }[]>(
      `SELECT DISTINCT customer_id AS "customerId"
       FROM campaigns
       WHERE status = 'SCHEDULED' AND scheduled_at <= $1
       ORDER BY customer_id`,
      [at],
    );
    const dispatched: string[] = [];
    const notSent: string[] = [];
    for (const customer of customers) {
      const result = await this.sendCustomerDue(customer.customerId, at);
      dispatched.push(...result.dispatched);
      notSent.push(...result.notSent);
    }
    return { dispatched, notSent };
  }

  async recordHandoff(input: HandoffInput): Promise<void> {
    const report = handoffReport(input);
    const message = await this.dataSource.getRepository(Message).findOne({
      where: { id: report.messageId },
    });
    if (!message) {
      throw new AccountingError(
        'MESSAGE_NOT_FOUND',
        `Message ${report.messageId} was not found.`,
      );
    }
    const campaign = await this.requireCampaign(message.campaignId);
    await this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, campaign.customerId);
      await this.lockBooks(manager, campaign.customerId);
      const current = await manager.findOne(Message, {
        where: { id: report.messageId },
      });
      if (!current) {
        throw new AccountingError(
          'MESSAGE_NOT_FOUND',
          `Message ${report.messageId} was not found.`,
        );
      }
      const decision = decideHandoff({
        incoming: report,
        storedByEventId: await this.findHandoff(manager, report.eventId),
        sequenceTaken: await this.sequenceTaken(
          manager,
          report.messageId,
          report.sequence,
        ),
        appliedSequence: current.outcomeSequence,
      });
      if (decision.kind === 'conflict') {
        throw handoffConflict(report.eventId);
      }
      if (decision.kind === 'idempotent') {
        await this.settle(manager, campaign.customerId);
        return;
      }
      const inserted = await this.insertHandoff(manager, report);
      if (!inserted) {
        const raced = decideHandoff({
          incoming: report,
          storedByEventId: await this.findHandoff(manager, report.eventId),
          sequenceTaken: await this.sequenceTaken(
            manager,
            report.messageId,
            report.sequence,
          ),
          appliedSequence: current.outcomeSequence,
        });
        if (raced.kind === 'idempotent') {
          await this.settle(manager, campaign.customerId);
          return;
        }
        throw handoffConflict(report.eventId);
      }
      if (decision.kind === 'apply') {
        await this.applyHandoff(manager, campaign.customerId, current, report);
        return;
      }
      await this.settle(manager, campaign.customerId);
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
    await this.settle(manager, stored.customerId);
    return toOrderView(stored);
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

  private async requireCampaign(campaignId: string): Promise<Campaign> {
    const campaign = await this.dataSource.getRepository(Campaign).findOne({
      where: { id: campaignId },
    });
    if (!campaign) {
      throw new AccountingError(
        'CAMPAIGN_NOT_FOUND',
        `Campaign ${campaignId} was not found.`,
      );
    }
    return campaign;
  }

  private async requireCampaignIn(
    manager: EntityManager,
    campaignId: string,
    customerId: string,
  ): Promise<Campaign> {
    const campaign = await manager.findOne(Campaign, {
      where: { id: campaignId },
    });
    if (!campaign || campaign.customerId !== customerId) {
      throw new AccountingError(
        'CAMPAIGN_NOT_FOUND',
        `Campaign ${campaignId} was not found.`,
      );
    }
    return campaign;
  }

  private assertEditable(campaign: Campaign, action: string): void {
    if (
      campaign.status === CampaignStatus.DISPATCHED ||
      campaign.status === CampaignStatus.NOT_SENT
    ) {
      throw new AccountingError(
        'CAMPAIGN_NOT_EDITABLE',
        `${action} cannot change campaign ${campaign.id} after it is ${campaign.status}.`,
      );
    }
  }

  private async ensureCustomer(
    manager: EntityManager,
    customerId: string,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO customers (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [customerId],
    );
  }

  private async addReservationPieces(
    manager: EntityManager,
    campaignId: string,
    pieces: { orderId: string; quantity: number }[],
  ): Promise<void> {
    for (const piece of pieces) {
      const current = await manager.findOne(Reservation, {
        where: { campaignId, orderId: piece.orderId },
      });
      if (current) {
        await manager.update(
          Reservation,
          { campaignId, orderId: piece.orderId },
          { quantity: current.quantity + piece.quantity },
        );
      } else {
        await manager.insert(Reservation, {
          campaignId,
          orderId: piece.orderId,
          quantity: piece.quantity,
        });
      }
    }
  }

  private async releaseNewestCredit(
    manager: EntityManager,
    books: Books,
    campaignId: string,
  ): Promise<void> {
    const ordersById = new Map(books.orders.map((order) => [order.id, order]));
    const newest = books.reservations
      .filter((reservation) => reservation.campaignId === campaignId)
      .sort((left, right) => {
        const leftPlaced =
          ordersById.get(left.orderId)?.placedAt.getTime() ?? 0;
        const rightPlaced =
          ordersById.get(right.orderId)?.placedAt.getTime() ?? 0;
        return (
          rightPlaced - leftPlaced || right.orderId.localeCompare(left.orderId)
        );
      })[0];
    if (!newest) {
      return;
    }
    if (newest.quantity === 1) {
      await manager.delete(Reservation, {
        campaignId,
        orderId: newest.orderId,
      });
      return;
    }
    await manager.update(
      Reservation,
      { campaignId, orderId: newest.orderId },
      { quantity: newest.quantity - 1 },
    );
  }

  private async sendCustomerDue(
    customerId: string,
    at: Date,
  ): Promise<SendDueResult> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      await this.lockCustomer(manager, customerId);
      await this.lockBooks(manager, customerId);
      const due = await manager
        .createQueryBuilder(Campaign, 'campaign')
        .setLock('pessimistic_write')
        .where('campaign.customerId = :customerId', { customerId })
        .andWhere('campaign.status = :status', {
          status: CampaignStatus.SCHEDULED,
        })
        .andWhere('campaign.scheduledAt <= :at', { at })
        .orderBy('campaign.scheduledAt', 'ASC')
        .addOrderBy('campaign.id', 'ASC')
        .getMany();
      const dispatched: string[] = [];
      const notSent: string[] = [];
      for (const campaign of due) {
        const books = await this.loadBooks(manager, customerId);
        const projected = projectBalance(books).campaigns.find(
          (item) => item.id === campaign.id,
        );
        const funded = projected?.funded ?? 0;
        const recipientCount = projected?.recipientCount ?? 0;
        if (recipientCount > 0 && funded === recipientCount) {
          await this.dispatchCampaign(manager, books, campaign.id);
          dispatched.push(campaign.id);
        } else {
          await this.markNotSent(manager, campaign, funded, recipientCount);
          await this.coverCustomer(manager, customerId);
          notSent.push(campaign.id);
        }
      }
      await this.settle(manager, customerId);
      return { dispatched, notSent };
    });
  }

  private async dispatchCampaign(
    manager: EntityManager,
    books: Books,
    campaignId: string,
  ): Promise<void> {
    const recipients = await manager.find(Recipient, {
      where: { campaignId },
      order: { createdAt: 'ASC', id: 'ASC' },
    });
    const ordersById = new Map(books.orders.map((order) => [order.id, order]));
    const credits: string[] = [];
    const lots = books.reservations
      .filter((reservation) => reservation.campaignId === campaignId)
      .slice()
      .sort((left, right) => {
        const leftPlaced =
          ordersById.get(left.orderId)?.placedAt.getTime() ?? 0;
        const rightPlaced =
          ordersById.get(right.orderId)?.placedAt.getTime() ?? 0;
        return (
          leftPlaced - rightPlaced || left.orderId.localeCompare(right.orderId)
        );
      });
    for (const lot of lots) {
      for (let index = 0; index < lot.quantity; index += 1) {
        credits.push(lot.orderId);
      }
    }
    if (credits.length !== recipients.length) {
      throw new Error(
        `Campaign ${campaignId} is funded on the balance but its reservations do not match its recipients.`,
      );
    }
    for (const [index, recipient] of recipients.entries()) {
      await manager.insert(Message, {
        id: randomUUID(),
        campaignId,
        recipientId: recipient.id,
        address: recipient.address,
        orderId: credits[index],
        outcome: MessageOutcome.PENDING,
        creditState: CreditState.RESERVED,
        outcomeSequence: null,
      });
    }
    await manager.delete(Reservation, { campaignId });
    await manager.update(Campaign, campaignId, {
      status: CampaignStatus.DISPATCHED,
      fundingNote: null,
    });
  }

  private async markNotSent(
    manager: EntityManager,
    campaign: Campaign,
    funded: number,
    recipientCount: number,
  ): Promise<void> {
    const reason = [
      `Not sent: ${funded} of ${recipientCount} recipients were funded.`,
      campaign.fundingNote,
    ]
      .filter((part): part is string => part !== null && part !== '')
      .join(' ');
    await manager.delete(Reservation, { campaignId: campaign.id });
    await manager.update(Campaign, campaign.id, {
      status: CampaignStatus.NOT_SENT,
      notSentReason: reason,
    });
  }

  private async applyHandoff(
    manager: EntityManager,
    customerId: string,
    message: Message,
    report: HandoffReport,
  ): Promise<void> {
    const books = await this.loadBooks(manager, customerId);
    const activeIds = new Set(
      books.orders
        .filter((order) => order.status === OrderStatus.ACTIVE)
        .map((order) => order.id),
    );
    const held =
      message.creditState === CreditState.RESERVED &&
      message.orderId !== null &&
      activeIds.has(message.orderId);
    if (report.outcome === 'ACCEPTED') {
      await manager.query(
        `UPDATE messages
         SET outcome = 'ACCEPTED',
             credit_state = 'CONSUMED',
             outcome_sequence = $1::bigint,
             order_id = $2
         WHERE id = $3`,
        [report.sequence.toString(), held ? message.orderId : null, message.id],
      );
    } else {
      await manager.query(
        `UPDATE messages
         SET outcome = 'REJECTED',
             credit_state = 'RELEASED',
             outcome_sequence = $1::bigint,
             order_id = NULL
         WHERE id = $2`,
        [report.sequence.toString(), message.id],
      );
    }
    await this.settle(manager, customerId);
  }

  private async findHandoff(
    manager: EntityManager,
    eventId: string,
  ): Promise<HandoffReport | null> {
    const rows = await manager.query<
      {
        eventId: string;
        messageId: string;
        outcome: 'ACCEPTED' | 'REJECTED';
        sequence: string;
      }[]
    >(
      `SELECT event_id AS "eventId",
              message_id AS "messageId",
              outcome,
              sequence::text AS sequence
       FROM handoff_events
       WHERE event_id = $1`,
      [eventId],
    );
    const row = rows[0];
    if (!row) {
      return null;
    }
    return {
      eventId: row.eventId,
      messageId: row.messageId,
      outcome: row.outcome,
      sequence: BigInt(row.sequence),
    };
  }

  private async sequenceTaken(
    manager: EntityManager,
    messageId: string,
    sequence: bigint,
  ): Promise<boolean> {
    const rows = await manager.query<unknown[]>(
      `SELECT 1 FROM handoff_events
       WHERE message_id = $1 AND sequence = $2::bigint`,
      [messageId, sequence.toString()],
    );
    return rows.length > 0;
  }

  private async insertHandoff(
    manager: EntityManager,
    report: HandoffReport,
  ): Promise<boolean> {
    await manager.query('SAVEPOINT handoff_insert');
    try {
      await manager.query(
        `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
         VALUES ($1, $2, $3, $4::bigint)`,
        [
          report.eventId,
          report.messageId,
          report.outcome,
          report.sequence.toString(),
        ],
      );
      await manager.query('RELEASE SAVEPOINT handoff_insert');
      return true;
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }
      await manager.query('ROLLBACK TO SAVEPOINT handoff_insert');
      return false;
    }
  }

  private async settle(
    manager: EntityManager,
    customerId: string,
    cause?: { cancelledOrderId: string },
  ): Promise<void> {
    await this.coverCustomer(manager, customerId, cause);
    assertConservation(await this.loadBooks(manager, customerId));
  }

  private async coverCustomer(
    manager: EntityManager,
    customerId: string,
    cause?: { cancelledOrderId: string },
  ): Promise<void> {
    const books = await this.loadBooks(manager, customerId);
    const activeIds = new Set(
      books.orders
        .filter((order) => order.status === OrderStatus.ACTIVE)
        .map((order) => order.id),
    );
    const ordersById = new Map(books.orders.map((order) => [order.id, order]));
    const balance = projectBalance(books);
    const plan = coverOutstanding({
      lots: balance.orders
        .filter((order) => order.status === OrderStatus.ACTIVE)
        .map((order) => ({
          orderId: order.id,
          remaining: Math.max(
            0,
            order.quantity - order.reserved - order.consumed,
          ),
        })),
      unbackedMessageIds: books.messages
        .filter(
          (message) =>
            message.creditState === CreditState.RESERVED &&
            (message.orderId === null || !activeIds.has(message.orderId)),
        )
        .map((message) => message.id)
        .sort(),
      shortfalls: books.campaigns
        .filter((campaign) => campaign.status === CampaignStatus.SCHEDULED)
        .map((campaign) => ({
          campaign,
          missing:
            balance.campaigns.find((item) => item.id === campaign.id)
              ?.shortfall ?? 0,
        }))
        .filter((item) => item.missing > 0)
        .sort(
          (left, right) =>
            (left.campaign.scheduledAt?.getTime() ?? 0) -
              (right.campaign.scheduledAt?.getTime() ?? 0) ||
            left.campaign.id.localeCompare(right.campaign.id),
        )
        .map((item) => ({
          campaignId: item.campaign.id,
          missing: item.missing,
        })),
      debtMessageIds: books.messages
        .filter((message) => {
          if (message.creditState !== CreditState.CONSUMED) {
            return false;
          }
          return message.orderId === null || !activeIds.has(message.orderId);
        })
        .sort((left, right) => {
          const leftPlaced =
            (left.orderId
              ? ordersById.get(left.orderId)?.placedAt.getTime()
              : undefined) ?? Number.MAX_SAFE_INTEGER;
          const rightPlaced =
            (right.orderId
              ? ordersById.get(right.orderId)?.placedAt.getTime()
              : undefined) ?? Number.MAX_SAFE_INTEGER;
          return leftPlaced - rightPlaced || left.id.localeCompare(right.id);
        })
        .map((message) => message.id),
    });

    for (const assignment of plan.assignments) {
      await manager.update(Message, assignment.messageId, {
        orderId: assignment.orderId,
      });
    }
    for (const add of plan.reservationAdds) {
      const current = await manager.findOne(Reservation, {
        where: { campaignId: add.campaignId, orderId: add.orderId },
      });
      if (current) {
        await manager.update(
          Reservation,
          { campaignId: add.campaignId, orderId: add.orderId },
          { quantity: current.quantity + add.quantity },
        );
      } else {
        await manager.insert(Reservation, add);
      }
    }

    const settled = projectBalance(await this.loadBooks(manager, customerId));
    for (const campaign of settled.campaigns) {
      if (campaign.status !== CampaignStatus.SCHEDULED) {
        continue;
      }
      const source = books.campaigns.find((item) => item.id === campaign.id);
      if (campaign.shortfall === 0 && source?.fundingNote) {
        await manager.update(Campaign, campaign.id, { fundingNote: null });
      } else if (campaign.shortfall > 0 && cause) {
        await manager.update(Campaign, campaign.id, {
          fundingNote: `Order ${cause.cancelledOrderId} was cancelled. Shortfall is ${campaign.shortfall} credit(s).`,
        });
      }
    }
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

function freeLots(balance: Balance): { orderId: string; remaining: number }[] {
  return balance.orders
    .filter((order) => order.status === OrderStatus.ACTIVE)
    .map((order) => ({
      orderId: order.id,
      remaining: order.quantity - order.reserved - order.consumed,
    }));
}

function insufficientCredit(balance: Balance): AccountingError {
  return new AccountingError(
    'INSUFFICIENT_CREDIT',
    `Not enough credit: available ${balance.available}, reserved ${balance.reserved}, debt ${balance.debt}.`,
  );
}

function toCampaignView(campaign: Campaign): CampaignView {
  return {
    id: campaign.id,
    customerId: campaign.customerId,
    status: campaign.status,
    scheduledAt: campaign.scheduledAt,
    fundingNote: campaign.fundingNote,
    notSentReason: campaign.notSentReason,
  };
}

function toRecipientView(recipient: Recipient): RecipientView {
  return {
    id: recipient.id,
    campaignId: recipient.campaignId,
    address: recipient.address,
  };
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

function handoffReport(input: HandoffInput): HandoffReport {
  if (
    typeof input.eventId !== 'string' ||
    input.eventId.length === 0 ||
    (input.outcome !== 'ACCEPTED' && input.outcome !== 'REJECTED') ||
    typeof input.sequence !== 'bigint' ||
    input.sequence <= 0n
  ) {
    throw new AccountingError(
      'HANDOFF_CONFLICT',
      'A handoff report needs a non-empty event id, an accepted or rejected outcome, and a positive sequence.',
    );
  }
  return {
    eventId: input.eventId,
    messageId: input.messageId,
    outcome: input.outcome,
    sequence: input.sequence,
  };
}

function handoffConflict(eventId: string): AccountingError {
  return new AccountingError(
    'HANDOFF_CONFLICT',
    `Handoff event ${eventId} conflicts with a report already stored.`,
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof QueryFailedError &&
    (error.driverError as { code?: string }).code === '23505'
  );
}
