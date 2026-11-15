import { join } from 'node:path';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { DataSourceOptions } from 'typeorm';

function requiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export function parseDatabasePort(value: string): number {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(
      `Invalid DB_PORT: "${value}". Expected an integer between 1 and 65535.`,
    );
  }

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      `Invalid DB_PORT: "${value}". Expected an integer between 1 and 65535.`,
    );
  }

  return port;
}

export function createDatabaseOptions(): DataSourceOptions {
  return {
    type: 'postgres',
    host: requiredEnv('DB_HOST'),
    port: parseDatabasePort(requiredEnv('DB_PORT')),
    username: requiredEnv('DB_USERNAME'),
    password: requiredEnv('DB_PASSWORD'),
    database: requiredEnv('DB_NAME'),
    entities: [join(__dirname, '..', '**', '*.entity.{ts,js}')],
    migrations: [join(__dirname, '..', 'migrations', '*.{ts,js}')],
    synchronize: false,
    migrationsRun: false,
    logging: ['error'],
  };
}

export function typeOrmConfig(): TypeOrmModuleOptions {
  return {
    ...createDatabaseOptions(),
    autoLoadEntities: true,
  };
}
