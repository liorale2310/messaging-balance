import { randomUUID } from 'node:crypto';
import { AccountingService } from '../../src/accounting/accounting.service';
import { Balance } from '../../src/accounting/domain/balance.projection';
import { CampaignStatus } from '../../src/accounting/entities/campaign.entity';
import { OrderStatus } from '../../src/accounting/entities/order.entity';
import { Recipient } from '../../src/accounting/entities/recipient.entity';
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

describe('campaign reservations', () => {
  let service: AccountingService;

  beforeAll(() => {
    service = new AccountingService(getDataSource());
  });

  async function customerWithCredit(quantity: number): Promise<{
    customerId: string;
    orderId: string;
  }> {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity });
    return { customerId, orderId };
  }

  it('does not reserve credit while a campaign is still a draft', async () => {
    const { customerId } = await customerWithCredit(3);
    const campaignId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await service.addRecipient({
      campaignId,
      recipientId: randomUUID(),
      address: '  +15551111 ',
    });
    await service.addRecipient({
      campaignId,
      recipientId: randomUUID(),
      address: '+15552222',
    });

    const balance = await service.getBalance(customerId);
    expect(balance.available).toBe(3);
    expect(balance.reserved).toBe(0);
    expect(balance.campaigns[0]).toMatchObject({
      id: campaignId,
      status: CampaignStatus.DRAFT,
      recipientCount: 2,
      funded: 0,
      shortfall: 0,
    });
    expectConserved(balance);
  });

  it('reserves one credit per recipient and refuses what does not fit', async () => {
    const { customerId, orderId } = await customerWithCredit(2);
    const older = orderId;
    const newer = randomUUID();
    await service.placeOrder({
      orderId: newer,
      customerId,
      quantity: 1,
    });
    const campaignId = randomUUID();
    const refusedCampaignId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await service.createCampaign({ campaignId: refusedCampaignId, customerId });
    for (const address of ['+15550001', '+15550002', '+15550003']) {
      await service.addRecipient({
        campaignId,
        recipientId: randomUUID(),
        address,
      });
    }
    const scheduledAt = new Date('2026-06-01T00:00:00.000Z');
    await service.scheduleCampaign({ campaignId, scheduledAt });

    await service.addRecipient({
      campaignId: refusedCampaignId,
      recipientId: randomUUID(),
      address: '+15558888',
    });
    await expect(
      service.scheduleCampaign({
        campaignId: refusedCampaignId,
        scheduledAt,
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDIT',
    });
    const refusedRecipient = randomUUID();
    await expect(
      service.addRecipient({
        campaignId,
        recipientId: refusedRecipient,
        address: '+15559999',
      }),
    ).rejects.toMatchObject({
      code: 'INSUFFICIENT_CREDIT',
      message: expect.stringContaining(
        'available 0, reserved 3, debt 0',
      ) as unknown,
    });

    const balance = await service.getBalance(customerId);
    expect(balance.available).toBe(0);
    expect(balance.reserved).toBe(3);
    expect(balance.orders.find((order) => order.id === older)).toMatchObject({
      reserved: 2,
    });
    expect(balance.orders.find((order) => order.id === newer)).toMatchObject({
      reserved: 1,
    });
    expect(
      balance.campaigns.find((campaign) => campaign.id === campaignId),
    ).toMatchObject({
      status: CampaignStatus.SCHEDULED,
      recipientCount: 3,
      funded: 3,
      shortfall: 0,
    });
    expect(
      await getDataSource()
        .getRepository(Recipient)
        .count({
          where: { id: refusedRecipient },
        }),
    ).toBe(0);
    expect(
      await getDataSource()
        .getRepository(Reservation)
        .count({
          where: { campaignId: refusedCampaignId },
        }),
    ).toBe(0);
    expectConserved(balance);
  });

  it('lets one of two concurrent schedules take the last credit', async () => {
    const { customerId } = await customerWithCredit(1);
    const first = randomUUID();
    const second = randomUUID();
    const when = new Date('2026-07-01T00:00:00.000Z');
    for (const campaignId of [first, second]) {
      await service.createCampaign({ campaignId, customerId });
      await service.addRecipient({
        campaignId,
        recipientId: randomUUID(),
        address: campaignId,
      });
    }

    const results = await Promise.allSettled([
      service.scheduleCampaign({ campaignId: first, scheduledAt: when }),
      service.scheduleCampaign({ campaignId: second, scheduledAt: when }),
    ]);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toMatchObject({
      code: 'INSUFFICIENT_CREDIT',
    });

    const reservations = await getDataSource()
      .getRepository(Reservation)
      .find();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].quantity).toBe(1);
    const balance = await service.getBalance(customerId);
    expect(balance.reserved).toBe(1);
    expect(balance.available).toBe(0);
    expectConserved(balance);
  });

  it('refuses an empty schedule, allows a past time, and releases credit on cancel', async () => {
    const { customerId } = await customerWithCredit(1);
    const campaignId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await expect(
      service.scheduleCampaign({
        campaignId,
        scheduledAt: new Date('2020-01-01T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'EMPTY_CAMPAIGN' });

    await service.addRecipient({
      campaignId,
      recipientId: randomUUID(),
      address: '+15550000',
    });
    const past = new Date('2020-01-01T00:00:00.000Z');
    const scheduled = await service.scheduleCampaign({
      campaignId,
      scheduledAt: past,
    });
    const replayed = await service.scheduleCampaign({
      campaignId,
      scheduledAt: past,
    });
    expect(scheduled.status).toBe(CampaignStatus.SCHEDULED);
    expect(replayed.scheduledAt).toEqual(scheduled.scheduledAt);

    const draft = await service.cancelSchedule(campaignId);
    const balance = await service.getBalance(customerId);
    expect(draft.status).toBe(CampaignStatus.DRAFT);
    expect(draft.scheduledAt).toBeNull();
    expect(balance.available).toBe(1);
    expect(balance.reserved).toBe(0);
    expectConserved(balance);
  });

  it('names the cancelled order when a scheduled campaign is left short', async () => {
    const { customerId, orderId } = await customerWithCredit(1);
    const campaignId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await service.addRecipient({
      campaignId,
      recipientId: randomUUID(),
      address: '+15551212',
    });
    await service.scheduleCampaign({
      campaignId,
      scheduledAt: new Date('2026-08-01T00:00:00.000Z'),
    });

    await service.cancelOrder(orderId);
    const balance = await service.getBalance(customerId);
    const campaign = balance.campaigns.find((item) => item.id === campaignId);
    expect(campaign).toMatchObject({
      status: CampaignStatus.SCHEDULED,
      funded: 0,
      shortfall: 1,
    });
    expect(balance.available).toBe(0);
    expect(balance.explanations.join(' ')).toContain(orderId);
    expect(balance.explanations.join(' ')).toContain('1');
    expectConserved(balance);

    const replacement = randomUUID();
    await service.placeOrder({
      orderId: replacement,
      customerId,
      quantity: 1,
    });
    const toppedUp = await service.getBalance(customerId);
    expect(
      toppedUp.campaigns.find((item) => item.id === campaignId),
    ).toMatchObject({ funded: 1, shortfall: 0 });
    expect(toppedUp.available).toBe(0);
    expect(toppedUp.explanations).toEqual([]);
    expectConserved(toppedUp);
  });

  it('rejects a duplicate address and a second schedule time', async () => {
    const { customerId } = await customerWithCredit(2);
    const campaignId = randomUUID();
    await service.createCampaign({ campaignId, customerId });
    await service.addRecipient({
      campaignId,
      recipientId: randomUUID(),
      address: '+15550001',
    });
    await expect(
      service.addRecipient({
        campaignId,
        recipientId: randomUUID(),
        address: '+15550001',
      }),
    ).rejects.toMatchObject({ code: 'DUPLICATE_RECIPIENT' });

    const when = new Date('2026-09-01T00:00:00.000Z');
    await service.scheduleCampaign({ campaignId, scheduledAt: when });
    await expect(
      service.scheduleCampaign({
        campaignId,
        scheduledAt: new Date('2026-09-02T00:00:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'SCHEDULE_CONFLICT' });
    const balance = await service.getBalance(customerId);
    expect(balance.reserved).toBe(1);
    expectConserved(balance);
  });
});
