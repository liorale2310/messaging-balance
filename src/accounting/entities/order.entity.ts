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

export enum OrderStatus {
  ACTIVE = 'ACTIVE',
  CANCELLED = 'CANCELLED',
}

@Entity('orders')
@Index('IDX_orders_customer_status_placed', [
  'customerId',
  'status',
  'placedAt',
  'id',
])
@Check('CHK_orders_quantity', '"quantity" BETWEEN 1 AND 1000000')
@Check('CHK_orders_status', `"status" IN ('ACTIVE', 'CANCELLED')`)
@Check(
  'CHK_orders_cancel_pair',
  `("status" = 'ACTIVE' AND "cancelled_at" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)`,
)
export class Order {
  @PrimaryColumn({ type: 'uuid' })
  id: string;

  @Column({ name: 'customer_id', type: 'uuid' })
  customerId: string;

  @ManyToOne(() => Customer, { onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'customer_id' })
  customer: Customer;

  @Column({ type: 'integer' })
  quantity: number;

  @Column({ type: 'varchar', length: 32 })
  status: OrderStatus;

  @Column({ name: 'placed_at', type: 'timestamptz' })
  placedAt: Date;

  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;
}
