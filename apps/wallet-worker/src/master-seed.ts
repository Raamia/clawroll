/**
 * Getting hold of the master mnemonic.
 *
 * ## Why this is not an injected environment variable in production
 *
 * It was, and that made the stack impossible to deploy. ECS resolves `secrets:` *before* it
 * starts a container, and the master seed secret is created deliberately empty — its ARN does
 * not even exist until the deploy that creates it has finished. So the worker could never
 * start on a first deploy, its deployment circuit breaker tripped, and CloudFormation rolled
 * the entire stack back. A genuine circular dependency: the deploy needed the secret, and the
 * secret needed the deploy.
 *
 * Fetching it at runtime breaks the cycle. The container starts regardless, and an unset seed
 * becomes a normal waiting state rather than a failure to launch — so the deploy completes,
 * the operator populates the secret, and the worker picks it up on its next check with no
 * redeploy and no scaling dance.
 *
 * ## Why it is shared
 *
 * It lived inside the worker's `main.ts`, and the registration CLI read
 * `SOLANA_MASTER_MNEMONIC` directly instead. That was fine only while the task definition
 * still injected that variable; once the worker started fetching the secret itself, nothing
 * set it any more and registration failed with `SOLANA_MASTER_MNEMONIC must be set` — on a
 * stack where the seed was, in fact, perfectly well set. Two ways of answering the same
 * question is two things to keep in step, and this pair did not stay in step for one commit.
 */

/** `SOLANA_MASTER_MNEMONIC` wins when set — local development and tests rely on it. */
export interface MasterSeedOptions {
  /**
   * Keep polling until the secret has a value.
   *
   * True for the long-running worker, where an unpopulated seed is a state to sit in. False
   * for one-shot commands, where it is a reason to exit with something a human can act on
   * rather than a task that hangs until someone kills it.
   */
  readonly wait: boolean;
}

export async function loadMasterMnemonic({ wait }: MasterSeedOptions): Promise<string> {
  const direct = process.env['SOLANA_MASTER_MNEMONIC'];
  if (direct) return direct;

  const secretArn = process.env['MASTER_SEED_SECRET_ARN'];
  if (!secretArn) {
    throw new Error('either SOLANA_MASTER_MNEMONIC or MASTER_SEED_SECRET_ARN must be set');
  }

  // Imported lazily so local development and tests never load the AWS SDK at all.
  const { SecretsManagerClient, GetSecretValueCommand } = await import(
    '@aws-sdk/client-secrets-manager'
  );
  const client = new SecretsManagerClient({});

  for (let attempt = 0; ; attempt++) {
    try {
      const { SecretString } = await client.send(new GetSecretValueCommand({ SecretId: secretArn }));
      if (SecretString && SecretString.trim() !== '') return SecretString;
    } catch (error) {
      // A secret with no version raises ResourceNotFoundException, which is exactly the
      // fresh-stack state — not an error worth crashing over. Anything else is.
      if ((error as { name?: string }).name !== 'ResourceNotFoundException') throw error;
    }

    if (!wait) {
      throw new Error(
        `the master seed secret is empty.\n` +
          `  Populate it with: pnpm --filter @clawroll/infra put-secret ${secretArn}`,
      );
    }

    // Logged every time, not once: a worker idling for a reason nobody can see looks
    // identical to a worker that is wedged.
    console.log(
      `[clawroll] master seed not set yet (attempt ${attempt + 1}). Waiting. ` +
        `Populate it with: pnpm --filter @clawroll/infra put-secret ${secretArn}`,
    );
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
