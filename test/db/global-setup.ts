import { DataSource } from 'typeorm';
import { createDatabaseOptions } from '../../src/database/database.config';
import { loadTestEnv } from './env';

export default async function globalSetup(): Promise<void> {
  loadTestEnv();
  const dataSource = new DataSource(createDatabaseOptions());
  await dataSource.initialize();
  try {
    await dataSource.runMigrations();
  } finally {
    await dataSource.destroy();
  }
}
