/**
 * The Clawroll stack.
 *
 * Ship-fast tier, as agreed: single-AZ, minimal, but written so hardening is a change of
 * parameters rather than a rewrite. Roughly $70–120/month.
 *
 * ## Why ECS Fargate and not Lambda
 *
 * The table runtime holds live state and drives sub-second timers, and agents hold WebSocket
 * connections open for the length of a session. Lambda's execution model is the opposite of
 * all three: no durable in-process state, no long-lived connections, and a per-invocation
 * billing model that punishes an idle socket. API Gateway WebSockets would push the runtime
 * into DynamoDB and turn every action into a round trip — replacing a design that works with
 * one that fights the platform.
 *
 * ## One engine task, deliberately
 *
 * `desiredCount: 1`. The runtime keeps a table in memory, so two tasks behind a load balancer
 * would each own a *different* copy of the same table. Redis-backed table ownership is
 * designed for (F9) but not built, and running two tasks before it exists would be a
 * correctness bug, not a scaling win. Stated here because "just bump desiredCount" is the
 * obvious wrong move.
 *
 * ## The master seed is created empty, on purpose
 *
 * `Secret` with no `generateSecretString` and no value. It is populated once, out of band,
 * by a human. **A seed passed through CDK ends up in the CloudFormation template, in the
 * change set, and in CloudTrail** — three places it can never be removed from. The secret's
 * *container* is infrastructure; its contents are not.
 */

import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import type { Construct } from 'constructs';

export interface ClawrollStackProps extends StackProps {
  /** Devnet RPC endpoint. A dedicated provider is strongly preferred — see README. */
  readonly solanaRpcUrl?: string;
}

