import { parseDatabasePort } from './database.config';

describe('parseDatabasePort', () => {
  it('accepts a valid port', () => {
    expect(parseDatabasePort('5432')).toBe(5432);
  });

  it('accepts boundary values', () => {
    expect(parseDatabasePort('1')).toBe(1);
    expect(parseDatabasePort('65535')).toBe(65535);
  });

  it('rejects non-numeric suffixes', () => {
    expect(() => parseDatabasePort('5432abc')).toThrow(
      'Invalid DB_PORT: "5432abc". Expected an integer between 1 and 65535.',
    );
  });

  it('rejects decimals', () => {
    expect(() => parseDatabasePort('5432.5')).toThrow(
      'Invalid DB_PORT: "5432.5". Expected an integer between 1 and 65535.',
    );
    expect(() => parseDatabasePort('5432.0')).toThrow(
      'Invalid DB_PORT: "5432.0". Expected an integer between 1 and 65535.',
    );
  });

  it('rejects scientific notation', () => {
    expect(() => parseDatabasePort('5.432e3')).toThrow(
      'Invalid DB_PORT: "5.432e3". Expected an integer between 1 and 65535.',
    );
  });

  it('rejects ports outside 1–65535', () => {
    expect(() => parseDatabasePort('0')).toThrow(
      'Invalid DB_PORT: "0". Expected an integer between 1 and 65535.',
    );
    expect(() => parseDatabasePort('65536')).toThrow(
      'Invalid DB_PORT: "65536". Expected an integer between 1 and 65535.',
    );
  });
});
