import { allocateFifo, coverOutstanding } from './allocation.policy';

describe('allocateFifo', () => {
  it('fills the oldest lot before the next one', () => {
    expect(
      allocateFifo(
        [
          { orderId: 'older', remaining: 2 },
          { orderId: 'newer', remaining: 5 },
        ],
        4,
      ),
    ).toEqual({
      pieces: [
        { orderId: 'older', quantity: 2 },
        { orderId: 'newer', quantity: 2 },
      ],
      uncovered: 0,
    });
  });

  it('reports the credits that no lot can cover', () => {
    expect(allocateFifo([{ orderId: 'only', remaining: 1 }], 3).uncovered).toBe(
      2,
    );
  });
});

describe('coverOutstanding', () => {
  it('covers an in-flight message, then a shortfall, then debt', () => {
    const plan = coverOutstanding({
      lots: [{ orderId: 'fresh', remaining: 3 }],
      unbackedMessageIds: ['in-flight'],
      shortfalls: [{ campaignId: 'campaign', missing: 1 }],
      debtMessageIds: ['debt-old', 'debt-left'],
    });

    expect(plan.assignments).toEqual([
      { messageId: 'in-flight', orderId: 'fresh' },
      { messageId: 'debt-old', orderId: 'fresh' },
    ]);
    expect(plan.reservationAdds).toEqual([
      { campaignId: 'campaign', orderId: 'fresh', quantity: 1 },
    ]);
  });
});
