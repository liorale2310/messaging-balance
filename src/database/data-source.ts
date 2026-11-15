import { resolve } from 'node:path';
import { DataSource } from 'typeorm';
import { createDatabaseOptions } from './database.config';

process.loadEnvFile(resolve(process.cwd(), '.env'));

export default new DataSource(createDatabaseOptions());