export class ClawrollStack extends Stack {
  constructor(scope: Construct, id: string, props: ClawrollStackProps = {}) {
    super(scope, id, props);

    // -----------------------------------------------------------------------
    // Network
    // -----------------------------------------------------------------------

    const vpc = new ec2.Vpc(this, 'Vpc', {
      maxAzs: 2,
      // One NAT, not one per AZ. It is the single largest line on the bill at this size
      // (~$32/month each), and a NAT outage costs us outbound RPC calls rather than the
      // game — agents connect inbound through the load balancer.
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });

    // -----------------------------------------------------------------------
    // Secrets
    // -----------------------------------------------------------------------

    const key = new kms.Key(this, 'SecretsKey', {
      description: 'Clawroll secrets (database credentials, Solana master seed)',
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // Genuinely empty. Populate it once, by hand:
    //   aws secretsmanager put-secret-value --secret-id <arn> --secret-string '<mnemonic>'
    //
    // Putting the mnemonic anywhere in CDK would write it into the CloudFormation template,
    // the change set and CloudTrail — three places it can never be removed from. This *is*
    // the custody position for every deposit address in the system.
    //
    // `CfnSecret` rather than the L2 `Secret` construct, and that distinction matters. The
    // L2 emits `GenerateSecretString: {}` when given no value, which fills the secret with a
    // random 32-character string. Nothing leaks — but the secret then *looks* populated when
    // it is not, and the only thing standing between that and a silent misconfiguration is
    // the BIP-39 checksum refusing it at worker startup. Better not to create the ambiguity:
    // an empty secret is unmistakably unconfigured.
    const masterSeedResource = new secretsmanager.CfnSecret(this, 'SolanaMasterSeed', {
      description: 'BIP-39 mnemonic for Clawroll deposit addresses — populate out of band',
      kmsKeyId: key.keyArn,
    });
    masterSeedResource.applyRemovalPolicy(RemovalPolicy.RETAIN);

    const masterSeed = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'SolanaMasterSeedRef',
      masterSeedResource.ref,
    );

    // -----------------------------------------------------------------------
    // Data
    // -----------------------------------------------------------------------

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_16_4,
      }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.SMALL),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      // Single-AZ at this tier. The subnet group still spans two AZs because RDS requires
      // it — which also means flipping `multiAz: true` later is a parameter change, not a
      // migration.
      multiAz: false,
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      storageEncryptionKey: key,
      credentials: rds.Credentials.fromGeneratedSecret('clawroll', { encryptionKey: key }),
      databaseName: 'clawroll',
      backupRetention: Duration.days(7),
      deleteAutomatedBackups: false,
      // The ledger is the system of record for money. Losing it to a `cdk destroy` typo is
      // not a recoverable mistake.
      removalPolicy: RemovalPolicy.RETAIN,
      deletionProtection: true,
      enablePerformanceInsights: false,
    });

    // No Redis.
    //
    // It was provisioned here for spectator fan-out, presence and table ownership — none of
    // which is built, and an idle cache is still ~$12/month. Re-adding it is fifteen lines,
    // and the moment to do that is when Redis-backed table ownership lands and a second
    // engine task becomes possible. Paying for infrastructure no code references is the kind
    // of thing that quietly becomes permanent.

    // -----------------------------------------------------------------------
    // Compute
    // -----------------------------------------------------------------------

    const cluster = new ecs.Cluster(this, 'Cluster', { vpc, containerInsights: true });

    const image = ecs.ContainerImage.fromAsset('..', {
      file: 'Dockerfile',
      buildArgs: { SERVICE: 'engine' },
    });

    const commonEnvironment = {
      NODE_ENV: 'production',
      SOLANA_RPC_URL: props.solanaRpcUrl ?? 'https://api.devnet.solana.com',
    };

    const engine = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Engine', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      // One task. The runtime holds a table in memory, so a second task would own a
      // different copy of the same table. See the note at the top of this file.
      desiredCount: 1,
      publicLoadBalancer: true,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      taskImageOptions: {
        image,
        containerPort: 8080,
        environment: commonEnvironment,
        secrets: {
          DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret!, 'uri'),
        },
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'engine',
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
      // A rolling deploy that fails should stop and roll back rather than cycle forever.
      circuitBreaker: { rollback: true },
      healthCheckGracePeriod: Duration.seconds(60),

      // Stop the old task before starting the new one, rather than the default overlap.
      //
      // This is a correctness constraint, not a tuning choice. The runtime holds the table
      // in memory, so two engine tasks running at once would each own a *different* copy of
      // the same table — dealing two different hands under one table id. A few seconds of
      // downtime per deploy is the correct trade until Redis-backed table ownership exists.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
    });

    // Agents hold a socket open for a whole session, and a hand can sit idle waiting on the
    // action clock. The default 60s idle timeout would silently cut them mid-hand.
    engine.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '3600');

    engine.targetGroup.configureHealthCheck({
      path: '/healthz',
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 5,
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
    });

    // Long enough for in-flight hands to finish and sockets to close cleanly. `tini` makes
    // SIGTERM actually reach Node; this is the window it gets to act on it.
    engine.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '60');

    const worker = new ecs.FargateService(this, 'WalletWorker', {
      cluster,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },

      // Exactly one worker, always — including mid-deploy.
      //
      // Two scanners would be harmless (the ledger refuses to credit a signature twice), but
      // two withdrawal workers would drive the same queue and sign concurrently from one
      // treasury. That is a class of problem worth simply not having, and the cost of
      // avoiding it is a brief pause in deposit scanning during a deploy.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      taskDefinition: (() => {
        const task = new ecs.FargateTaskDefinition(this, 'WalletWorkerTask', {
          cpu: 256,
          memoryLimitMiB: 512,
        });
        task.addContainer('worker', {
          image: ecs.ContainerImage.fromAsset('..', {
            file: 'Dockerfile',
            buildArgs: { SERVICE: 'wallet-worker' },
          }),
          environment: commonEnvironment,
          secrets: {
            DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret!, 'uri'),
            SOLANA_MASTER_MNEMONIC: ecs.Secret.fromSecretsManager(masterSeed),
          },
          logging: ecs.LogDrivers.awsLogs({
            streamPrefix: 'wallet-worker',
            logRetention: logs.RetentionDays.ONE_MONTH,
          }),
        });
        return task;
      })(),
    });

    // Exactly one worker, always. Two would double-scan (harmless — the ledger is idempotent)
    // but would also both drive the withdrawal queue, and concurrent signing from one
    // treasury is a class of problem worth simply not having.
    database.connections.allowDefaultPortFrom(engine.service, 'engine');
    database.connections.allowDefaultPortFrom(worker, 'wallet worker');

    // -----------------------------------------------------------------------
    // Spectator app
    // -----------------------------------------------------------------------

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const distribution = new cloudfront.Distribution(this, 'Site', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      defaultRootObject: 'index.html',
      // The SPA uses hash routing precisely so this is all that is needed — no rewrite
      // rules, no Lambda@Edge. A deep link to a hand replay resolves to index.html and the
      // fragment does the rest.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html' },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html' },
      ],
    });

    // -----------------------------------------------------------------------
    // Outputs
    // -----------------------------------------------------------------------

    new CfnOutput(this, 'EngineUrl', {
      value: `http://${engine.loadBalancer.loadBalancerDnsName}`,
      description: 'Agent WebSocket and public read API',
    });
    new CfnOutput(this, 'SiteUrl', {
      value: `https://${distribution.distributionDomainName}`,
      description: 'Spectator app',
    });
    new CfnOutput(this, 'SiteBucketName', {
      value: siteBucket.bucketName,
      description: 'Sync the built SPA here',
    });
    new CfnOutput(this, 'MasterSeedSecretArn', {
      value: masterSeedResource.ref,
      description: 'Populate out of band — never through CDK',
    });
    new CfnOutput(this, 'DatabaseEndpoint', {
      value: database.dbInstanceEndpointAddress,
      description: 'Reachable only from inside the VPC',
    });
  }
}
