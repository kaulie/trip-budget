import { randomUUID } from 'node:crypto';

export function newId(): string {
  return randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}

/** Unambiguous alphabet: no I/O/0/1 so codes can be read aloud or typed back. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomCode(length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * Human-shareable invite code, e.g. `TRIP-8F3K2`.
 * The prefix is derived from the ledger name so it reads naturally in a chat
 * message, with a generic fallback.
 */
export function generateInviteCode(ledgerName: string): string {
  const prefix = derivePrefix(ledgerName);
  return `${prefix}-${randomCode(5)}`;
}

function derivePrefix(name: string): string {
  const latin = /[A-Za-z]{2,}/.exec(name);
  if (latin) return latin[0]!.toUpperCase().slice(0, 6);
  return randomCode(4);
}

export function normalizeInviteCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[\s_]+/g, '')
    .replace(/^([A-Z0-9]{2,6})--+/, '$1-');
}
