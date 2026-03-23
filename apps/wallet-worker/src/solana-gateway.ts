/**
 * The real Solana implementation of `WithdrawalGateway`.
 *
 * `withdrawals.ts` holds the reasoning — record the signature before broadcasting, never
 * rebuild until the blockhash has provably expired. This file holds only the mechanics of
 * talking to a validator, and is kept deliberately thin so that reading it is close to a
 * substitute for testing it. Everything with a decision in it lives next door.
 *
 * ## The signature is known before the transaction is sent
 *
 * That is the property the whole withdrawal protocol depends on, and it is not obvious. A
 * Solana transaction's signature *is* the ed25519 signature over its message — so once the
 * treasury key has signed, the identifier exists locally, before a single byte reaches the
 * network. That is what makes "write the signature down, then send" possible at all. On a
 * chain where the network assigned the id, this protocol could not be built.
 *
 * ## The destination token account may not exist yet
 *
 * USDC does not land on a wallet address; it lands in that wallet's Associated Token
 * Account. If the recipient has never held this mint, the account does not exist and a plain
 * transfer fails. The instruction to create it is idempotent-by-construction — including it
 * when the account already exists would fail, so it is added only when the account is
 * genuinely missing, and the treasury pays the rent because the recipient may hold no SOL.
 *
 * ## Everything is `finalized`
 *
 * Never `confirmed`. A confirmed transaction can still be rolled back by a fork, and a
 * withdrawal that un-happens after we marked it complete is money we have to find again.
 */

