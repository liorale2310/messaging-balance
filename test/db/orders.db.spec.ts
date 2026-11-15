import { randomUUID } from 'node:crypto';
import { AccountingError } from '../../src/accounting/accounting.errors';
import { AccountingService } from '../../src/accounting/accounting.service';
import { Balance } from '../../src/accounting/domain/balance.projection';
import { Customer } from '../../src/accounting/entities/customer.entity';
import { Order, OrderStatus } from '../../src/accounting/entities/order.entity';
import { getDataSource } from './harness';

function expectConserved(balance: Balance): void {
  const activeQuantity = balance.orders
    .filter((order) => order.status === OrderStatus.ACTIVE)
    .reduce((sum, order) => sum + order.quantity, 0);
  expect(activeQuantity).toBe(
    balance.available + balance.reserved + balance.consumed,
  );
  expect(balance.available).toBeGreaterThanOrEqual(0);
  expect(balance.debt).toBe(0);
  expect(balance.unbackedInFlight).toBe(0);
  expect(balance.campaigns.every((campaign) => campaign.shortfall === 0)).toBe(
    true,
  );
}

describe('orders and balance', () => {
  let service: AccountingService;

  beforeAll(() => {
    service = new AccountingService(getDataSource());
  });

  it('places an order, replays it, and shows the credit as available', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    const placed = await service.placeOrder({
      orderId,
      customerId,
      quantity: 5,
    });
    const replayed = await service.placeOrder({
      orderId,
      customerId,
      quantity: 5,
    });
    const balance = await service.getBalance(customerId);

    expect(replayed).toEqual(placed);
    expect(placed.status).toBe(OrderStatus.ACTIVE);
    expect(placed.quantity).toBe(5);
    expect(balance.available).toBe(5);
    expect(balance.orders).toEqual([
      expect.objectContaining({
        id: orderId,
        quantity: 5,
        reserved: 0,
        consumed: 0,
        status: OrderStatus.ACTIVE,
      }),
    ]);
    expect(balance.explanations).toEqual([]);
    expectConserved(balance);

    expect(
      await getDataSource()
        .getRepository(Customer)
        .count({
          where: { id: customerId },
        }),
    ).toBe(1);
    expect(
      await getDataSource()
        .getRepository(Order)
        .count({
          where: { id: orderId },
        }),
    ).toBe(1);
  });

  it('rejects a replay that changes the customer or the quantity', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    await service.placeOrder({ orderId, customerId, quantity: 2 });

    await expect(
      service.placeOrder({
        orderId,
        customerId,
        quantity: 3,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_CONFLICT' });
    await expect(
      service.placeOrder({
        orderId,
        customerId: randomUUID(),
        quantity: 2,
      }),
    ).rejects.toMatchObject({ code: 'ORDER_CONFLICT' });

    const balance = await service.getBalance(customerId);
    expect(balance.available).toBe(2);
    expectConserved(balance);
  });

  it('rejects quantities outside a positive whole number up to 1000000', async () => {
    const customerId = randomUUID();
    for (const quantity of [0, -1, 1.5, 1_000_001, Number.NaN]) {
      await expect(
        service.placeOrder({
          orderId: randomUUID(),
          customerId,
          quantity,
        }),
      ).rejects.toBeInstanceOf(AccountingError);
      await expect(
        service.placeOrder({
          orderId: randomUUID(),
          customerId,
          quantity,
        }),
      ).rejects.toMatchObject({ code: 'INVALID_QUANTITY' });
    }

    const balance = await service.getBalance(customerId);
    expect(balance).toMatchObject({ available: 0, orders: [] });
    const customers = await getDataSource()
      .getRepository(Customer)
      .count({
        where: { id: customerId },
      });
    expect(customers).toBe(0);
  });

  it('cancels an order once and removes its credit from available', async () => {
    const customerId = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    await service.placeOrder({
      orderId: first,
      customerId,
      quantity: 4,
    });
    await service.placeOrder({
      orderId: second,
      customerId,
      quantity: 6,
    });

    const cancelled = await service.cancelOrder(first);
    const again = await service.cancelOrder(first);
    const balance = await service.getBalance(customerId);

    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.cancelledAt).toBeInstanceOf(Date);
    expect(again.cancelledAt).toEqual(cancelled.cancelledAt);
    expect(balance.available).toBe(6);
    expect(balance.orders).toHaveLength(2);
    expect(balance.orders.find((order) => order.id === first)).toMatchObject({
      status: OrderStatus.CANCELLED,
      quantity: 4,
      reserved: 0,
    });
    expectConserved(balance);
  });

  it('refuses to cancel an unknown order', async () => {
    await expect(service.cancelOrder(randomUUID())).rejects.toMatchObject({
      code: 'ORDER_NOT_FOUND',
    });
  });

  it('returns an empty balance for an unknown customer', async () => {
    const balance = await service.getBalance(randomUUID());
    expect(balance).toEqual({
      available: 0,
      reserved: 0,
      consumed: 0,
      debt: 0,
      unbackedInFlight: 0,
      orders: [],
      campaigns: [],
      explanations: [],
    });
  });

  it('treats concurrent identical replays as one order', async () => {
    const customerId = randomUUID();
    const orderId = randomUUID();
    const results = await Promise.allSettled([
      service.placeOrder({ orderId, customerId, quantity: 8 }),
      service.placeOrder({ orderId, customerId, quantity: 8 }),
    ]);

    expect(results.every((result) => result.status === 'fulfilled')).toBe(true);
    const balance = await service.getBalance(customerId);
    expect(balance.available).toBe(8);
    expect(balance.orders).toHaveLength(1);
    expectConserved(balance);
  });
});
