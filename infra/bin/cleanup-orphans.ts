#!/usr/bin/env node
/**
 * Delete the VPCs and databases left behind by failed deploys.
 *
 * ## Why this is needed at all
 *
 * The database carries `RETAIN`, so a failed deploy's rollback keeps it — and a retained RDS
 * instance holds network interfaces in its subnet, which stops CloudFormation deleting the
 * subnet and therefore the VPC. Each failed deploy consequently leaves one orphaned VPC and
 * one orphaned database behind.
 *
 * That is merely untidy until it is not: the default quota is **5 VPCs per region**. Four
 * failed deploys plus the account's default VPC reaches it exactly, and the next deploy fails
 * at `The maximum number of VPCs has been reached` — long before anything interesting happens.
 * The orphans stop being a cost problem and become a hard blocker.
 *
 * ## What it will and will not touch
 *
 * Only VPCs tagged `Name=Clawroll/Vpc`, and only databases whose identifier begins with
 * `clawroll-database`. The default VPC is skipped explicitly and by name, because deleting it
 * is both easy to do by accident here and annoying to reverse.
 *
 * **It refuses to touch anything belonging to a live stack.** A VPC that CloudFormation still
 * owns is not an orphan, and deleting it out from under a working deployment is exactly the
 * kind of "cleanup" that causes an outage. Pass `--force` only when you have checked.
 *
 * ## Ordering
 *
 * AWS will not delete a VPC while anything is attached, and the dependencies must go in a
 * specific order: databases first (they own the network interfaces), then NAT gateways —
 * which take minutes and must be *waited* on, not merely requested — then interfaces,
 * endpoints, subnets, route tables, gateways, security groups, and only then the VPC. Getting
 * the order wrong produces `DependencyViolation` with no indication of which dependency.
 */

import {
  DeleteNatGatewayCommand,
  DeleteNetworkInterfaceCommand,
  DeleteRouteTableCommand,
  DeleteSecurityGroupCommand,
  DeleteSubnetCommand,
  DeleteVpcCommand,
  DeleteVpcEndpointsCommand,
  DeleteInternetGatewayCommand,
  DescribeInternetGatewaysCommand,
  DescribeNatGatewaysCommand,
  DescribeNetworkInterfacesCommand,
  DescribeRouteTablesCommand,
  DescribeSecurityGroupsCommand,
  DescribeSubnetsCommand,
  DescribeVpcEndpointsCommand,
  DescribeVpcsCommand,
  DetachInternetGatewayCommand,
  EC2Client,
} from '@aws-sdk/client-ec2';
import {
  DeleteDBInstanceCommand,
  DescribeDBInstancesCommand,
  ModifyDBInstanceCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { CloudFormationClient, DescribeStacksCommand } from '@aws-sdk/client-cloudformation';

const REGION = process.env['AWS_REGION'] ?? process.env['CDK_DEFAULT_REGION'] ?? 'us-east-1';
const ec2 = new EC2Client({ region: REGION });
const rds = new RDSClient({ region: REGION });
const cfn = new CloudFormationClient({ region: REGION });

const VPC_NAME = 'Clawroll/Vpc';
const DB_PREFIX = 'clawroll-database';
const force = process.argv.includes('--force');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Swallow the "already gone" races that make cleanup scripts fail on reruns. */
async function tolerant(what: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
    console.log(`    deleted ${what}`);
  } catch (error) {
    const message = (error as Error).message ?? '';
    if (/NotFound|does not exist|InvalidGroup\.NotFound/i.test(message)) return;
    console.log(`    could not delete ${what}: ${message.slice(0, 140)}`);
  }
}

async function liveStackExists(): Promise<boolean> {
  try {
    const r = await cfn.send(new DescribeStacksCommand({ StackName: 'Clawroll' }));
    const status = r.Stacks?.[0]?.StackStatus ?? '';
    // A rolled-back or half-deleted stack does not own anything worth protecting.
    return !/ROLLBACK_COMPLETE|ROLLBACK_FAILED|DELETE_FAILED|DELETE_COMPLETE/.test(status);
  } catch {
    return false;
  }
}

async function deleteDatabases(): Promise<string[]> {
  const d = await rds.send(new DescribeDBInstancesCommand({}));
  const mine = (d.DBInstances ?? []).filter((x) =>
    (x.DBInstanceIdentifier ?? '').startsWith(DB_PREFIX),
  );
  if (mine.length === 0) return [];

  console.log(`\ndatabases to remove: ${mine.length}`);
  const ids: string[] = [];
  for (const db of mine) {
    const id = db.DBInstanceIdentifier!;
    ids.push(id);
    console.log(`  ${id} (${db.DBInstanceStatus})`);
    if (db.DeletionProtection) {
      // Deletion protection is on by design and has to be turned off deliberately. That it
      // requires a separate call is the point of it.
      await tolerant(`${id} deletion protection`, () =>
        rds.send(
          new ModifyDBInstanceCommand({
            DBInstanceIdentifier: id,
            DeletionProtection: false,
            ApplyImmediately: true,
          }),
        ),
      );
    }
    await tolerant(id, () =>
      rds.send(
        new DeleteDBInstanceCommand({
          DBInstanceIdentifier: id,
          SkipFinalSnapshot: true,
          DeleteAutomatedBackups: true,
        }),
      ),
    );
  }
  return ids;
}

