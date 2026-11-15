import {
  Check,
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Campaign } from './campaign.entity';
import { Order } from './order.entity';

@Entity('reservations')
@Check('CHK_reservations_quantity', '"quantity" > 0')
export class Reservation {
  @PrimaryColumn({ name: 'campaign_id', type: 'uuid' })
  campaignId: string;

  @PrimaryColumn({ name: 'order_id', type: 'uuid' })
  orderId: string;

  @ManyToOne(() => Campaign, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'campaign_id' })
  campaign: Campaign;

  @ManyToOne(() => Order, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'order_id' })
  order: Order;

  @Column({ type: 'integer' })
  quantity: number;
}
