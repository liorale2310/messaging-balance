import { randomUUID } from 'node:crypto';
import { AccountingService } from '../../src/accounting/accounting.service';
import { Balance } from '../../src/accounting/domain/balance.projection';
import { CampaignStatus } from '../../src/accounting/entities/campaign.entity';
import { HandoffEvent } from '../../src/accounting/entities/handoff-event.entity';
import {
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

describe('send and handoff', () => {
  let service: AccountingService;

  beforeAll(() => {
    service = new AccountingService(getDataSource());
  });

  async function scheduledCampaign(input: {
    customerId: string;
    addresses: string[];
    scheduledAt: Date;
  }): Promise<{ campaignId: string; recipientIds: string[] }> {
    const campaignId = randomUUID();
    const recipientIds = input.addresses.map(() => randomUUID());
    await service.createCampaign({ campaignId, customerId: input.customerId });
    for (const [index, address] of input.addresses.entries()) {
      await service.addRecipient({
        campaignId,
        recipientId: recipientIds[index],
        address,
      });
    }
    await service.scheduleCampaign({
      campaignId,
      scheduledAt: input.scheduledAt,
    });
    return { campaignId, recipientIds };
  }

  it('walks a campaign from purchase through release, send, accept, and reject', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 1 });
    const when = new Date('2026-04-01T00:00:00.000Z');
    const { campaignId } = await scheduledCampaign({
      customerId,
      addresses: ['+15550001'],
      scheduledAt: when,
    });
    expect((await service.getBalance(customerId)).reserved).toBe(1);

    await service.cancelSchedule(campaignId);
    expect((await service.getBalance(customerId)).available).toBe(1);

    await service.scheduleCampaign({ campaignId, scheduledAt: when });
    const sent = await service.sendDue(when);
    expect(sent.dispatched).toEqual([campaignId]);
    const afterSend = await service.getBalance(customerId);
    expect(afterSend.campaigns[0]).toMatchObject({
      status: CampaignStatus.DISPATCHED,
      pending: 1,
      accepted: 0,
    });
    expect(afterSend.reserved).toBe(1);
    expectConserved(afterSend);

    const message = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        campaignId,
      });
    await service.recordHandoff({
      eventId: 'accept-once',
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: 1n,
    });
    const accepted = await service.getBalance(customerId);
    expect(accepted.consumed).toBe(1);
    expect(accepted.available).toBe(0);
    expectConserved(accepted);

    await service.recordHandoff({
      eventId: 'accept-once',
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: 1n,
    });
    expect((await service.getBalance(customerId)).consumed).toBe(1);

    await service.recordHandoff({
      eventId: 'reject-later',
      messageId: message.id,
      outcome: 'REJECTED',
      sequence: 2n,
    });
    const released = await service.getBalance(customerId);
    expect(released.consumed).toBe(0);
    expect(released.available).toBe(1);
    expect(released.campaigns[0].rejected).toBe(1);
    expectConserved(released);
  });

  it('shows debt after a consumed order is cancelled and settles it before new availability', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 1 });
    const when = new Date('2026-04-02T00:00:00.000Z');
    const { campaignId } = await scheduledCampaign({
      customerId,
      addresses: ['+15550002'],
      scheduledAt: when,
    });
    await service.sendDue(when);
    const message = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        campaignId,
      });
    await service.recordHandoff({
      eventId: randomUUID(),
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: 1n,
    });

    await service.cancelOrder(orderId);
    const inDebt = await service.getBalance(customerId);
    expect(inDebt.debt).toBe(1);
    expect(inDebt.available).toBe(0);
    expect(inDebt.orders.find((order) => order.id === orderId)).toMatchObject({
      status: OrderStatus.CANCELLED,
      reserved: 0,
      consumed: 1,
    });
    expect(inDebt.explanations.join(' ')).toContain(orderId);
    expect(
      await getDataSource().getRepository(Reservation).count({
        where: { orderId },
      }),
    ).toBe(0);
    expectConserved(inDebt);

    const replacement = randomUUID();
    await service.placeOrder({
      orderId: replacement,
      customerId,
      quantity: 1,
    });
    const settled = await service.getBalance(customerId);
    expect(settled.debt).toBe(0);
    expect(settled.available).toBe(0);
    expect(settled.consumed).toBe(1);
    expect(settled.orders.find((order) => order.id === orderId)?.consumed).toBe(
      0,
    );
    expect(
      settled.orders.find((order) => order.id === replacement)?.consumed,
    ).toBe(1);
    expectConserved(settled);
  });

  it('keeps one message per recipient when sendDue runs twice and overlaps', async () => {
    const customerId = randomUUID();
    const older = randomUUID();
    const newer = randomUUID();
    await service.placeOrder({ orderId: older, customerId, quantity: 2 });
    await service.placeOrder({ orderId: newer, customerId, quantity: 1 });
    const when = new Date('2026-04-03T00:00:00.000Z');
    const { campaignId, recipientIds } = await scheduledCampaign({
      customerId,
      addresses: ['+15551111', '+15552222', '+15553333'],
      scheduledAt: when,
    });
    const dataSource = getDataSource();
    await dataSource.query(`UPDATE orders SET placed_at = $1 WHERE id = $2`, [
      new Date('2026-01-01T00:00:00.000Z'),
      older,
    ]);
    await dataSource.query(`UPDATE orders SET placed_at = $1 WHERE id = $2`, [
      new Date('2026-02-01T00:00:00.000Z'),
      newer,
    ]);
    for (const [index, recipientId] of recipientIds.entries()) {
      await dataSource.query(
        `UPDATE recipients SET created_at = $1 WHERE id = $2`,
        [new Date(Date.UTC(2026, 0, index + 1)), recipientId],
      );
    }

    const [first, second] = await Promise.all([
      service.sendDue(when),
      service.sendDue(when),
    ]);
    const again = await service.sendDue(when);
    expect(again.dispatched).toEqual([]);
    expect(first.dispatched.concat(second.dispatched).sort()).toEqual([
      campaignId,
    ]);

    const messages = await dataSource.getRepository(Message).find({
      where: { campaignId },
      order: { recipientId: 'ASC' },
    });
    expect(messages).toHaveLength(3);
    const byRecipient = new Map(
      messages.map((message) => [message.recipientId, message.orderId]),
    );
    expect(byRecipient.get(recipientIds[0])).toBe(older);
    expect(byRecipient.get(recipientIds[1])).toBe(older);
    expect(byRecipient.get(recipientIds[2])).toBe(newer);
    const balance = await service.getBalance(customerId);
    expect(balance.campaigns[0].status).toBe(CampaignStatus.DISPATCHED);
    expect(balance.reserved).toBe(3);
    expectConserved(balance);
  });

  it('does not send before the scheduled time and does not retry a short campaign', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 1 });
    const when = new Date('2026-05-01T00:00:00.000Z');
    const { campaignId } = await scheduledCampaign({
      customerId,
      addresses: ['+15554444'],
      scheduledAt: when,
    });
    const early = await service.sendDue(new Date('2026-04-30T00:00:00.000Z'));
    expect(early.dispatched).toEqual([]);
    expect(early.notSent).toEqual([]);
    expect((await service.getBalance(customerId)).reserved).toBe(1);

    await service.cancelOrder(orderId);
    const refused = await service.sendDue(when);
    expect(refused.notSent).toEqual([campaignId]);
    const balance = await service.getBalance(customerId);
    expect(balance.campaigns[0]).toMatchObject({
      status: CampaignStatus.NOT_SENT,
      pending: 0,
    });
    expect(balance.explanations.join(' ')).toContain('0 of 1');
    expect(balance.explanations.join(' ')).toContain(orderId);
    expectConserved(balance);

    const replacement = randomUUID();
    await service.placeOrder({
      orderId: replacement,
      customerId,
      quantity: 1,
    });
    const retried = await service.sendDue(when);
    expect(retried.dispatched).toEqual([]);
    expect(retried.notSent).toEqual([]);
    const later = await service.getBalance(customerId);
    expect(later.campaigns[0].status).toBe(CampaignStatus.NOT_SENT);
    expect(later.available).toBe(1);
    expectConserved(later);
  });

  it('rejects a conflicting or stale handoff and charges only free credit on a late accept', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 1 });
    const when = new Date('2026-06-01T00:00:00.000Z');
    const first = await scheduledCampaign({
      customerId,
      addresses: ['+15555555'],
      scheduledAt: when,
    });
    await service.sendDue(when);
    const message = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        campaignId: first.campaignId,
      });

    await service.recordHandoff({
      eventId: 'stored',
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: 3n,
    });
    const beforeConflict = await service.getBalance(customerId);
    await expect(
      service.recordHandoff({
        eventId: 'stored',
        messageId: message.id,
        outcome: 'REJECTED',
        sequence: 3n,
      }),
    ).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    await expect(
      service.recordHandoff({
        eventId: 'other-event',
        messageId: message.id,
        outcome: 'ACCEPTED',
        sequence: 3n,
      }),
    ).rejects.toMatchObject({ code: 'HANDOFF_CONFLICT' });
    await expect(
      service.recordHandoff({
        eventId: 'missing',
        messageId: randomUUID(),
        outcome: 'ACCEPTED',
        sequence: 1n,
      }),
    ).rejects.toMatchObject({ code: 'MESSAGE_NOT_FOUND' });
    expect(await service.getBalance(customerId)).toEqual(beforeConflict);

    await service.recordHandoff({
      eventId: 'older',
      messageId: message.id,
      outcome: 'REJECTED',
      sequence: 2n,
    });
    const stored = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        id: message.id,
      });
    expect(stored.outcome).toBe(MessageOutcome.ACCEPTED);
    expect(stored.outcomeSequence).toBe(3n);
    expect(
      await getDataSource()
        .getRepository(HandoffEvent)
        .count({
          where: { messageId: message.id },
        }),
    ).toBe(2);

    await service.recordHandoff({
      eventId: 'release',
      messageId: message.id,
      outcome: 'REJECTED',
      sequence: 4n,
    });
    const second = await scheduledCampaign({
      customerId,
      addresses: ['+15556666'],
      scheduledAt: when,
    });
    await service.recordHandoff({
      eventId: 'late-accept',
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: 5n,
    });
    const balance = await service.getBalance(customerId);
    expect(balance.debt).toBe(1);
    expect(balance.reserved).toBe(1);
    expect(balance.available).toBe(0);
    expect(
      await getDataSource()
        .getRepository(Reservation)
        .count({
          where: { campaignId: second.campaignId },
        }),
    ).toBe(1);
    const late = await getDataSource().getRepository(Message).findOneByOrFail({
      id: message.id,
    });
    expect(late.orderId).toBeNull();
    expectConserved(balance);
  });

  it('applies a rejection whose sequence is one past the safe integer range', async () => {
    const customerId = randomUUID();
    await service.placeOrder({
      orderId: randomUUID(),
      customerId,
      quantity: 1,
    });
    const when = new Date('2026-07-01T00:00:00.000Z');
    const { campaignId } = await scheduledCampaign({
      customerId,
      addresses: ['+15557777'],
      scheduledAt: when,
    });
    await service.sendDue(when);
    const message = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        campaignId,
      });
    const low = 9007199254740992n;
    const high = 9007199254740993n;
    await service.recordHandoff({
      eventId: 'low',
      messageId: message.id,
      outcome: 'ACCEPTED',
      sequence: low,
    });
    await service.recordHandoff({
      eventId: 'high',
      messageId: message.id,
      outcome: 'REJECTED',
      sequence: high,
    });
    const stored = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        id: message.id,
      });
    expect(stored.outcome).toBe(MessageOutcome.REJECTED);
    expect(stored.outcomeSequence).toBe(high);
    expect(stored.outcomeSequence).toBeGreaterThan(low);
    const balance = await service.getBalance(customerId);
    expect(balance.available).toBe(1);
    expect(balance.consumed).toBe(0);
    expectConserved(balance);
  });

  it('re-homes a pending hold and backs an unbacked message before a new schedule', async () => {
    const customerId = randomUUID();
    const older = randomUUID();
    const newer = randomUUID();
    await service.placeOrder({ orderId: older, customerId, quantity: 1 });
    await service.placeOrder({ orderId: newer, customerId, quantity: 1 });
    const when = new Date('2026-08-01T00:00:00.000Z');
    const { campaignId } = await scheduledCampaign({
      customerId,
      addresses: ['+15558888'],
      scheduledAt: when,
    });
    await service.sendDue(when);
    await service.cancelOrder(older);
    const moved = await getDataSource().getRepository(Message).findOneByOrFail({
      campaignId,
    });
    expect(moved.orderId).toBe(newer);
    const afterMove = await service.getBalance(customerId);
    expect(afterMove.unbackedInFlight).toBe(0);
    expect(afterMove.reserved).toBe(1);
    expectConserved(afterMove);

    await service.cancelOrder(newer);
    const unbacked = await service.getBalance(customerId);
    expect(unbacked.unbackedInFlight).toBe(1);
    expect(unbacked.available).toBe(0);
    expectConserved(unbacked);

    const fresh = randomUUID();
    await service.placeOrder({ orderId: fresh, customerId, quantity: 1 });
    const backed = await getDataSource()
      .getRepository(Message)
      .findOneByOrFail({
        campaignId,
      });
    expect(backed.orderId).toBe(fresh);
    const other = randomUUID();
    await service.createCampaign({ campaignId: other, customerId });
    await service.addRecipient({
      campaignId: other,
      recipientId: randomUUID(),
      address: '+15559999',
    });
    await expect(
      service.scheduleCampaign({ campaignId: other, scheduledAt: when }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_CREDIT' });

    await expect(
      service.addRecipient({
        campaignId,
        recipientId: randomUUID(),
        address: '+15550000',
      }),
    ).rejects.toMatchObject({ code: 'CAMPAIGN_NOT_EDITABLE' });
    await expect(service.cancelSchedule(campaignId)).rejects.toMatchObject({
      code: 'CAMPAIGN_NOT_EDITABLE',
    });
  });
});
