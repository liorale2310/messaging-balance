import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Customer } from './customer.entity';

export enum CampaignStatus {
  DRAFT = 'DRAFT',
  SCHEDULED = 'SCHEDULED',
  DISPATCHED = 'DISPATCHED',
  NOT_SENT = 'NOT_SENT',
}

@Entity('campaigns')
@Index('IDX_campaigns_status_scheduled_at', ['status', 'scheduledAt'])
@Index('IDX_campaigns_customer_id', ['customerId'])
@Check(
  'CHK_campaigns_status',
  `"status" IN ('DRAFT', 'SCHEDULED', 'DISPATCHED', 'NOT_SENT')`,
)
@Check(
  'CHK_campaigns_schedule_state',
  `(
    "status" = 'DRAFT'
    AND "scheduled_at" IS NULL
    AND "not_sent_reason" IS NULL
  ) OR (
    "status" = 'SCHEDULED'
    AND "scheduled_at" IS NOT NULL
    AND "not_sent_reason" IS NULL
  ) OR (
    "status" = 'DISPATCHED'
    AND "scheduled_at" IS NOT NULL
    AND "not_sent_reason" IS NULL
  ) OR (
    "status" = 'NOT_SENT'
    AND "scheduled_at" IS NOT NULL
    AND "not_sent_reason" IS NOT NULL
  )`,
)
export class Campaign {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ type: 'varchar', length: 32 })
  status: CampaignStatus;

  @Column({ name: 'scheduled_at', type: 'timestamptz', nullable: true })
  scheduledAt: Date | null;

  @Column({ name: 'funding_note', type: 'text', nullable: true })
  fundingNote: string | null;

  @Column({ name: 'not_sent_reason', type: 'text', nullable: true })
  notSentReason: string | null;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;
}
