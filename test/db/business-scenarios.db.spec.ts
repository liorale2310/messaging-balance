import { randomUUID } from 'node:crypto';
import { AccountingService } from '../../src/accounting/accounting.service';
import { Balance } from '../../src/accounting/domain/balance.projection';
import { CampaignStatus } from '../../src/accounting/entities/campaign.entity';
import { HandoffEvent } from '../../src/accounting/entities/handoff-event.entity';
import {
  CreditState,
  Message,
  MessageOutcome,
} from '../../src/accounting/entities/message.entity';
import { OrderStatus } from '../../src/accounting/entities/order.entity';
import { Reservation } from '../../src/accounting/entities/reservation.entity';
import { getDataSource } from './harness';

function expectConserved(balance: Balance): void {
  const activeQuantity = balance.orders
    .filter((order) => order.status === OrderStatus.ACTIVE)
    .reduce((sum, order) => sum + order.quantity, 0);
  expect(activeQuantity).toBe(
    balance.available + balance.reserved + balance.consumed,
  );
  expect(balance.available).toBeGreaterThanOrEqual(0);
  if (balance.available > 0) {
    expect(balance.debt).toBe(0);
    expect(balance.unbackedInFlight).toBe(0);
    expect(
      balance.campaigns.every((campaign) => campaign.shortfall === 0),
    ).toBe(true);
  }
}

