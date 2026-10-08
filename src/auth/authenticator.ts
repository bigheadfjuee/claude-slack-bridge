/**
 * Challenge-code authentication.
 *
 * A Slack user is authorised either by being on the static allowlist or by
 * completing a one-time handshake: the bridge issues a short-lived nonce, the
 * human sends it back, and the user id is remembered in the persistent store.
 *
 * The handshake is deliberately stateful — a wrong guess never consumes the
 * pending challenge, so a typo costs nothing, and comparisons are done in
 * constant time so a wrong code cannot be recovered by timing.
 */

import { randomInt, timingSafeEqual } from "node:crypto";

/** Persistent record of which Slack user ids may talk to the bridge. */
export interface AuthStore {
  isAuthorized(userId: string): boolean;
  authorize(userId: string): void;
  revoke(userId: string): void;
  list(): string[];
}

/** In-process store — used by tests and by `--no-persist` runs. */
export class MemoryAuthStore implements AuthStore {
  private readonly users = new Set<string>();

  isAuthorized(userId: string): boolean {
    return this.users.has(userId);
  }

  authorize(userId: string): void {
    this.users.add(userId);
  }

  revoke(userId: string): void {
    this.users.delete(userId);
  }

  list(): string[] {
    return [...this.users].sort();
  }
}

export interface AuthenticatorOptions {
  /** User ids that are always authorised, without a handshake. */
  allowlist?: string[];
  /** Optional pre-shared code that any user may present. */
  challengeCode?: string;
  store?: AuthStore;
  /** Injectable clock, for tests. */
  now?: () => number;
  /** How long an issued challenge stays valid. Default 10 minutes. */
  challengeTtlMs?: number;
}

export const DEFAULT_CHALLENGE_TTL_MS = 10 * 60 * 1000;

const NONCE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const NONCE_LENGTH = 6;

interface Challenge {
  code: string;
  expiresAt: number;
}

function generateNonce(): string {
  let out = "";
  for (let i = 0; i < NONCE_LENGTH; i += 1) {
    // randomInt is rejection-sampled, so the alphabet stays uniform.
    out += NONCE_ALPHABET[randomInt(NONCE_ALPHABET.length)];
  }
  return out;
}

/** Length-safe constant-time comparison. */
function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) {
    // Still burn a comparison so the failure path costs the same.
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

export class Authenticator {
  private readonly allowlist: Set<string>;
  private readonly challengeCode: string | undefined;
  private readonly store: AuthStore;
  private readonly now: () => number;
  private readonly challengeTtlMs: number;
  private readonly challenges = new Map<string, Challenge>();

  constructor(options: AuthenticatorOptions = {}) {
    this.allowlist = new Set(options.allowlist ?? []);
    this.challengeCode = options.challengeCode;
    this.store = options.store ?? new MemoryAuthStore();
    this.now = options.now ?? Date.now;
    this.challengeTtlMs = options.challengeTtlMs ?? DEFAULT_CHALLENGE_TTL_MS;
  }

  /** True when the user may use the bridge right now. */
  isAuthorized(userId: string): boolean {
    return this.allowlist.has(userId) || this.store.isAuthorized(userId);
  }

  /**
   * Issue a fresh single-use code for a user and return it.
   *
   * The caller is responsible for delivering it out-of-band (a Slack DM, a
   * terminal banner) — it is the human's proof they control the account.
   */
  issueChallenge(userId: string): string {
    const code = generateNonce();
    this.challenges.set(userId, { code, expiresAt: this.now() + this.challengeTtlMs });
    return code;
  }

  /**
   * Check a code the user sent back.
   *
   * A correct answer authorises the user and burns the challenge. A wrong
   * answer leaves the challenge intact so the human can retry.
   */
  verify(userId: string, candidate: string): boolean {
    const challenge = this.challenges.get(userId);
    const staticMatch =
      this.challengeCode !== undefined && safeEqual(candidate, this.challengeCode);

    if (challenge === undefined) {
      return staticMatch ? this.grant(userId) : false;
    }
    if (challenge.expiresAt <= this.now()) {
      this.challenges.delete(userId);
      return staticMatch ? this.grant(userId) : false;
    }
    if (safeEqual(candidate, challenge.code) || staticMatch) {
      this.challenges.delete(userId);
      return this.grant(userId);
    }
    return false;
  }

  private grant(userId: string): boolean {
    this.store.authorize(userId);
    return true;
  }

  /** Remove a user's authorisation (and any pending challenge). */
  revoke(userId: string): void {
    this.challenges.delete(userId);
    this.store.revoke(userId);
  }

  /** Everyone currently allowed in, allowlist included. */
  listAuthorized(): string[] {
    return [...new Set([...this.allowlist, ...this.store.list()])].sort();
  }

  /** True when the user has a pending, unexpired challenge. */
  hasPendingChallenge(userId: string): boolean {
    const challenge = this.challenges.get(userId);
    return challenge !== undefined && challenge.expiresAt > this.now();
  }
}