async function waitForDatabasesGone(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  console.log('\nwaiting for databases to finish deleting…');
  const deadline = Date.now() + 1_800_000;
  for (;;) {
    const d = await rds.send(new DescribeDBInstancesCommand({}));
    const left = (d.DBInstances ?? []).filter((x) => ids.includes(x.DBInstanceIdentifier ?? ''));
    if (left.length === 0) {
      console.log('  all gone');
      return;
    }
    if (Date.now() > deadline) throw new Error(`timed out; ${left.length} still present`);
    console.log(`  ${left.length} remaining (${left.map((x) => x.DBInstanceStatus).join(', ')})`);
    await sleep(30_000);
  }
}

async function emptyAndDeleteVpc(vpcId: string): Promise<void> {
  console.log(`\nemptying ${vpcId}`);
  const inVpc = { Filters: [{ Name: 'vpc-id', Values: [vpcId] }] };

  // NAT gateways first, and actually waited on — they hold elastic network interfaces and a
  // delete request returns immediately while the teardown takes minutes.
  const nats = await ec2.send(new DescribeNatGatewaysCommand({ Filter: [{ Name: 'vpc-id', Values: [vpcId] }] }));
  const natIds = (nats.NatGateways ?? [])
    .filter((n) => n.State !== 'deleted' && n.State !== 'deleting')
    .flatMap((n) => (n.NatGatewayId ? [n.NatGatewayId] : []));
  for (const id of natIds) {
    await tolerant(`nat ${id}`, () => ec2.send(new DeleteNatGatewayCommand({ NatGatewayId: id })));
  }
  if (natIds.length > 0) {
    console.log('    waiting for NAT gateways…');
    for (let i = 0; i < 40; i++) {
      const check = await ec2.send(
        new DescribeNatGatewaysCommand({ Filter: [{ Name: 'vpc-id', Values: [vpcId] }] }),
      );
      const pending = (check.NatGateways ?? []).filter((n) => n.State === 'deleting');
      if (pending.length === 0) break;
      await sleep(15_000);
    }
  }

  const endpoints = await ec2.send(new DescribeVpcEndpointsCommand(inVpc));
  const epIds = (endpoints.VpcEndpoints ?? []).flatMap((e) => (e.VpcEndpointId ? [e.VpcEndpointId] : []));
  if (epIds.length > 0) {
    await tolerant('vpc endpoints', () => ec2.send(new DeleteVpcEndpointsCommand({ VpcEndpointIds: epIds })));
  }

  const enis = await ec2.send(new DescribeNetworkInterfacesCommand(inVpc));
  for (const eni of enis.NetworkInterfaces ?? []) {
    if (eni.Status === 'in-use' && eni.Attachment?.DeleteOnTermination) continue;
    await tolerant(`eni ${eni.NetworkInterfaceId}`, () =>
      ec2.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eni.NetworkInterfaceId! })),
    );
  }

  const subnets = await ec2.send(new DescribeSubnetsCommand(inVpc));
  for (const s of subnets.Subnets ?? []) {
    await tolerant(`subnet ${s.SubnetId}`, () => ec2.send(new DeleteSubnetCommand({ SubnetId: s.SubnetId! })));
  }

  const tables = await ec2.send(new DescribeRouteTablesCommand(inVpc));
  for (const t of tables.RouteTables ?? []) {
    // The main route table cannot be deleted and goes with the VPC.
    if ((t.Associations ?? []).some((a) => a.Main)) continue;
    await tolerant(`route table ${t.RouteTableId}`, () =>
      ec2.send(new DeleteRouteTableCommand({ RouteTableId: t.RouteTableId! })),
    );
  }

  const igws = await ec2.send(
    new DescribeInternetGatewaysCommand({ Filters: [{ Name: 'attachment.vpc-id', Values: [vpcId] }] }),
  );
  for (const g of igws.InternetGateways ?? []) {
    await tolerant(`detach igw ${g.InternetGatewayId}`, () =>
      ec2.send(new DetachInternetGatewayCommand({ InternetGatewayId: g.InternetGatewayId!, VpcId: vpcId })),
    );
    await tolerant(`igw ${g.InternetGatewayId}`, () =>
      ec2.send(new DeleteInternetGatewayCommand({ InternetGatewayId: g.InternetGatewayId! })),
    );
  }

  const groups = await ec2.send(new DescribeSecurityGroupsCommand(inVpc));
  for (const g of groups.SecurityGroups ?? []) {
    if (g.GroupName === 'default') continue;
    await tolerant(`sg ${g.GroupId}`, () => ec2.send(new DeleteSecurityGroupCommand({ GroupId: g.GroupId! })));
  }

  await tolerant(`vpc ${vpcId}`, () => ec2.send(new DeleteVpcCommand({ VpcId: vpcId })));
}

async function main(): Promise<void> {
  if (!force && (await liveStackExists())) {
    throw new Error(
      'A live Clawroll stack exists. Its VPC is not an orphan, and deleting it would take ' +
        'down a working deployment. Re-run with --force only if you have checked.',
    );
  }

  const ids = await deleteDatabases();
  await waitForDatabasesGone(ids);

  const v = await ec2.send(new DescribeVpcsCommand({}));
  const orphans = (v.Vpcs ?? []).filter(
    (x) => !x.IsDefault && (x.Tags ?? []).some((t) => t.Key === 'Name' && t.Value === VPC_NAME),
  );
  console.log(`\norphaned VPCs: ${orphans.length}`);
  for (const vpc of orphans) await emptyAndDeleteVpc(vpc.VpcId!);

  const after = await ec2.send(new DescribeVpcsCommand({}));
  console.log(`\nVPCs remaining: ${after.Vpcs?.length}`);
  for (const x of after.Vpcs ?? []) {
    console.log('  ', x.VpcId, 'default=' + x.IsDefault);
  }
}

main().catch((error: Error) => {
  console.error(`\n[1;31mCleanup failed.[0m ${error.message}`);
  process.exit(1);
});
