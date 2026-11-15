import { decideHandoff, HandoffReport } from './handoff.policy';

const applied: HandoffReport = {
  eventId: 'event-1',
  messageId: 'message-1',
  outcome: 'ACCEPTED',
  sequence: 5n,
};

describe('decideHandoff', () => {
  it('replays an identical event without applying it again', () => {
    expect(
      decideHandoff({
        incoming: applied,
        storedByEventId: applied,
        sequenceTaken: true,
        appliedSequence: 5n,
      }).kind,
    ).toBe('idempotent');
  });

  it('conflicts when the same event id carries a different payload', () => {
    expect(
      decideHandoff({
        incoming: { ...applied, outcome: 'REJECTED' },
        storedByEventId: applied,
        sequenceTaken: true,
        appliedSequence: 5n,
      }).kind,
    ).toBe('conflict');
  });

  it('conflicts when a new event reuses a stored message sequence', () => {
    expect(
      decideHandoff({
        incoming: { ...applied, eventId: 'event-2' },
        storedByEventId: null,
        sequenceTaken: true,
        appliedSequence: 5n,
      }).kind,
    ).toBe('conflict');
  });

  it('stores a strictly older sequence without applying it', () => {
    expect(
      decideHandoff({
        incoming: { ...applied, eventId: 'event-0', sequence: 4n },
        storedByEventId: null,
        sequenceTaken: false,
        appliedSequence: 5n,
      }).kind,
    ).toBe('store');
  });

  it('applies a later rejection and a later acceptance', () => {
    expect(
      decideHandoff({
        incoming: {
          eventId: 'event-6',
          messageId: applied.messageId,
          outcome: 'REJECTED',
          sequence: 6n,
        },
        storedByEventId: null,
        sequenceTaken: false,
        appliedSequence: 5n,
      }).kind,
    ).toBe('apply');
    expect(
      decideHandoff({
        incoming: {
          eventId: 'event-7',
          messageId: applied.messageId,
          outcome: 'ACCEPTED',
          sequence: 7n,
        },
        storedByEventId: null,
        sequenceTaken: false,
        appliedSequence: 6n,
      }).kind,
    ).toBe('apply');
  });

  it('compares sequences beyond the JavaScript safe integer range as bigint', () => {
    const low = 9007199254740992n;
    const high = 9007199254740993n;
    expect(Number(low)).toBe(Number(high));
    expect(
      decideHandoff({
        incoming: {
          eventId: 'high',
          messageId: 'message-1',
          outcome: 'REJECTED',
          sequence: high,
        },
        storedByEventId: null,
        sequenceTaken: false,
        appliedSequence: low,
      }).kind,
    ).toBe('apply');
  });
});
