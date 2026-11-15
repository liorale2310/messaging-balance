import { resolve } from 'node:path';

export function loadTestEnv(): void {
  try {
    process.loadEnvFile(resolve(process.cwd(), '.env'));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw error;
    }
  }

  const name = process.env.DB_NAME ?? '';
  if (!name.endsWith('_test')) {
    throw new Error(
      `Refusing to run database tests against DB_NAME="${name}". The database name must end with _test.`,
    );
  }
}
