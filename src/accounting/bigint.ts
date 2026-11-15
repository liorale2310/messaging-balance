import { types } from 'pg';
import { ValueTransformer } from 'typeorm';

/**
 * OID 20 is PostgreSQL int8. The raw decimal string is preserved so values
 * above 2^53-1 are not collapsed by IEEE-754 before BigInt conversion.
 */
export function installBigintParser(): void {
  types.setTypeParser(20, (value: string) => value);
}

installBigintParser();

export const bigintToColumn = (
  value: bigint | null | undefined,
): string | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return value.toString();
};

export const bigintFromColumn = (
  value: string | null | undefined,
): bigint | null => {
  if (value === null || value === undefined) {
    return null;
  }
  return BigInt(value);
};

export const bigintTransformer: ValueTransformer = {
  to: bigintToColumn,
  from: bigintFromColumn,
};
