#!/usr/bin/env node
/**
 * Launch one task by hand and report exactly why it stopped.
 *
 * ## Why this exists
 *
 * An ECS deployment circuit breaker rolls the stack back when a task will not start, and the
 * rollback deletes the cluster and the log groups with it — so the reason the task failed is
 * gone before anyone can read it. Three deploys failed that way here, and the failure was
 * diagnosed from its shape rather than its cause twice, wrongly both times.
 *
 * Deploy with `-c desiredCount=0` so nothing auto-starts and nothing rolls back, then run
 * this. It starts a single task, waits for it to stop, and prints the fields that actually
 * name the problem:
 *
 * - `stoppedReason` on the task — where `ResourceInitializationError` and
 *   `CannotPullContainerError` appear. These are agent-level failures that happen *before*
 *   the container runs, which is why they never reach the application log.
 * - `reason` and `exitCode` per container — where an application crash appears.
 * - the log stream, if the container got far enough to write one.
 *
 * The distinction between the first and the last is the whole point: no log stream at all
 * means the container never started, and looking for an application bug is looking in the
 * wrong place entirely.
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
  const d = await new CloudFormationClient({ region: REGION }).send(
    new DescribeStacksCommand({ StackName: STACK }),
  );
  return Object.fromEntries(
    (d.Stacks?.[0]?.Outputs ?? []).flatMap((o) =>
      o.OutputKey && o.OutputValue ? [[o.OutputKey, o.OutputValue]] : [],
    ),
  );
}

async function main(): Promise<void> {
  const out = await outputs();
  const ecs = new ECSClient({ region: REGION });

  console.log('launching one wallet-worker task with its normal command…');
  const started = await ecs.send(
    new RunTaskCommand({
      cluster: out['ClusterName']!,
      taskDefinition: out['WalletWorkerTaskArn']!,
      launchType: 'FARGATE',
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: out['TaskSubnetIds']!.split(','),
          securityGroups: [out['WorkerSecurityGroupId']!],
          assignPublicIp: 'DISABLED',
        },
      },
    }),
  );

  const taskArn = started.tasks?.[0]?.taskArn;
  if (!taskArn) {
    const f = started.failures?.[0];
    // RunTask can refuse outright — a capacity or configuration problem that never becomes
    // a task at all. Worth naming separately from a task that started and then died.
    throw new Error(`RunTask refused to start it: ${f?.reason ?? '?'} ${f?.detail ?? ''}`);
  }
  console.log(`task ${taskArn.split('/').pop()}`);

  let last = '';
  const deadline = Date.now() + 420_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('timed out waiting for the task to settle');
    await sleep(5_000);
    const d = await ecs.send(
      new DescribeTasksCommand({ cluster: out['ClusterName']!, tasks: [taskArn] }),
    );
    const task = d.tasks?.[0];
    if (!task) throw new Error('task vanished');
    if (task.lastStatus !== last) {
      last = task.lastStatus ?? '?';
      console.log(`  ${last}`);
    }

    if (task.lastStatus === 'STOPPED') {
      console.log('\n--- why it stopped ---');
      console.log('stoppedReason :', task.stoppedReason ?? '(none)');
      console.log('stopCode      :', task.stopCode ?? '(none)');
      for (const c of task.containers ?? []) {
        console.log(`container ${c.name}: exit=${c.exitCode ?? '-'} reason=${c.reason ?? '-'}`);
      }
      break;
    }

    // Running is the interesting case when the whole complaint was "it never starts".
    if (task.lastStatus === 'RUNNING') {
      console.log('\nIt is RUNNING. Leaving it up for 60s to see whether it stays.');
      await sleep(60_000);
      const again = await ecs.send(
        new DescribeTasksCommand({ cluster: out['ClusterName']!, tasks: [taskArn] }),
      );
      const t2 = again.tasks?.[0];
      console.log(`after 60s: ${t2?.lastStatus} ${t2?.stoppedReason ?? ''}`);
      break;
    }
  }

  const taskId = taskArn.split('/').pop()!;
  const logs = new CloudWatchLogsClient({ region: REGION });
  try {
    const read = await logs.send(
      new GetLogEventsCommand({
        logGroupName: out['WalletWorkerLogGroup']!,
        logStreamName: `wallet-worker/worker/${taskId}`,
        startFromHead: true,
      }),
    );
    const events = read.events ?? [];
    if (events.length === 0) {
      console.log('\nNo log events — the container never wrote anything.');
    } else {
      console.log('\n--- container log ---');
      for (const e of events) console.log('  ' + (e.message ?? '').trimEnd());
    }
  } catch (error) {
    // No stream is itself the finding: the container never started, so the failure is in
    // task setup and not in anything the application did.
    console.log(
      `\nNo log stream (${(error as { name?: string }).name}). The container never started — ` +
        'read stoppedReason above, not the application code.',
    );
  }
}

main().catch((error: Error) => {
  console.error(`\n[1;31mDiagnose failed.[0m ${error.message}`);
  process.exit(1);
});
