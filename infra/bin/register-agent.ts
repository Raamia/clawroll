#!/usr/bin/env node
/**
 * Register an agent against the deployed room.
 *
 * ## Why this is not just the registration CLI
 *
 * Registering an agent writes to Postgres and derives a deposit address from the master seed.
 * The database sits in isolated subnets with no public access and the seed lives in exactly
 * one place, so neither is reachable from a laptop — by design, and worth keeping that way.
 *
 * Without something like this the deployed room would have no way to create an agent at all:
 * it would come up healthy, serve an empty table forever, and nobody could sit down. That is
 * the kind of gap that only shows up after the infrastructure is already running.
 *
 * ## Why a one-off task rather than ECS Exec
 *
 * `aws ecs execute-command` is the usual answer and it needs three things this deliberately
 * avoids: a working AWS CLI, the Session Manager plugin installed separately, and an
 * interactive shell inside a container that holds the master seed. Running the existing
 * worker task definition with an overridden command needs none of them, leaves no shell open,
 * and reuses the exact IAM role, security group, and secret wiring the worker already has —
 * so registration cannot drift from what the worker itself can do.
 *
 * The task writes its output to CloudWatch and exits. This reads it back and prints it.
 */

import {
  DescribeTasksCommand,
  ECSClient,
  RunTaskCommand,
} from '@aws-sdk/client-ecs';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const STACK = 'Clawroll';
const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function outputs(): Promise<Record<string, string>> {
  const described = await new CloudFormationClient({ region: REGION }).send(
    new DescribeStacksCommand({ StackName: STACK }),
  );
  const list = described.Stacks?.[0]?.Outputs ?? [];
  return Object.fromEntries(
    list.flatMap((o) => (o.OutputKey && o.OutputValue ? [[o.OutputKey, o.OutputValue]] : [])),
  );
}

async function main(): Promise<void> {
  const displayName = process.argv[2];
  if (!displayName) {
    console.error('usage: register-agent <display-name>');
    process.exit(2);
  }

  const out = await outputs();
  const required = [
    'ClusterName',
    'WalletWorkerTaskArn',
    'WalletWorkerLogGroup',
    'TaskSubnetIds',
    'WorkerSecurityGroupId',
  ];
  for (const key of required) {
    if (!out[key]) throw new Error(`Stack output ${key} is missing — redeploy before registering.`);
  }

  const ecs = new ECSClient({ region: REGION });

  console.error(`Registering "${displayName}"…`);
  const started = await ecs.send(
    new RunTaskCommand({
      cluster: out['ClusterName']!,
      taskDefinition: out['WalletWorkerTaskArn']!,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          // The same private subnets and security group the worker runs in. The security
          // group is what the database's ingress rule actually names, so borrowing it is
          // what makes this reach Postgres at all.
          subnets: out['TaskSubnetIds']!.split(','),
          securityGroups: [out['WorkerSecurityGroupId']!],
          assignPublicIp: 'DISABLED',
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: 'worker',
            // The image's default command runs the worker's main loop. The display name is
            // passed as its own argv element rather than interpolated into the shell string,
            // so a name containing a quote or a semicolon is data and not syntax.
            command: [
              'sh',
              '-c',
              'exec node_modules/.bin/tsx apps/wallet-worker/src/register.ts "$0"',
              displayName,
            ],
          },
        ],
      },
    }),
  );

  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const reason = started.failures?.[0];
    throw new Error(`Task did not start: ${reason?.reason ?? 'unknown'} ${reason?.detail ?? ''}`);
  }

  // Poll rather than use a waiter: the task is expected to run for seconds, and a waiter's
  // fixed 6-second interval would usually mean waiting well past the point it finished.
  let exitCode: number | undefined;
  const deadline = Date.now() + 300_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for the registration task.');
    await sleep(3_000);
    const described = await ecs.send(
      new DescribeTasksCommand({ cluster: out['ClusterName']!, tasks: [taskArn] }),
    );
    const task = described.tasks?.[0];
    if (task?.lastStatus === 'STOPPED') {
      exitCode = task.containers?.[0]?.exitCode;
      if (exitCode !== 0) {
        console.error(`\nTask stopped with exit code ${exitCode ?? '(none)'}.`);
        console.error(`Reason: ${task.stoppedReason ?? 'unknown'}`);
      }
      break;
    }
    process.stderr.write('.');
  }
  process.stderr.write('\n');

  // The log stream name follows the awslogs driver's convention: prefix/container/task-id.
  const taskId = taskArn.split('/').pop()!;
  const logs = new CloudWatchLogsClient({ region: REGION });

  // Delivery lags the task's exit by a second or two, so an immediate read often finds
  // nothing. Retry briefly rather than reporting an empty registration as a success.
  let events: { message?: string }[] = [];
  for (let attempt = 0; attempt < 10 && events.length === 0; attempt++) {
    await sleep(2_000);
    try {
      const read = await logs.send(
        new GetLogEventsCommand({
          logGroupName: out['WalletWorkerLogGroup']!,
          logStreamName: `wallet-worker/worker/${taskId}`,
          startFromHead: true,
        }),
      );
      events = read.events ?? [];
    } catch {
      // The stream may not exist yet. Keep trying until the budget runs out.
    }
  }

  if (events.length === 0) {
    throw new Error(
      'The task ran but produced no readable output.\n' +
        `  Check the ${out['WalletWorkerLogGroup']} log group for stream wallet-worker/worker/${taskId}.`,
    );
  }

  console.log();
  for (const event of events) console.log(event.message ?? '');

  if (exitCode !== 0) process.exit(1);

  console.error(
    '\nThe API key above is shown once and is not recoverable — only its hash is stored.\n' +
      'Fund the deposit address from https://faucet.circle.com to give the agent a bankroll.',
  );
}

main().catch((error: Error) => {
  console.error(`\n[1;31mRegistration failed.[0m ${error.message}`);
  process.exit(1);
});
