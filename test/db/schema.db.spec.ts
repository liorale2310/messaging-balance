import { randomUUID } from 'node:crypto';
import { QueryFailedError } from 'typeorm';
import { Message } from '../../src/accounting/entities/message.entity';
import { getDataSource } from './harness';

const ABOVE_SAFE_INTEGER = '9007199254740993';

type DriverError = {
  code?: string;
  constraint?: string;
};

async function expectDbError(
  run: () => Promise<unknown>,
  code: string,
  constraint?: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    expect(error).toBeInstanceOf(QueryFailedError);
    const driver = (error as QueryFailedError).driverError as DriverError;
    expect(driver.code).toBe(code);
    if (constraint) {
      expect(driver.constraint).toBe(constraint);
    }
    return;
  }
  throw new Error(`expected PostgreSQL error ${code}`);
}

describe('accounting schema', () => {
  it('stores a valid customer, order, campaign, reservation, message, and handoff', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    const orderId = randomUUID();
    const cancelledOrderId = randomUUID();
    const draftId = randomUUID();
    const scheduledId = randomUUID();
    const dispatchedId = randomUUID();
    const recipientId = randomUUID();
    const unbackedRecipientId = randomUUID();
    const messageId = randomUUID();
    const unbackedMessageId = randomUUID();
    const placedAt = new Date('2026-01-01T00:00:00.000Z');

    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
       VALUES ($1, $2, $3, 'ACTIVE', $4)`,
      [orderId, customerId, 1_000_000, placedAt],
    );
    await ds.query(
      `INSERT INTO orders (id, customer_id, quantity, status, placed_at, cancelled_at)
       VALUES ($1, $2, 1, 'CANCELLED', $3, $4)`,
      [
        cancelledOrderId,
        customerId,
        placedAt,
        new Date('2026-01-02T00:00:00.000Z'),
      ],
    );
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status) VALUES ($1, $2, 'DRAFT')`,
      [draftId, customerId],
    );
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status, scheduled_at, funding_note)
       VALUES ($1, $2, 'SCHEDULED', $3, $4)`,
      [scheduledId, customerId, placedAt, 'short by 1 after order cancel'],
    );
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
       VALUES ($1, $2, 'DISPATCHED', $3)`,
      [dispatchedId, customerId, placedAt],
    );
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
      [recipientId, dispatchedId, '+15551212'],
    );
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address, created_at)
       VALUES ($1, $2, $3, $4)`,
      [unbackedRecipientId, dispatchedId, '+15550000', placedAt],
    );
    await ds.query(
      `INSERT INTO reservations (campaign_id, order_id, quantity) VALUES ($1, $2, 2)`,
      [scheduledId, orderId],
    );
    await ds.query(
      `INSERT INTO messages (
         id, campaign_id, recipient_id, address, order_id, outcome, credit_state, outcome_sequence
       ) VALUES ($1, $2, $3, $4, $5, 'ACCEPTED', 'CONSUMED', $6::bigint)`,
      [
        messageId,
        dispatchedId,
        recipientId,
        '+15551212',
        orderId,
        ABOVE_SAFE_INTEGER,
      ],
    );
    await ds.query(
      `INSERT INTO messages (
         id, campaign_id, recipient_id, address, outcome, credit_state
       ) VALUES ($1, $2, $3, $4, 'PENDING', 'RESERVED')`,
      [unbackedMessageId, dispatchedId, unbackedRecipientId, '+15550000'],
    );
    await ds.query(
      `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
       VALUES ($1, $2, 'ACCEPTED', $3::bigint)`,
      ['evt-1', messageId, ABOVE_SAFE_INTEGER],
    );

    const message = await ds
      .getRepository(Message)
      .findOneByOrFail({ id: messageId });
    expect(message.outcomeSequence).toBe(BigInt(ABOVE_SAFE_INTEGER));
    expect(typeof message.outcomeSequence).toBe('bigint');

    const unbacked = await ds.getRepository(Message).findOneByOrFail({
      id: unbackedMessageId,
    });
    expect(unbacked.orderId).toBeNull();
    expect(unbacked.outcomeSequence).toBeNull();

    const bigintColumns: Array<{ table_name: string; column_name: string }> =
      await ds.query(
        `SELECT table_name, column_name
       FROM information_schema.columns
       WHERE table_schema = 'public'
         AND data_type = 'bigint'
         AND table_name <> 'migrations'
       ORDER BY table_name, column_name`,
      );
    expect(bigintColumns).toEqual([
      { table_name: 'handoff_events', column_name: 'sequence' },
      { table_name: 'messages', column_name: 'outcome_sequence' },
    ]);

    const checks: Array<{ conname: string }> = await ds.query(
      `SELECT conname
       FROM pg_constraint
       WHERE contype = 'c' AND conname LIKE 'CHK_%'
       ORDER BY conname`,
    );
    expect(checks.map((check) => check.conname)).toEqual([
      'CHK_campaigns_schedule_state',
      'CHK_campaigns_status',
      'CHK_handoff_events_event_id',
      'CHK_handoff_events_outcome',
      'CHK_handoff_events_sequence',
      'CHK_messages_address',
      'CHK_messages_outcome_pair',
      'CHK_orders_cancel_pair',
      'CHK_orders_quantity',
      'CHK_orders_status',
      'CHK_recipients_address',
      'CHK_reservations_quantity',
    ]);
  });

  it('rejects order quantities outside 1..1000000 and a broken cancel pair', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);

    for (const quantity of [0, 1_000_001]) {
      await expectDbError(
        () =>
          ds.query(
            `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
             VALUES ($1, $2, $3, 'ACTIVE', now())`,
            [randomUUID(), customerId, quantity],
          ),
        '23514',
        'CHK_orders_quantity',
      );
    }

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO orders (id, customer_id, quantity, status, placed_at, cancelled_at)
           VALUES ($1, $2, 1, 'ACTIVE', now(), now())`,
          [randomUUID(), customerId],
        ),
      '23514',
      'CHK_orders_cancel_pair',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
           VALUES ($1, $2, 1, 'CANCELLED', now())`,
          [randomUUID(), customerId],
        ),
      '23514',
      'CHK_orders_cancel_pair',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
           VALUES ($1, $2, 1, 'VOID', now())`,
          [randomUUID(), customerId],
        ),
      '23514',
    );
  });

  it('rejects campaign states that disagree with the schedule and the not-sent reason', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    const at = new Date('2026-02-01T00:00:00.000Z');

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
           VALUES ($1, $2, 'DRAFT', $3)`,
          [randomUUID(), customerId, at],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status) VALUES ($1, $2, 'SCHEDULED')`,
          [randomUUID(), customerId],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status, scheduled_at, not_sent_reason)
           VALUES ($1, $2, 'SCHEDULED', $3, 'short')`,
          [randomUUID(), customerId, at],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status) VALUES ($1, $2, 'DISPATCHED')`,
          [randomUUID(), customerId],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
           VALUES ($1, $2, 'NOT_SENT', $3)`,
          [randomUUID(), customerId, at],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status, not_sent_reason)
           VALUES ($1, $2, 'NOT_SENT', 'short')`,
          [randomUUID(), customerId],
        ),
      '23514',
      'CHK_campaigns_schedule_state',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO campaigns (id, customer_id, status) VALUES ($1, $2, 'COMPLETED')`,
          [randomUUID(), customerId],
        ),
      '23514',
    );
  });

  it('rejects a blank, duplicate, or oversized recipient address', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    const campaignId = randomUUID();
    const otherCampaignId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status) VALUES ($1, $2, 'DRAFT'), ($3, $2, 'DRAFT')`,
      [campaignId, customerId, otherCampaignId],
    );
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
      [randomUUID(), campaignId, '+15551212'],
    );

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
          [randomUUID(), campaignId, '+15551212'],
        ),
      '23505',
      'UQ_recipients_campaign_address',
    );
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
      [randomUUID(), otherCampaignId, '+15551212'],
    );

    for (const address of ['', '   ']) {
      await expectDbError(
        () =>
          ds.query(
            `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
            [randomUUID(), campaignId, address],
          ),
        '23514',
        'CHK_recipients_address',
      );
    }

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
          [randomUUID(), campaignId, 'x'.repeat(65)],
        ),
      '22001',
    );
  });

  it('rejects a non-positive reservation and a second row for the same campaign and order', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    const orderId = randomUUID();
    const campaignId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
       VALUES ($1, $2, 5, 'ACTIVE', now())`,
      [orderId, customerId],
    );
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
       VALUES ($1, $2, 'SCHEDULED', now())`,
      [campaignId, customerId],
    );
    await ds.query(
      `INSERT INTO reservations (campaign_id, order_id, quantity) VALUES ($1, $2, 1)`,
      [campaignId, orderId],
    );

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO reservations (campaign_id, order_id, quantity) VALUES ($1, $2, 0)`,
          [campaignId, randomUUID()],
        ),
      '23514',
      'CHK_reservations_quantity',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO reservations (campaign_id, order_id, quantity) VALUES ($1, $2, 2)`,
          [campaignId, orderId],
        ),
      '23505',
    );
  });

  it('rejects message outcomes that do not match the credit state and sequence', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    const campaignId = randomUUID();
    const orderId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
       VALUES ($1, $2, 5, 'ACTIVE', now())`,
      [orderId, customerId],
    );
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
       VALUES ($1, $2, 'DISPATCHED', now())`,
      [campaignId, customerId],
    );

    const insertMessage = (
      outcome: string,
      creditState: string,
      sequence: string | null,
    ) => {
      const recipientId = randomUUID();
      return ds
        .query(
          `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
          [recipientId, campaignId, recipientId],
        )
        .then(() =>
          ds.query(
            `INSERT INTO messages (
             id, campaign_id, recipient_id, address, order_id, outcome, credit_state, outcome_sequence
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::bigint)`,
            [
              randomUUID(),
              campaignId,
              recipientId,
              recipientId.slice(0, 64),
              orderId,
              outcome,
              creditState,
              sequence,
            ],
          ),
        );
    };

    await insertMessage('PENDING', 'RESERVED', null);
    await insertMessage('ACCEPTED', 'CONSUMED', '1');
    await insertMessage('REJECTED', 'RELEASED', '2');

    await expectDbError(
      () => insertMessage('PENDING', 'RESERVED', '1'),
      '23514',
      'CHK_messages_outcome_pair',
    );
    await expectDbError(
      () => insertMessage('ACCEPTED', 'CONSUMED', null),
      '23514',
      'CHK_messages_outcome_pair',
    );
    await expectDbError(
      () => insertMessage('ACCEPTED', 'RESERVED', '1'),
      '23514',
      'CHK_messages_outcome_pair',
    );
    await expectDbError(
      () => insertMessage('REJECTED', 'CONSUMED', '1'),
      '23514',
      'CHK_messages_outcome_pair',
    );
    await expectDbError(
      () => insertMessage('PENDING', 'RELEASED', null),
      '23514',
      'CHK_messages_outcome_pair',
    );

    const recipientId = randomUUID();
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, $3)`,
      [recipientId, campaignId, 'shared'],
    );
    await ds.query(
      `INSERT INTO messages (
         id, campaign_id, recipient_id, address, outcome, credit_state
       ) VALUES ($1, $2, $3, 'shared', 'PENDING', 'RESERVED')`,
      [randomUUID(), campaignId, recipientId],
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO messages (
             id, campaign_id, recipient_id, address, outcome, credit_state
           ) VALUES ($1, $2, $3, 'shared', 'PENDING', 'RESERVED')`,
          [randomUUID(), campaignId, recipientId],
        ),
      '23505',
    );
    const blankRecipientId = randomUUID();
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, 'kept')`,
      [blankRecipientId, campaignId],
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO messages (
             id, campaign_id, recipient_id, address, outcome, credit_state
           ) VALUES ($1, $2, $3, '   ', 'PENDING', 'RESERVED')`,
          [randomUUID(), campaignId, blankRecipientId],
        ),
      '23514',
      'CHK_messages_address',
    );
  });

  it('rejects handoff identities that are empty, non-positive, or repeated', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    const campaignId = randomUUID();
    const recipientId = randomUUID();
    const otherRecipientId = randomUUID();
    const messageId = randomUUID();
    const otherMessageId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO campaigns (id, customer_id, status, scheduled_at)
       VALUES ($1, $2, 'DISPATCHED', now())`,
      [campaignId, customerId],
    );
    await ds.query(
      `INSERT INTO recipients (id, campaign_id, address) VALUES ($1, $2, 'a'), ($3, $2, 'b')`,
      [recipientId, campaignId, otherRecipientId],
    );
    await ds.query(
      `INSERT INTO messages (
         id, campaign_id, recipient_id, address, outcome, credit_state, outcome_sequence
       ) VALUES
         ($1, $2, $3, 'a', 'ACCEPTED', 'CONSUMED', 4),
         ($4, $2, $5, 'b', 'REJECTED', 'RELEASED', 4)`,
      [messageId, campaignId, recipientId, otherMessageId, otherRecipientId],
    );
    await ds.query(
      `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
       VALUES ('evt-a', $1, 'ACCEPTED', 4)`,
      [messageId],
    );

    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
           VALUES ('evt-b', $1, 'REJECTED', 4)`,
          [messageId],
        ),
      '23505',
      'UQ_handoff_events_message_sequence',
    );
    await ds.query(
      `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
       VALUES ('evt-c', $1, 'REJECTED', 4)`,
      [otherMessageId],
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
           VALUES ('', $1, 'ACCEPTED', 5)`,
          [messageId],
        ),
      '23514',
      'CHK_handoff_events_event_id',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
           VALUES ('evt-d', $1, 'ACCEPTED', 0)`,
          [messageId],
        ),
      '23514',
      'CHK_handoff_events_sequence',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
           VALUES ('evt-e', $1, 'PENDING', 6)`,
          [messageId],
        ),
      '23514',
      'CHK_handoff_events_outcome',
    );
    await expectDbError(
      () =>
        ds.query(
          `INSERT INTO handoff_events (event_id, message_id, outcome, sequence)
           VALUES ('evt-a', $1, 'ACCEPTED', 7)`,
          [messageId],
        ),
      '23505',
    );
  });

  it('restricts deletes of a customer that still has an order', async () => {
    const ds = getDataSource();
    const customerId = randomUUID();
    await ds.query(`INSERT INTO customers (id) VALUES ($1)`, [customerId]);
    await ds.query(
      `INSERT INTO orders (id, customer_id, quantity, status, placed_at)
       VALUES ($1, $2, 1, 'ACTIVE', now())`,
      [randomUUID(), customerId],
    );

    await expectDbError(
      () => ds.query(`DELETE FROM customers WHERE id = $1`, [customerId]),
      '23503',
    );
  });
});
