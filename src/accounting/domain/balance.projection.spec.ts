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
  it('keeps cancelled quantity out of available credit', () => {
    const balance = projectBalance(
      books({
        orders: [
          {
            id: 'a',
            quantity: 5,
            status: OrderStatus.ACTIVE,
            placedAt: new Date('2026-01-01T00:00:00.000Z'),
            cancelledAt: null,
          },
          {
            id: 'b',
            quantity: 3,
            status: OrderStatus.CANCELLED,
            placedAt: new Date('2026-01-02T00:00:00.000Z'),
            cancelledAt: new Date('2026-01-03T00:00:00.000Z'),
          },
        ],
      }),
    );

    expect(balance.available).toBe(5);
    expect(balance.reserved).toBe(0);
    expect(balance.consumed).toBe(0);
    expect(balance.debt).toBe(0);
    expect(() =>
      assertConservation(
        books({
          orders: [
            {
              id: 'a',
              quantity: 5,
              status: OrderStatus.ACTIVE,
              placedAt: new Date('2026-01-01T00:00:00.000Z'),
              cancelledAt: null,
            },
            {
              id: 'b',
              quantity: 3,
              status: OrderStatus.CANCELLED,
              placedAt: new Date('2026-01-02T00:00:00.000Z'),
              cancelledAt: new Date('2026-01-03T00:00:00.000Z'),
            },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it('refuses available credit while a consumed message is debt', () => {
    const snapshot = books({
      orders: [
        {
          id: 'active',
          quantity: 2,
          status: OrderStatus.ACTIVE,
          placedAt: new Date('2026-01-01T00:00:00.000Z'),
          cancelledAt: null,
        },
        {
          id: 'cancelled',
          quantity: 1,
          status: OrderStatus.CANCELLED,
          placedAt: new Date('2026-01-02T00:00:00.000Z'),
          cancelledAt: new Date('2026-01-03T00:00:00.000Z'),
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
      campaigns: [
        {
          id: 'campaign',
          status: CampaignStatus.DISPATCHED,
          scheduledAt: new Date('2026-01-04T00:00:00.000Z'),
          fundingNote: null,
          notSentReason: null,
          recipientCount: 1,
        },
      ],
    });

    const balance = projectBalance(snapshot);
    expect(balance.available).toBe(2);
    expect(balance.debt).toBe(1);
    expect(balance.explanations[0]).toContain('cancelled');
    expect(() => assertConservation(snapshot)).toThrow(
      /available is 2 while debt is 1/,
    );
  });
});