describe('business scenarios', () => {
  let service: AccountingService;

  beforeAll(() => {
    service = new AccountingService(getDataSource());
  });

  async function stampOrder(orderId: string, at: string): Promise<void> {
    await getDataSource().query(
      `UPDATE orders SET placed_at = $1 WHERE id = $2`,
      [new Date(at), orderId],
    );
  }

  async function stampRecipient(
    recipientId: string,
    at: string,
  ): Promise<void> {
    await getDataSource().query(
      `UPDATE recipients SET created_at = $1 WHERE id = $2`,
      [new Date(at), recipientId],
    );
  }

  it('re-homes a cancelled lot, covers the shortfall, then sends three backed messages', async () => {
    const customerId = randomUUID();
    const oldest = randomUUID();
    const second = randomUUID();
    await service.placeOrder({ orderId: oldest, customerId, quantity: 2 });
    await service.placeOrder({ orderId: second, customerId, quantity: 2 });
    await stampOrder(oldest, '2026-01-01T00:00:00.000Z');
    await stampOrder(second, '2026-02-01T00:00:00.000Z');

    const when = new Date('2026-06-01T00:00:00.000Z');
    const campaignId = randomUUID();
    const recipientIds = [randomUUID(), randomUUID(), randomUUID()];
    await service.createCampaign({ campaignId, customerId });
    for (const [index, recipientId] of recipientIds.entries()) {
      await service.addRecipient({
        campaignId,
        recipientId,
        address: `+1555100${index}`,
      });
      await stampRecipient(recipientId, `2026-03-0${index + 1}T00:00:00.000Z`);
    }
    await service.scheduleCampaign({ campaignId, scheduledAt: when });

    const reserved = await getDataSource()
      .getRepository(Reservation)
      .find({ where: { campaignId } });
    expect(reserved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: oldest, quantity: 2 }),
        expect.objectContaining({ orderId: second, quantity: 1 }),
      ]),
    );
    expect(reserved).toHaveLength(2);
    const afterSchedule = await service.getBalance(customerId);
    expect(afterSchedule.available).toBe(1);
    expect(afterSchedule.reserved).toBe(3);
    expect(afterSchedule.campaigns[0]).toMatchObject({
      status: CampaignStatus.SCHEDULED,
      recipientCount: 3,
      funded: 3,
      shortfall: 0,
    });
    expectConserved(afterSchedule);

    await service.cancelOrder(oldest);
    const short = await service.getBalance(customerId);
    expect(short.available).toBe(0);
    expect(short.reserved).toBe(2);
    expect(short.orders.find((order) => order.id === oldest)).toMatchObject({
      status: OrderStatus.CANCELLED,
      reserved: 0,
    });
    expect(short.orders.find((order) => order.id === second)).toMatchObject({
      status: OrderStatus.ACTIVE,
      reserved: 2,
    });
    expect(short.campaigns[0]).toMatchObject({
      funded: 2,
      shortfall: 1,
      recipientCount: 3,
    });
    expect(short.explanations).toEqual([
      `Order ${oldest} was cancelled. Shortfall is 1 credit(s).`,
    ]);
    expectConserved(short);

    const fresh = randomUUID();
    await service.placeOrder({ orderId: fresh, customerId, quantity: 1 });
    await stampOrder(fresh, '2026-03-01T00:00:00.000Z');
    const covered = await service.getBalance(customerId);
    expect(covered.available).toBe(0);
    expect(covered.reserved).toBe(3);
    expect(covered.campaigns[0]).toMatchObject({ funded: 3, shortfall: 0 });
    expect(covered.explanations).toEqual([]);
    expect(
      await getDataSource()
        .getRepository(Reservation)
        .find({ where: { campaignId } }),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ orderId: second, quantity: 2 }),
        expect.objectContaining({ orderId: fresh, quantity: 1 }),
      ]),
    );
    expectConserved(covered);

    const sent = await service.sendDue(when);
    expect(sent.dispatched).toEqual([campaignId]);
    expect(sent.notSent).toEqual([]);
    const messages = await getDataSource()
      .getRepository(Message)
      .find({ where: { campaignId } });
    expect(messages).toHaveLength(3);
    const backing = new Map(
      messages.map((message) => [message.recipientId, message.orderId]),
    );
    expect(backing.get(recipientIds[0])).toBe(second);
    expect(backing.get(recipientIds[1])).toBe(second);
    expect(backing.get(recipientIds[2])).toBe(fresh);
    expect(messages.every((message) => message.orderId !== oldest)).toBe(true);
    expect(
      messages.every(
        (message) =>
          message.outcome === MessageOutcome.PENDING &&
          message.creditState === CreditState.RESERVED,
      ),
    ).toBe(true);

    const finalBalance = await service.getBalance(customerId);
    expect(finalBalance).toMatchObject({
      available: 0,
      reserved: 3,
      consumed: 0,
      debt: 0,
      unbackedInFlight: 0,
      explanations: [],
    });
    expect(finalBalance.campaigns[0]).toMatchObject({
      status: CampaignStatus.DISPATCHED,
      pending: 3,
      accepted: 0,
      rejected: 0,
      funded: 3,
      shortfall: 0,
    });
    expect(
      finalBalance.orders.find((order) => order.id === second),
    ).toMatchObject({
      reserved: 2,
      consumed: 0,
    });
    expect(
      finalBalance.orders.find((order) => order.id === fresh),
    ).toMatchObject({
      reserved: 1,
      consumed: 0,
    });
    expectConserved(finalBalance);
  });

  it('charges one credit when a rejection is followed by a higher acceptance', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 5 });
    const when = new Date('2026-06-02T00:00:00.000Z');
    const campaignId = randomUUID();
    const recipientId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await service.addRecipient({
      campaignId,
      recipientId,
      address: '+15552001',
    });
    await service.scheduleCampaign({ campaignId, scheduledAt: when });
    const sent = await service.sendDue(when);
    expect(sent.dispatched).toEqual([campaignId]);
    const message = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({ campaignId });

    await service.recordHandoff({
      eventId: 'reject-first',
      messageId: message.id,
      outcome: 'REJECTED',
      sequence: 1n,
    });
    const released = await service.getBalance(customerId);
    expect(released).toMatchObject({
      available: 5,
      reserved: 0,
      consumed: 0,
      debt: 0,
      unbackedInFlight: 0,
    });
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: message.id,
      }),
    ).toMatchObject({
      outcome: MessageOutcome.REJECTED,
      creditState: CreditState.RELEASED,
      orderId: null,
      outcomeSequence: 1n,
    });
    expectConserved(released);

    const acceptedEvent = {
      eventId: 'accept-later',
      messageId: message.id,
      outcome: 'ACCEPTED' as const,
      sequence: 2n,
    };
    await service.recordHandoff(acceptedEvent);
    const charged = await service.getBalance(customerId);
    expect(charged).toMatchObject({
      available: 4,
      reserved: 0,
      consumed: 1,
      debt: 0,
      unbackedInFlight: 0,
    });
    expect(charged.orders.find((order) => order.id === orderId)).toMatchObject({
      consumed: 1,
      reserved: 0,
    });
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: message.id,
      }),
    ).toMatchObject({
      outcome: MessageOutcome.ACCEPTED,
      creditState: CreditState.CONSUMED,
      orderId,
      outcomeSequence: 2n,
    });
    expectConserved(charged);

    await service.recordHandoff(acceptedEvent);
    expect(await service.getBalance(customerId)).toEqual(charged);
    expect(
      await getDataSource()
        .getRepository(HandoffEvent)
        .count({
          where: { messageId: message.id },
        }),
    ).toBe(2);

    await expect(
      service.recordHandoff({
        ...acceptedEvent,
        outcome: 'REJECTED',
      }),
    ).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    await expect(
      service.recordHandoff({
        ...acceptedEvent,
        eventId: 'different-event',
      }),
    ).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    expect(await service.getBalance(customerId)).toEqual(charged);
    expect(
      await getDataSource()
        .getRepository(HandoffEvent)
        .count({
          where: { messageId: message.id },
        }),
    ).toBe(2);
    expectConserved(charged);
  });

  it('pays an unbacked message before a shortfall, and a shortfall before debt', async () => {
    const customerId = randomUUID();
    const funding = randomUUID();
    await service.placeOrder({ orderId: funding, customerId, quantity: 3 });
    await stampOrder(funding, '2026-01-01T00:00:00.000Z');

    const dispatchAt = new Date('2026-05-01T00:00:00.000Z');
    const later = new Date('2026-09-01T00:00:00.000Z');
    const dispatchedId = randomUUID();
    const shortId = randomUUID();
    const acceptedRecipient = randomUUID();
    const pendingRecipient = randomUUID();
    const shortRecipient = randomUUID();

    await service.createCampaign({ campaignId: dispatchedId, customerId });
    await service.addRecipient({
      campaignId: dispatchedId,
      recipientId: acceptedRecipient,
      address: '+15553001',
    });
    await service.addRecipient({
      campaignId: dispatchedId,
      recipientId: pendingRecipient,
      address: '+15553002',
    });
    await service.scheduleCampaign({
      campaignId: dispatchedId,
      scheduledAt: dispatchAt,
    });

    await service.createCampaign({ campaignId: shortId, customerId });
    await service.addRecipient({
      campaignId: shortId,
      recipientId: shortRecipient,
      address: '+15553003',
    });
    await service.scheduleCampaign({ campaignId: shortId, scheduledAt: later });

    const sent = await service.sendDue(dispatchAt);
    expect(sent.dispatched).toEqual([dispatchedId]);
    expect(sent.notSent).toEqual([]);
    const acceptedMessage = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({ recipientId: acceptedRecipient });
    const pendingMessage = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({ recipientId: pendingRecipient });

    await service.recordHandoff({
      eventId: 'accept-one',
      messageId: acceptedMessage.id,
      outcome: 'ACCEPTED',
      sequence: 1n,
    });
    await service.cancelOrder(funding);

    const afterCancel = await service.getBalance(customerId);
    expect(afterCancel).toMatchObject({
      available: 0,
      reserved: 0,
      consumed: 0,
      debt: 1,
      unbackedInFlight: 1,
    });
    expect(
      afterCancel.campaigns.find((campaign) => campaign.id === shortId),
    ).toMatchObject({
      status: CampaignStatus.SCHEDULED,
      funded: 0,
      shortfall: 1,
    });
    expect(afterCancel.explanations).toEqual([
      `1 accepted message(s) are debt on cancelled order(s) ${funding}.`,
      '1 in-flight message(s) have no order backing them.',
      `Order ${funding} was cancelled. Shortfall is 1 credit(s).`,
    ]);
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: acceptedMessage.id,
      }),
    ).toMatchObject({
      outcome: MessageOutcome.ACCEPTED,
      creditState: CreditState.CONSUMED,
      orderId: funding,
    });
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: pendingMessage.id,
      }),
    ).toMatchObject({
      outcome: MessageOutcome.PENDING,
      creditState: CreditState.RESERVED,
      orderId: null,
    });
    expectConserved(afterCancel);

    const replacement = randomUUID();
    await service.placeOrder({
      orderId: replacement,
      customerId,
      quantity: 1,
    });
    const afterTopUp = await service.getBalance(customerId);
    expect(afterTopUp).toMatchObject({
      available: 0,
      reserved: 1,
      consumed: 0,
      debt: 1,
      unbackedInFlight: 0,
    });
    expect(
      afterTopUp.campaigns.find((campaign) => campaign.id === shortId),
    ).toMatchObject({ funded: 0, shortfall: 1 });
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: pendingMessage.id,
      }),
    ).toMatchObject({
      orderId: replacement,
      outcome: MessageOutcome.PENDING,
      creditState: CreditState.RESERVED,
    });
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: acceptedMessage.id,
      }),
    ).toMatchObject({ orderId: funding, creditState: CreditState.CONSUMED });
    expect(afterTopUp.explanations).toEqual([
      `1 accepted message(s) are debt on cancelled order(s) ${funding}.`,
      `Order ${funding} was cancelled. Shortfall is 1 credit(s).`,
    ]);
    expectConserved(afterTopUp);

    await service.recordHandoff({
      eventId: 'reject-pending',
      messageId: pendingMessage.id,
      outcome: 'REJECTED',
      sequence: 1n,
    });
    const finalBalance = await service.getBalance(customerId);
    expect(finalBalance).toMatchObject({
      available: 0,
      reserved: 1,
      consumed: 0,
      debt: 1,
      unbackedInFlight: 0,
    });
    expect(
      finalBalance.campaigns.find((campaign) => campaign.id === shortId),
    ).toMatchObject({
      status: CampaignStatus.SCHEDULED,
      funded: 1,
      shortfall: 0,
    });
    expect(
      finalBalance.campaigns.find((campaign) => campaign.id === dispatchedId),
    ).toMatchObject({
      status: CampaignStatus.DISPATCHED,
      accepted: 1,
      rejected: 1,
      pending: 0,
    });
    expect(
      finalBalance.orders.find((order) => order.id === replacement),
    ).toMatchObject({
      reserved: 1,
      consumed: 0,
      status: OrderStatus.ACTIVE,
    });
    expect(
      finalBalance.orders.find((order) => order.id === funding),
    ).toMatchObject({
      status: OrderStatus.CANCELLED,
      consumed: 1,
      reserved: 0,
    });
    expect(
      await getDataSource()
        .getRepository(Reservation)
        .find({
          where: { campaignId: shortId },
        }),
    ).toEqual([expect.objectContaining({ orderId: replacement, quantity: 1 })]);
    expect(
      await getDataSource().getRepository(Message).findOneByOrFail({
        id: pendingMessage.id,
      }),
    ).toMatchObject({
      outcome: MessageOutcome.REJECTED,
      creditState: CreditState.RELEASED,
      orderId: null,
      outcomeSequence: 1n,
    });
    expect(finalBalance.explanations).toEqual([
      `1 accepted message(s) are debt on cancelled order(s) ${funding}.`,
    ]);
    expectConserved(finalBalance);
  });
});
