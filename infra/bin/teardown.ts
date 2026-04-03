#!/usr/bin/env node
/**
 * Delete the stack, retaining whatever CloudFormation cannot delete.
 *
 * ## Why `cdk destroy` is not enough
 *
 * The database, the site bucket, the KMS key and the master seed all carry `RETAIN`, because
 * the ledger is the system of record for money and losing it to a typo is not a recoverable
 * mistake. That protection has a consequence nobody mentions until it bites: a retained RDS
 * instance keeps network interfaces in its subnet, so CloudFormation cannot delete the subnet
 * around it, cannot delete its security group, and therefore cannot delete the VPC. The
 * teardown fails part-way and the stack sits in `DELETE_FAILED`.
 *
 * The fix is a retain-list, and CloudFormation only accepts one for a stack that is *already*
 * in `DELETE_FAILED` — so this is inherently a loop: attempt, read which logical ids failed,
 * attempt again retaining exactly those. Each pass gets further, because the resources that
 * blocked the last one are now skipped.
 *
 * ## What survives, and roughly what it costs
 *
 * Whatever gets retained, plus everything with an explicit `RETAIN` policy: the database, the
 * bucket, the key, the seed, and usually the VPC and one subnet. An empty VPC costs nothing;
 * the NAT gateway is normally deleted, which is the only expensive piece. The database keeps
 * billing until it is removed by hand — deliberately, since deleting it is exactly the thing
 * the retain policy exists to prevent.
 *
 * It prints what it left behind. An orphaned resource nobody knows about is how a cloud bill
 * grows a floor.
 */

import {
  CloudFormationClient,
  DeleteStackCommand,
  DescribeStackEventsCommand,
  DescribeStackResourcesCommand,
  DescribeStacksCommand,
} from '@aws-sdk/client-cloudformation';

const STACK = 'Clawroll';
const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';
const client = new CloudFormationClient({ region: REGION });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function status(): Promise<string> {
  try {
    const r = await client.send(new DescribeStacksCommand({ StackName: STACK }));
    return r.Stacks?.[0]?.StackStatus ?? 'UNKNOWN';
  } catch (error) {
    // A stack that no longer exists is the success case, not a failure.
    if ((error as { name?: string }).name === 'ValidationError') return 'GONE';
    throw error;
  }
}

async function waitForTerminal(): Promise<string> {
  for (;;) {
    const s = await status();
    if (s === 'GONE' || s.endsWith('_FAILED') || s === 'DELETE_COMPLETE') return s;
    await sleep(15_000);
  }
}

/** Logical ids that failed to delete on the most recent attempt. */
async function failedResources(): Promise<string[]> {
  const events = await client.send(new DescribeStackEventsCommand({ StackName: STACK }));
  const failed = new Set<string>();
  for (const event of events.StackEvents ?? []) {
    // Newest first. Stop at the start of the current delete so an older attempt's failures
    // are not carried forward — they may well delete fine this time.
    if (event.ResourceType === 'AWS::CloudFormation::Stack' && event.ResourceStatus === 'DELETE_IN_PROGRESS') {
      break;
    }
    if (event.ResourceStatus === 'DELETE_FAILED' && event.LogicalResourceId) {
      failed.add(event.LogicalResourceId);
    }
  }
  return [...failed];
}

async function survivors(): Promise<{ type: string; id: string }[]> {
  try {
    const r = await client.send(new DescribeStackResourcesCommand({ StackName: STACK }));
    return (r.StackResources ?? []).map((x) => ({
      type: x.ResourceType ?? '?',
      id: x.PhysicalResourceId ?? '?',
    }));
  } catch {
    return [];
  }
}

async function main(): Promise<void> {
  let current = await status();
  console.log(`stack ${STACK} is ${current}`);
  if (current === 'GONE') {
    console.log('Nothing to do.');
    return;
  }

  const retained = new Set<string>();

  // Bounded rather than `while (true)`: if a pass ever fails to make progress, looping
  // forever hides that far worse than stopping and saying so.
  for (let pass = 1; pass <= 6; pass++) {
    const retain = [...retained];
    console.log(
      `\npass ${pass}: deleting${retain.length ? `, retaining ${retain.length}: ${retain.join(', ')}` : ''}`,
    );

    await client.send(
      new DeleteStackCommand({
        StackName: STACK,
        ...(retain.length > 0 ? { RetainResources: retain } : {}),
      }),
    );

    current = await waitForTerminal();
    console.log(`  → ${current}`);
    if (current === 'GONE' || current === 'DELETE_COMPLETE') break;

    const failed = await failedResources();
    const fresh = failed.filter((id) => !retained.has(id));
    if (fresh.length === 0) {
      throw new Error(
        `Stuck in ${current} with nothing new to retain. Look at the stack events in the ` +
          'console — something is failing for a reason a retain-list cannot fix.',
      );
    }
    for (const id of fresh) retained.add(id);
  }

  if (current !== 'GONE' && current !== 'DELETE_COMPLETE') {
    throw new Error(`Gave up after 6 passes; stack is ${current}.`);
  }

  console.log('\nStack deleted.');
  if (retained.size > 0) {
    console.log(`\nRetained (still billing, remove by hand when you mean it):`);
    for (const id of retained) console.log(`  ${id}`);
  }
  console.log(
    '\nAlso surviving by design: the database, the site bucket, the KMS key and the master\n' +
      'seed secret. They carry RETAIN because the ledger is the system of record for money.\n' +
      'The database is the only one that costs real money — delete it in the RDS console\n' +
      '(disable deletion protection first) once you are certain you want it gone.',
  );

  const left = await survivors();
  if (left.length > 0) {
    console.log('\nStill associated with the stack:');
    for (const s of left) console.log(`  ${s.type.padEnd(38)} ${s.id}`);
  }
}

main().catch((error: Error) => {
  console.error(`\n[1;31mTeardown failed.[0m ${error.message}`);
  process.exit(1);
});
