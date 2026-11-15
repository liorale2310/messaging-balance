import { MigrationInterface, QueryRunner } from 'typeorm';

export class AccountingSchema1794771387360 implements MigrationInterface {
  name = 'AccountingSchema1794771387360';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "customers" ("id" uuid NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_133ec679a801fab5e070f73d3ea" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(`CREATE TABLE "campaigns" ("id" uuid NOT NULL, "customer_id" uuid NOT NULL, "status" character varying(32) NOT NULL, "scheduled_at" TIMESTAMP WITH TIME ZONE, "funding_note" text, "not_sent_reason" text, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "CHK_campaigns_schedule_state" CHECK ((
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
  )), CONSTRAINT "CHK_campaigns_status" CHECK ("status" IN ('DRAFT', 'SCHEDULED', 'DISPATCHED', 'NOT_SENT')), CONSTRAINT "PK_831e3fcd4fc45b4e4c3f57a9ee4" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `CREATE INDEX "IDX_campaigns_customer_id" ON "campaigns"  ("customer_id") `,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_campaigns_status_scheduled_at" ON "campaigns"  ("status", "scheduled_at") `,
    );
    await queryRunner.query(
      `CREATE TABLE "orders" ("id" uuid NOT NULL, "customer_id" uuid NOT NULL, "quantity" integer NOT NULL, "status" character varying(32) NOT NULL, "placed_at" TIMESTAMP WITH TIME ZONE NOT NULL, "cancelled_at" TIMESTAMP WITH TIME ZONE, CONSTRAINT "CHK_orders_cancel_pair" CHECK (("status" = 'ACTIVE' AND "cancelled_at" IS NULL) OR ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL)), CONSTRAINT "CHK_orders_status" CHECK ("status" IN ('ACTIVE', 'CANCELLED')), CONSTRAINT "CHK_orders_quantity" CHECK ("quantity" BETWEEN 1 AND 1000000), CONSTRAINT "PK_710e2d4957aa5878dfe94e4ac2f" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_orders_customer_status_placed" ON "orders"  ("customer_id", "status", "placed_at", "id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "recipients" ("id" uuid NOT NULL, "campaign_id" uuid NOT NULL, "address" character varying(64) NOT NULL, "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_recipients_campaign_address" UNIQUE ("campaign_id", "address"), CONSTRAINT "CHK_recipients_address" CHECK (char_length(btrim("address")) > 0), CONSTRAINT "PK_de8fc5a9c364568f294798fe1e9" PRIMARY KEY ("id"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_recipients_campaign_created_id" ON "recipients"  ("campaign_id", "created_at", "id") `,
    );
    await queryRunner.query(`CREATE TABLE "messages" ("id" uuid NOT NULL, "campaign_id" uuid NOT NULL, "recipient_id" uuid NOT NULL, "address" character varying(64) NOT NULL, "order_id" uuid, "outcome" character varying(32) NOT NULL, "credit_state" character varying(32) NOT NULL, "outcome_sequence" bigint, CONSTRAINT "REL_566c3d68184e83d4307b86f85a" UNIQUE ("recipient_id"), CONSTRAINT "CHK_messages_outcome_pair" CHECK ((
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
  )), CONSTRAINT "CHK_messages_address" CHECK (char_length(btrim("address")) > 0), CONSTRAINT "PK_18325f38ae6de43878487eff986" PRIMARY KEY ("id"))`);
    await queryRunner.query(
      `CREATE INDEX "IDX_messages_order_id" ON "messages"  ("order_id") `,
    );
    await queryRunner.query(
      `CREATE TABLE "handoff_events" ("event_id" text NOT NULL, "message_id" uuid NOT NULL, "outcome" character varying(32) NOT NULL, "sequence" bigint NOT NULL, "received_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_handoff_events_message_sequence" UNIQUE ("message_id", "sequence"), CONSTRAINT "CHK_handoff_events_event_id" CHECK (char_length("event_id") > 0), CONSTRAINT "CHK_handoff_events_sequence" CHECK ("sequence" > 0), CONSTRAINT "CHK_handoff_events_outcome" CHECK ("outcome" IN ('ACCEPTED', 'REJECTED')), CONSTRAINT "PK_7739bec18317d9cda7792fa96a7" PRIMARY KEY ("event_id"))`,
    );
    await queryRunner.query(
      `CREATE TABLE "reservations" ("campaign_id" uuid NOT NULL, "order_id" uuid NOT NULL, "quantity" integer NOT NULL, CONSTRAINT "CHK_reservations_quantity" CHECK ("quantity" > 0), CONSTRAINT "PK_5cbadca23eb28cdd92da8c8d7e5" PRIMARY KEY ("campaign_id", "order_id"))`,
    );
    await queryRunner.query(
      `ALTER TABLE "campaigns" ADD CONSTRAINT "FK_333be941653b6ab68ce1b931685" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" ADD CONSTRAINT "FK_772d0ce0473ac2ccfa26060dbe9" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "recipients" ADD CONSTRAINT "FK_0776cae7bc374f5b2369f7ac50c" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_7ee9933e7f3d3f6c5a4cfeb154b" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_566c3d68184e83d4307b86f85ab" FOREIGN KEY ("recipient_id") REFERENCES "recipients"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" ADD CONSTRAINT "FK_bb3c15e546faf62faaa4f1d06d3" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "handoff_events" ADD CONSTRAINT "FK_5e76733d6cf5a37b9c80f1bd542" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "reservations" ADD CONSTRAINT "FK_c82ddc42c6140db7fe9f206e89c" FOREIGN KEY ("campaign_id") REFERENCES "campaigns"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "reservations" ADD CONSTRAINT "FK_82ff9434d944488ca3bf1946c42" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reservations" DROP CONSTRAINT "FK_82ff9434d944488ca3bf1946c42"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reservations" DROP CONSTRAINT "FK_c82ddc42c6140db7fe9f206e89c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "handoff_events" DROP CONSTRAINT "FK_5e76733d6cf5a37b9c80f1bd542"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_bb3c15e546faf62faaa4f1d06d3"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_566c3d68184e83d4307b86f85ab"`,
    );
    await queryRunner.query(
      `ALTER TABLE "messages" DROP CONSTRAINT "FK_7ee9933e7f3d3f6c5a4cfeb154b"`,
    );
    await queryRunner.query(
      `ALTER TABLE "recipients" DROP CONSTRAINT "FK_0776cae7bc374f5b2369f7ac50c"`,
    );
    await queryRunner.query(
      `ALTER TABLE "orders" DROP CONSTRAINT "FK_772d0ce0473ac2ccfa26060dbe9"`,
    );
    await queryRunner.query(
      `ALTER TABLE "campaigns" DROP CONSTRAINT "FK_333be941653b6ab68ce1b931685"`,
    );
    await queryRunner.query(`DROP TABLE "reservations"`);
    await queryRunner.query(`DROP TABLE "handoff_events"`);
    await queryRunner.query(`DROP INDEX "public"."IDX_messages_order_id"`);
    await queryRunner.query(`DROP TABLE "messages"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_recipients_campaign_created_id"`,
    );
    await queryRunner.query(`DROP TABLE "recipients"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_orders_customer_status_placed"`,
    );
    await queryRunner.query(`DROP TABLE "orders"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_campaigns_status_scheduled_at"`,
    );
    await queryRunner.query(`DROP INDEX "public"."IDX_campaigns_customer_id"`);
    await queryRunner.query(`DROP TABLE "campaigns"`);
    await queryRunner.query(`DROP TABLE "customers"`);
  }
}
