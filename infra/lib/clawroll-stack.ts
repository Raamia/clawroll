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

    // The house bots' API keys, empty until they have been registered.
    //
    // Empty on purpose and fetched at runtime, not injected: the bots cannot exist before the
    // room they play in is deployed, so a secret ECS had to resolve at container start would
    // make the first deploy impossible. Same shape as the master seed, same way out.
    const botKeysResource = new secretsmanager.CfnSecret(this, 'BotKeys', {
      description: 'House bot API keys as "tableId:apiKey,…" — populate after registering them',
      kmsKeyId: key.keyArn,
    });
    botKeysResource.applyRemovalPolicy(RemovalPolicy.RETAIN);
    const botKeys = secretsmanager.Secret.fromSecretCompleteArn(
      this,
      'BotKeysRef',
      botKeysResource.ref,
    );

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

    // Tasks per service. `-c desiredCount=0` deploys the stack with both services scaled to
    // zero, which exists for one reason: an ECS deployment circuit breaker rolls the whole
    // stack back when a task will not start, and the rollback deletes the cluster and the log
    // groups along with it — destroying the only evidence of why. Deploying at zero, then
    // launching a single task by hand, keeps the failure readable.
    //
    // Defaults to 1, so this is a diagnostic escape hatch and not a mode anyone lands in by
    // accident.
    // Applies to the wallet worker only. `ApplicationLoadBalancedFargateService` rejects a
    // desiredCount of 0 outright — and the engine is not the service that has been failing:
    // it has only ever been reported "cancelled", which is CloudFormation abandoning it
    // because the worker failed first, not a failure of its own.
    const workerDesiredCount = Number(this.node.tryGetContext('desiredCount') ?? 1);

    // The five fields an RDS-generated secret actually contains, injected individually.
    //
    // There is no `uri` key in an RDS secret — it holds `username`, `password`, `host`,
    // `port` and `dbname`. Asking ECS for `uri` is not a silent no-op: the agent fails with
    // `ResourceInitializationError: retrieved secret from Secrets Manager did not contain
    // json key uri` *before* starting the container, so nothing reaches the application log
    // and the service simply never starts. Three deploys died on this, and with no logs at
    // all the cause looked like anything but a wrong field name.
    //
    // `@clawroll/db` joins them back into a URL, percent-encoding the password, which is the
    // one part that can legitimately contain characters a URL treats as structure.
    const databaseSecrets = {
      DB_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
      DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
      DB_HOST: ecs.Secret.fromSecretsManager(database.secret!, 'host'),
      DB_PORT: ecs.Secret.fromSecretsManager(database.secret!, 'port'),
      DB_NAME: ecs.Secret.fromSecretsManager(database.secret!, 'dbname'),
    };

    const commonEnvironment = {
      NODE_ENV: 'production',
      SOLANA_RPC_URL: props.solanaRpcUrl ?? 'https://api.devnet.solana.com',
    };

    const engine = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Engine', {
      cluster,
      cpu: 512,
      memoryLimitMiB: 1024,
      // ARM64, matching the machine the image is built on.
      //
      // Fargate defaults to X86_64. An image built on an Apple Silicon Mac is arm64, and the
      // mismatch does not fail at push or at pull — it fails at exec, with
      // `exec /sbin/tini: exec format error` and nothing else, because the entrypoint binary
      // itself cannot run. The container "starts" and dies instantly, the circuit breaker
      // trips, and the stack rolls back. It is invisible locally, where the image runs on the
      // architecture it was built for.
      //
      // Pinning ARM64 rather than forcing an amd64 build: Graviton Fargate is cheaper, the
      // database is already `t4g` (also Graviton), and building for the host architecture
      // avoids emulation on every deploy. The cost is that an amd64 CI machine would have to
      // cross-build — worth stating, since the failure it produces names none of this.
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
      // One task. The runtime holds a table in memory, so a second task would own a
      // different copy of the same table. See the note at the top of this file.
      desiredCount: 1,
      publicLoadBalancer: true,
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      taskImageOptions: {
        image,
        containerPort: 8080,
        environment: commonEnvironment,
        secrets: databaseSecrets,
        logDriver: ecs.LogDrivers.awsLogs({
          streamPrefix: 'engine',
          logRetention: logs.RetentionDays.ONE_MONTH,
        }),
      },
      // A rolling deploy that fails should stop and roll back rather than cycle forever.
      circuitBreaker: { rollback: true },
      // Three minutes, not one.
      //
      // The engine runs database migrations before it binds a port, and on a first deploy it
      // is doing that against a brand-new RDS instance. With a 60s grace period and a health
      // check needing two passes 30s apart, the task had to boot, migrate and answer inside
      // the same 60 seconds or ECS would kill it — and the circuit breaker turns that into a
      // rollback of the whole stack, twenty minutes of it. The grace period only delays
      // enforcement at startup, so widening it costs nothing and removes a race that is worst
      // on exactly the deploy where the database is coldest.
      healthCheckGracePeriod: Duration.seconds(180),

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
      // 15s rather than 30s, so two consecutive passes take 30 seconds instead of a minute.
      // `/healthz` deliberately touches nothing — it does not query the table or the database
      // — so checking twice as often costs nothing and halves how long a healthy task spends
      // being treated as unhealthy.
      interval: Duration.seconds(15),
      timeout: Duration.seconds(5),
    });

    // Long enough for in-flight hands to finish and sockets to close cleanly. `tini` makes
    // SIGTERM actually reach Node; this is the window it gets to act on it.
    engine.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '60');

    // The worker's log group is explicit rather than CDK-generated, because the one-off
    // registration task writes here too and `register-agent` has to be able to find its
    // output by name.
    const workerLogs = new logs.LogGroup(this, 'WalletWorkerLogs', {
      retention: logs.RetentionDays.ONE_MONTH,
      // Retained rather than destroyed. A failed deploy rolls back and takes the log group
      // with it, deleting the only explanation of why the task would not start — which is
      // exactly when the logs are worth having. A month of retention bounds the cost.
      removalPolicy: RemovalPolicy.RETAIN,
    });

    const botsLogs = new logs.LogGroup(this, 'BotsLogs', {
      retention: logs.RetentionDays.ONE_WEEK,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const workerTask = new ecs.FargateTaskDefinition(this, 'WalletWorkerTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      // Same architecture as the engine, for the same reason — see above.
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    workerTask.addContainer('worker', {
      image: ecs.ContainerImage.fromAsset('..', {
        file: 'Dockerfile',
        buildArgs: { SERVICE: 'wallet-worker' },
      }),
      // The seed's *ARN*, not the seed. The worker fetches the value itself at startup.
      //
      // Injecting it here is the obvious thing and it makes the stack undeployable. ECS
      // resolves secrets before starting the container, and this secret is created
      // deliberately empty — its ARN does not exist until this deploy finishes. So on a
      // first deploy the task could never launch, the service's circuit breaker tripped,
      // and CloudFormation rolled the whole stack back. The deploy needed the secret and
      // the secret needed the deploy.
      //
      // Passing the ARN turns "not set yet" into a state the worker can wait in rather than
      // a failure to launch, so the deploy completes and the operator populates the secret
      // afterwards with no redeploy.
      environment: {
        ...commonEnvironment,
        MASTER_SEED_SECRET_ARN: masterSeedResource.ref,
        // Keeps the house bots in the game.
        //
        // With no rake the chips are conserved, but they still concentrate: variance ends in
        // gambler's ruin, and unequal strategies drift there faster. Without this the tables
        // eventually go quiet, and the first anyone knows is opening the site and finding
        // nobody playing.
        //
        // Chips are moved between house bots, never granted — see `rebalance.ts` for why
        // that distinction is not cosmetic. A floor of zero switches it off.
        REBALANCE_FLOOR_MICROS: String(2_000_000),
        REBALANCE_TARGET_MICROS: String(8_000_000),
      },
      secrets: databaseSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'wallet-worker', logGroup: workerLogs }),
    });

    const worker = new ecs.FargateService(this, 'WalletWorker', {
      cluster,
      desiredCount: workerDesiredCount,
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
      taskDefinition: workerTask,
    });

    // Exactly one worker, always. Two would double-scan (harmless — the ledger is idempotent)
    // but would also both drive the withdrawal queue, and concurrent signing from one
    // treasury is a class of problem worth simply not having.
    // The worker reads the master seed at runtime rather than having ECS inject it, so the
    // task role needs read access to the secret and to the key it is encrypted under.
    masterSeed.grantRead(workerTask.taskRole);
    key.grantDecrypt(workerTask.taskRole);


    database.connections.allowDefaultPortFrom(engine.service, 'engine');
    database.connections.allowDefaultPortFrom(worker, 'wallet worker');

    // -----------------------------------------------------------------------
    // House bots
    // -----------------------------------------------------------------------

    /**
     * The bots that keep the tables busy.
     *
     * A separate service from the engine, deliberately. The engine is the dealer and has to
     * stay impartial; if the same process decided how the players bet, "the house runs the
     * bots" would stop describing who pays for the compute and start being a reason to
     * distrust every hand. On the far side of the same public WebSocket a stranger uses, they
     * know exactly what a stranger's bot knows.
     *
     * It also means the fleet can be restarted or switched off without touching a dealer that
     * is holding live hands.
     */
    const botsTask = new ecs.FargateTaskDefinition(this, 'BotsTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    botsTask.addContainer('bots', {
      image: ecs.ContainerImage.fromAsset('..', {
        file: 'Dockerfile',
        buildArgs: { SERVICE: 'bots' },
      }),
      environment: {
        NODE_ENV: 'production',
        // Straight to the load balancer. These bots are inside the VPC, so routing them out
        // through CloudFront and back would add latency and cost for no benefit — the TLS
        // that matters is for agents crossing the public internet.
        CLAWROLL_URL: `ws://${engine.loadBalancer.loadBalancerDnsName}`,
        BOT_KEYS_SECRET_ARN: botKeysResource.ref,
      },
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'bots', logGroup: botsLogs }),
    });
    botKeys.grantRead(botsTask.taskRole);
    key.grantDecrypt(botsTask.taskRole);

    const bots = new ecs.FargateService(this, 'Bots', {
      cluster,
      desiredCount: 1,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      // One fleet. Two would seat every bot twice, and the second copy of an agent replaces
      // the first's socket — they would fight over the same seats indefinitely.
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      taskDefinition: botsTask,
    });
    // Silences an unused-variable complaint while keeping the handle for future wiring.
    void bots;

    // -----------------------------------------------------------------------
    // Spectator app
    // -----------------------------------------------------------------------

    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // The engine, reachable through the same distribution as the site.
    //
    // Without this the deployed spectator app cannot talk to the engine at all, and it fails
    // in two ways at once. The page is served over HTTPS from CloudFront, so a browser
    // refuses the `ws://` socket as mixed content — and the app's `/api` calls are relative,
    // so they land on CloudFront, which only knows about the S3 bucket, and 404.
    //
    // Routing both through CloudFront fixes both and needs no domain and no certificate on
    // the load balancer: the viewer gets `https` and `wss` terminated at the edge, and
    // CloudFront speaks plain HTTP to the ALB inside AWS. A real certificate on the ALB is
    // still worth having — the *agent* WebSocket connects to it directly and is still
    // unencrypted — but that needs a domain, and this does not.
    const engineOrigin = new origins.LoadBalancerV2Origin(engine.loadBalancer, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      // Agents and spectators hold a socket open for a whole session.
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
    });

    const engineBehavior: cloudfront.BehaviorOptions = {
      origin: engineOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      // A cached API response on a live poker table would be worse than useless.
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      // Forwards the `Upgrade` and `Connection` headers the WebSocket handshake needs, along
      // with query strings. Without it the handshake is stripped at the edge and the socket
      // silently degrades to a plain request that never upgrades.
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
    };

    const distribution = new cloudfront.Distribution(this, 'Site', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      },
      additionalBehaviors: {
        '/api/*': engineBehavior,
        '/spectate': engineBehavior,
        '/healthz': engineBehavior,
        // Agents too, so they get a `wss://` endpoint with TLS terminated at the edge.
        //
        // Connecting straight to the load balancer means `ws://` — and the API key travels
        // in the query string, so it crosses the public internet in the clear on every
        // connect. Devnet play money makes that survivable rather than acceptable. Routing
        // it here does not remove the plaintext hop from CloudFront to the ALB, which stays
        // inside AWS, but it does mean the key is never exposed outside it.
        '/agent': engineBehavior,
      },
      defaultRootObject: 'index.html',
      // No error-response rewrites, deliberately.
      //
      // They used to map 403 and 404 to index.html as SPA-routing insurance. That was
      // harmless while CloudFront only fronted S3 and is actively wrong now that the API is
      // behind the same distribution: CloudFront applies custom error responses across
      // *every* behaviour, so `GET /api/agents/nobody` would answer 200 with a page of HTML
      // instead of the 404 the endpoint deliberately returns. A client cannot distinguish
      // "no such agent" from "here is the homepage" — and the agent profile page depends on
      // exactly that distinction.
      //
      // They were never needed anyway: the SPA uses hash routing, so a deep link to a hand
      // replay requests `/` and lets the fragment do the rest. There is no path for S3 to
      // miss.
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

    // Everything `register-agent` needs to run the registration CLI as a one-off task.
    //
    // Registering an agent writes to Postgres and derives from the master seed, and the
    // database deliberately sits in isolated subnets with no public access — so it cannot be
    // done from a laptop, and without these outputs it could not be done at all. Running the
    // existing worker task definition with an overridden command keeps registration inside
    // the VPC without a bastion, a public database, or a second copy of the seed.
    new CfnOutput(this, 'BotKeysSecretArn', {
      value: botKeysResource.ref,
      description: 'Put "tableId:apiKey,…" here after registering the house bots',
    });
    new CfnOutput(this, 'ClusterName', {
      value: cluster.clusterName,
      description: 'For running one-off tasks',
    });
    new CfnOutput(this, 'WalletWorkerTaskArn', {
      value: workerTask.taskDefinitionArn,
      description: 'Task definition used for one-off registration',
    });
    new CfnOutput(this, 'WalletWorkerLogGroup', {
      value: workerLogs.logGroupName,
      description: 'Where one-off task output lands',
    });
    new CfnOutput(this, 'TaskSubnetIds', {
      value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
      description: 'Private subnets with egress, for one-off tasks',
    });
    new CfnOutput(this, 'WorkerSecurityGroupId', {
      value: worker.connections.securityGroups[0]!.securityGroupId,
      description: 'Security group permitted to reach the database',
    });
  }
}
