import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { Campaign } from './campaign.entity';

@Entity('recipients')
@Unique('UQ_recipients_campaign_address', ['campaignId', 'address'])
@Index('IDX_recipients_campaign_created_id', ['campaignId', 'createdAt', 'id'])
@Check('CHK_recipients_address', `char_length(btrim("address")) > 0`)
export class Recipient {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @ManyToOne(() => Campaign, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @Column({ type: 'varchar', length: 64 })
  address: string;

  @Column({
    name: 'created_at',
    type: 'timestamptz',
    default: () => 'now()',
  })
  createdAt: Date;
}
