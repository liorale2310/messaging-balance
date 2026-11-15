import { types } from 'pg';
import {
  bigintFromColumn,
  bigintToColumn,
  installBigintParser,
} from './bigint';

describe('bigint columns', () => {
  it('parses PostgreSQL int8 as the raw decimal string', () => {
    installBigintParser();
    const parse = types.getTypeParser(20) as (value: string) => string;
    expect(parse('9007199254740993')).toBe('9007199254740993');
  });

  it('compares sequences above the IEEE safe integer range as bigint', () => {
    const older = '9007199254740992';
    const newer = '9007199254740993';
    expect(Number(older)).toBe(Number(newer));

    const storedOlder = bigintToColumn(BigInt(older));
    const storedNewer = bigintToColumn(BigInt(newer));
    expect(storedOlder).toBe(older);
    expect(storedNewer).toBe(newer);
    expect(
      bigintFromColumn(storedNewer)! > bigintFromColumn(storedOlder)!,
    ).toBe(true);
  });

  it('maps null sequences to null', () => {
    expect(bigintToColumn(null)).toBeNull();
    expect(bigintToColumn(undefined)).toBeNull();
    expect(bigintFromColumn(null)).toBeNull();
    expect(bigintFromColumn(undefined)).toBeNull();
  });
});
