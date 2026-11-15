import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { bigintTransformer } from '../bigint';
import { Message } from './message.entity';

export enum HandoffOutcome {
  ACCEPTED = 'ACCEPTED',
  REJECTED = 'REJECTED',
}

@Entity('handoff_events')
@Unique('UQ_handoff_events_message_sequence', ['messageId', 'sequence'])
@Check('CHK_handoff_events_outcome', `"outcome" IN ('ACCEPTED', 'REJECTED')`)
@Check('CHK_handoff_events_sequence', '"sequence" > 0')
@Check('CHK_handoff_events_event_id', `char_length("event_id") > 0`)
export class HandoffEvent {
  @PrimaryColumn({ name: 'event_id', type: 'text' })
  eventId: string;

  @Column({ name: 'message_id', type: 'uuid' })
  messageId: string;

  @ManyToOne(() => Message, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'message_id' })
  message: Message;

  @Column({ type: 'varchar', length: 32 })
  outcome: HandoffOutcome;

  @Column({
    type: 'bigint',
    transformer: bigintTransformer,
  })
  sequence: bigint;

  @Column({
    name: 'received_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  receivedAt: Date;
}
