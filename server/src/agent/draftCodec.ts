import type { DraftState, ParticipantState } from './resolve.js';
import type { ExpenseType, ShareMode } from '../domain/types.js';
import { isInteger } from '../domain/money.js';
import { isValidDateString } from '../lib/dates.js';

/**
 * The client echoes the pending draft back when the user refines it
 * ("小李不算，改成我和小王平摊"). It is untrusted input like anything else, so the
 * decode is explicit and only accepts well-formed values.
 */
export function decodeDraftState(raw: unknown): DraftState | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;

  const type: ExpenseType = record.type === 'income' ? 'income' : 'expense';
  const amountCents =
    record.amountCents === null || record.amountCents === undefined
      ? null
      : isInteger(record.amountCents)
        ? record.amountCents
        : null;

  const participants = Array.isArray(record.participants)
    ? record.participants
        .map((entry): ParticipantState | null => {
          if (typeof entry !== 'object' || entry === null) return null;
          const item = entry as Record<string, unknown>;
          if (typeof item.userId !== 'string' || item.userId.trim() === '') return null;
          const participant: ParticipantState = { userId: item.userId };
          if (typeof item.weight === 'number' && Number.isFinite(item.weight)) {
            participant.weight = item.weight;
          }
          if (isInteger(item.amountCents)) participant.amountCents = item.amountCents;
          return participant;
        })
        .filter((entry): entry is ParticipantState => entry !== null)
    : [];

  const shareMode: ShareMode =
    record.shareMode === 'equal' || record.shareMode === 'weights' || record.shareMode === 'amounts'
      ? record.shareMode
      : 'equal';

  return {
    type,
    amountCents,
    currency: typeof record.currency === 'string' ? record.currency : 'CNY',
    categoryKey: typeof record.categoryKey === 'string' ? record.categoryKey : null,
    date: isValidDateString(record.date) ? record.date : null,
    note: typeof record.note === 'string' ? record.note : '',
    paidBy: typeof record.paidBy === 'string' ? record.paidBy : null,
    shareMode,
    participants,
    source: 'text',
    rawUtterance: typeof record.rawUtterance === 'string' ? record.rawUtterance : null,
  };
}