import {
  type Connection,
  type Keypair,
  PublicKey,
  Transaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from '@solana/spl-token';
import { DEVNET_USDC_MINT, USDC_DECIMALS, tokenAccountFor } from '@clawroll/solana';
import type { SignatureOutcome, SignedTransfer, WithdrawalGateway } from './withdrawals.js';

export class SolanaGatewayError extends Error {}

export class SolanaWithdrawalGateway implements WithdrawalGateway {
  private readonly treasuryTokenAccount: PublicKey;

  constructor(
    private readonly connection: Connection,
    /** Holds the pooled USDC and pays every fee. */
    private readonly treasury: Keypair,
    private readonly mint: PublicKey = DEVNET_USDC_MINT,
  ) {
    this.treasuryTokenAccount = tokenAccountFor(treasury.publicKey, mint);
  }

  /**
   * Build and sign a transfer, returning its signature *before* anything is broadcast.
   *
   * The caller persists that signature and only then calls `send`. If the process dies in
   * between, the signature is the one durable handle on a transaction that may or may not
   * be in flight.
   */
  async buildAndSign(destination: string, amountMicros: number): Promise<SignedTransfer> {
    if (!Number.isSafeInteger(amountMicros) || amountMicros <= 0) {
      throw new SolanaGatewayError(`amount must be a positive integer, got ${amountMicros}`);
    }

    let owner: PublicKey;
    try {
      owner = new PublicKey(destination);
    } catch {
      throw new SolanaGatewayError(`destination is not a valid address: ${destination}`);
    }

    const destinationTokenAccount = tokenAccountFor(owner, this.mint);
    const transaction = new Transaction();

    if (!(await this.tokenAccountExists(destinationTokenAccount))) {
      // Adding this when the account already exists would make the whole transaction fail,
      // so it is conditional. The treasury pays: a recipient who has never held USDC also
      // has no SOL for rent.
      transaction.add(
        createAssociatedTokenAccountInstruction(
          this.treasury.publicKey,
          destinationTokenAccount,
          owner,
          this.mint,
        ),
      );
    }

    transaction.add(
      // `transferChecked` rather than `transfer`: it carries the mint and decimals and the
      // program verifies them. A plain transfer would happily move the wrong token if the
      // source account were ever mis-derived.
      createTransferCheckedInstruction(
        this.treasuryTokenAccount,
        this.mint,
        destinationTokenAccount,
        this.treasury.publicKey,
        amountMicros,
        USDC_DECIMALS,
      ),
    );

    const { blockhash, lastValidBlockHeight } =
      await this.connection.getLatestBlockhash('finalized');

    transaction.recentBlockhash = blockhash;
    transaction.feePayer = this.treasury.publicKey;
    transaction.sign(this.treasury);

    const signature = transaction.signature;
    if (!signature) throw new SolanaGatewayError('transaction was not signed');

    return {
      // Base58 of the ed25519 signature — the id the cluster will know this by, computed
      // here, offline, before the transaction is broadcast.
      signature: bs58(signature),
      blockhash,
      lastValidBlockHeight,
      rawTransaction: transaction.serialize(),
    };
  }

  /**
   * Broadcast.
   *
   * `skipPreflight` is on deliberately. Preflight simulates against the *current* bank and
   * can reject a transaction that would land fine, and its failures are indistinguishable
   * to the caller from a network error — which would push the worker toward rebuilding when
   * it must not. The outcome is decided by asking about the signature, never by what this
   * call returns.
   *
   * `maxRetries: 0` for the same reason: retrying is the worker's decision, made against
   * blockhash expiry, not the RPC client's.
   */
  async send(rawTransaction: Uint8Array): Promise<void> {
    await this.connection.sendRawTransaction(Buffer.from(rawTransaction), {
      skipPreflight: true,
      maxRetries: 0,
      preflightCommitment: 'finalized',
    });
  }

  /** What the chain says about a signature, or `null` if it has never heard of it. */
  async getSignatureOutcome(signature: string): Promise<SignatureOutcome | null> {
    const statuses = await this.connection.getSignatureStatuses([signature], {
      searchTransactionHistory: true,
    });
    const status = statuses.value[0];
    if (!status) return null;

    // Anything short of finalized is not an answer yet: it can still be rolled back.
    if (status.confirmationStatus !== 'finalized') return { landed: false, err: null };
    return { landed: true, err: status.err };
  }

  async getBlockHeight(): Promise<number> {
    return this.connection.getBlockHeight('finalized');
  }

  /** Treasury USDC balance in micro-USDC, or 0 if the account does not exist yet. */
  async treasuryBalance(): Promise<number> {
    try {
      const account = await getAccount(this.connection, this.treasuryTokenAccount);
      return Number(account.amount);
    } catch (error) {
      if (isMissingTokenAccount(error)) return 0;
      throw error;
    }
  }

  private async tokenAccountExists(address: PublicKey): Promise<boolean> {
    try {
      await getAccount(this.connection, address);
      return true;
    } catch (error) {
      if (isMissingTokenAccount(error)) return false;
      throw error;
    }
  }
}

function isMissingTokenAccount(error: unknown): boolean {
  return error instanceof TokenAccountNotFoundError || error instanceof TokenInvalidAccountOwnerError;
}

/**
 * Base58, the encoding Solana signatures are quoted in.
 *
 * Written out rather than pulled from a dependency because it is fifteen lines and this is
 * the only place the project needs it — and because a signature that round-trips wrongly
 * would mean asking the chain about a transaction that does not exist, which is the single
 * most dangerous way this file could fail. `bs58.test.ts` checks it against known vectors.
 */
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function bs58(bytes: Uint8Array): string {
  // Starts empty, not [0]. Seeding it with a zero digit emits a spurious leading '1' — the
  // all-zero key encodes to 33 characters instead of 32, and empty input to '1' instead of
  // ''. Caught by cross-checking against PublicKey.toBase58(), which is the entire reason
  // that test compares against an independent implementation rather than my own expectations.
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) {
      carry += digits[i]! << 8;
      digits[i] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }

  // Every leading zero byte is a literal '1', not a positional digit.
  let out = '';
  for (const byte of bytes) {
    if (byte !== 0) break;
    out += ALPHABET[0];
  }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]!];
  return out;
}
