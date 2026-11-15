import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/database/database.config';
import { loadTestEnv } from './env';

loadTestEnv();

let dataSource: DataSource;

beforeAll(async () => {
  dataSource = new DataSource({
    ...createDatabaseOptions(),
    logging: false,
  });
  await dataSource.initialize();
});

afterAll(async () => {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
});

beforeEach(async () => {
  await dataSource.query(`
    TRUNCATE TABLE
      handoff_events,
      messages,
      reservations,
      recipients,
      campaigns,
      orders,
      customers
    RESTART IDENTITY CASCADE
  `);
});

export function getDataSource(): DataSource {
  return dataSource;
}
