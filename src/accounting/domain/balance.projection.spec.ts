import { CampaignStatus } from '../entities/campaign.entity';
import { CreditState, MessageOutcome } from '../entities/message.entity';
import { OrderStatus } from '../entities/order.entity';
import {
  Books,
  assertConservation,
  projectBalance,
} from './balance.projection';

function books(overrides: Partial<Books> = {}): Books {
  return {
    orders: [],
    campaigns: [],
    reservations: [],
    messages: [],
    ...overrides,
  };
}

describe('projectBalance', () => {
  it('keeps available equal to active quantity when nothing is held', () => {
    const balance = projectBalance(
      books({
        orders: [
          {
            id: 'b',
            quantity: 2,
            status: OrderStatus.ACTIVE,
            placedAt: new Date('2026-02-01T00:00:00.000Z'),
            cancelledAt: null,
          },
          {
            id: 'a',
            quantity: 4,
            status: OrderStatus.CANCELLED,
            placedAt: new Date('2026-01-01T00:00:00.000Z'),
            cancelledAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ],
      }),
    );

    expect(balance.available).toBe(2);
    expect(balance.reserved).toBe(0);
    expect(balance.consumed).toBe(0);
    expect(balance.debt).toBe(0);
    expect(balance.orders.map((order) => order.id)).toEqual(['a', 'b']);
    expect(() =>
      assertConservation(books({ orders: balance.orders })),
    ).not.toThrow();
  });

  it('refuses available credit while a cancelled order still has consumed messages', () => {
    const snapshot = books({
      orders: [
        {
          id: 'active',
          quantity: 5,
          status: OrderStatus.ACTIVE,
          placedAt: new Date('2026-03-01T00:00:00.000Z'),
          cancelledAt: null,
        },
        {
          id: 'cancelled',
          quantity: 1,
          status: OrderStatus.CANCELLED,
          placedAt: new Date('2026-01-01T00:00:00.000Z'),
          cancelledAt: new Date('2026-01-02T00:00:00.000Z'),
        },
      ],
      messages: [
        {
          id: 'message',
          campaignId: 'campaign',
          orderId: 'cancelled',
          outcome: MessageOutcome.ACCEPTED,
          creditState: CreditState.CONSUMED,
        },
      ],
    });

    const balance = projectBalance(snapshot);
    expect(balance.available).toBe(5);
    expect(balance.debt).toBe(1);
    expect(balance.explanations[0]).toContain('cancelled');
    expect(() => assertConservation(snapshot)).toThrow(/available is 5/);
  });

  it('refuses a lot that is asked to cover more credit than it holds', () => {
    const snapshot = books({
      orders: [
        {
          id: 'active',
          quantity: 1,
          status: OrderStatus.ACTIVE,
          placedAt: new Date('2026-01-01T00:00:00.000Z'),
          cancelledAt: null,
        },
      ],
      campaigns: [
        {
          id: 'campaign',
          status: CampaignStatus.SCHEDULED,
          scheduledAt: new Date('2026-01-02T00:00:00.000Z'),
          fundingNote: null,
          notSentReason: null,
          recipientCount: 2,
        },
      ],
      reservations: [
        { campaignId: 'campaign', orderId: 'active', quantity: 2 },
      ],
    });

    expect(projectBalance(snapshot).available).toBe(-1);
    expect(() => assertConservation(snapshot)).toThrow(/holds 2 of 1/);
  });
});
