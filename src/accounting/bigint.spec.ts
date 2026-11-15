import { types } from 'pg';
import { bigintTransformer, installBigintParser } from './bigint';

describe('bigint columns', () => {
  it('parses PostgreSQL int8 as the raw decimal string', () => {
    installBigintParser();
    expect(types.getTypeParser(20)('9007199254740993')).toBe(
      '9007199254740993',
    );
  });

  it('compares sequences above the IEEE safe integer range as bigint', () => {
    const older = '9007199254740992';
    const newer = '9007199254740993';
    expect(Number(older)).toBe(Number(newer));

    const storedOlder = bigintTransformer.to(BigInt(older));
    const storedNewer = bigintTransformer.to(BigInt(newer));
    expect(storedOlder).toBe(older);
    expect(storedNewer).toBe(newer);
    expect(bigintTransformer.from(storedNewer)! > bigintTransformer.from(storedOlder)!).toBe(
      true,
    );
  });

  it('maps null sequences to null', () => {
    expect(bigintTransformer.to(null)).toBeNull();
    expect(bigintTransformer.to(undefined)).toBeNull();
    expect(bigintTransformer.from(null)).toBeNull();
    expect(bigintTransformer.from(undefined)).toBeNull();
  });
});
