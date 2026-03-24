#!/usr/bin/env node
/**
 * CDK entry point.
 *
 * Account and region come from the ambient AWS environment rather than being hard-coded, so
 * the same stack deploys to whatever credentials are configured. `SOLANA_RPC_URL` is worth
 * setting: the public devnet endpoint is rate-limited, and a deposit scanner that gets
 * throttled misses deposits silently rather than failing loudly.
 */

import { App } from 'aws-cdk-lib';
import { ClawrollStack } from '../lib/clawroll-stack.js';

const app = new App();

new ClawrollStack(app, 'Clawroll', {
  env: {
    // Spread conditionally: under `exactOptionalPropertyTypes`, an explicit `undefined` is
    // not the same as an absent key, and CDK reads an absent account as "resolve at deploy
    // time" — which is what we want when running without credentials, as `cdk synth` does.
    ...(process.env['CDK_DEFAULT_ACCOUNT']
      ? { account: process.env['CDK_DEFAULT_ACCOUNT'] }
      : {}),
    region: process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1',
  },
  ...(process.env['SOLANA_RPC_URL'] ? { solanaRpcUrl: process.env['SOLANA_RPC_URL'] } : {}),
  description: 'Clawroll — poker for agents (Solana devnet)',
});
