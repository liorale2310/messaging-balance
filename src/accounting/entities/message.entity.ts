import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { bigintTransformer } from '../bigint';
import { Campaign } from './campaign.entity';
import { Order } from './order.entity';
import { Recipient } from './recipient.entity';

export enum MessageOutcome {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

export enum CreditState {
  RESERVED = 'RESERVED',
  CONSUMED = 'CONSUMED',
  RELEASED = 'RELEASED',
}

@Entity('messages')
@Index('IDX_messages_order_id', ['orderId'])
@Check('CHK_messages_address', `char_length(btrim("address")) > 0`)
@Check(
  'CHK_messages_outcome_pair',
  `(
    "outcome" = 'PENDING'
    AND "credit_state" = 'RESERVED'
    AND "outcome_sequence" IS NULL
  ) OR (
    "outcome" = 'ACCEPTED'
    AND "credit_state" = 'CONSUMED'
    AND "outcome_sequence" IS NOT NULL
  ) OR (
    "outcome" = 'REJECTED'
    AND "credit_state" = 'RELEASED'
    AND "outcome_sequence" IS NOT NULL
  )`,
)
export class Message {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @ManyToOne(() => Campaign, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @Column({ name: 'recipient_id', type: 'uuid' })
  recipientId: string;

  @OneToOne(() => Recipient, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'recipient_id' })
  recipient: Recipient;

  @Column({ type: 'varchar', length: 64 })
  address: string;

  @Column({ name: 'order_id', type: 'uuid', nullable: true })
  orderId: string | null;

  @ManyToOne(() => Order, { nullable: true, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order: Order | null;

  @Column({ type: 'varchar', length: 32 })
  outcome: MessageOutcome;

  @Column({ name: 'credit_state', type: 'varchar', length: 32 })
  creditState: CreditState;

  @Column({
    name: 'outcome_sequence',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  outcomeSequence: bigint | null;
}
