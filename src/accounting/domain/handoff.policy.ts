export type HandoffOutcomeName = 'ACCEPTED' | 'REJECTED';

export interface HandoffReport {
  eventId: string;
  messageId: string;
  outcome: HandoffOutcomeName;
  sequence: bigint;
}

export type HandoffDecision =
  | { kind: 'idempotent' }
  | { kind: 'conflict' }
  | { kind: 'store' }
  | { kind: 'apply' };

export function decideHandoff(input: {
  incoming: HandoffReport;
  storedByEventId: HandoffReport | null;
  sequenceTaken: boolean;
  appliedSequence: bigint | null;
}): HandoffDecision {
  const incoming = input.incoming;
  const stored = input.storedByEventId;
  if (stored) {
    if (
      stored.messageId === incoming.messageId &&
      stored.outcome === incoming.outcome &&
      stored.sequence === incoming.sequence
    ) {
      return { kind: 'idempotent' };
    }
    return { kind: 'conflict' };
  }
  if (input.sequenceTaken) {
    return { kind: 'conflict' };
  }
  if (
    input.appliedSequence !== null &&
    incoming.sequence < input.appliedSequence
  ) {
    return { kind: 'store' };
  }
  if (
    input.appliedSequence !== null &&
    incoming.sequence === input.appliedSequence
  ) {
    return { kind: 'conflict' };
  }
  return { kind: 'apply' };
}
