import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Campaign } from './entities/campaign.entity';
import { Customer } from './entities/customer.entity';
import { HandoffEvent } from './entities/handoff-event.entity';
import { Message } from './entities/message.entity';
import { Order } from './entities/order.entity';
import { Recipient } from './entities/recipient.entity';
import { Reservation } from './entities/reservation.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Customer,
      Order,
      Campaign,
      Recipient,
      Reservation,
      Message,
      HandoffEvent,
    ]),
  ],
})
export class AccountingModule {}
