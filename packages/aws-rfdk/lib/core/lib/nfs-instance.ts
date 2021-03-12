/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'path';
import {
  BlockDeviceVolume,
} from '@aws-cdk/aws-autoscaling';
import {
  AmazonLinuxGeneration,
  Connections,
  IConnectable,
  InstanceClass,
  InstanceSize,
  InstanceType,
  ISecurityGroup,
  IVolume,
  IVpc,
  MachineImage,
  Port,
  SubnetSelection,
  UserData,
  Volume,
} from '@aws-cdk/aws-ec2';
import {
  IGrantable,
  IPrincipal,
  IRole,
} from '@aws-cdk/aws-iam';
import {
  IKey,
} from '@aws-cdk/aws-kms';
import {
  ARecord,
  IPrivateHostedZone,
  RecordTarget,
} from '@aws-cdk/aws-route53';
import {
  Asset,
} from '@aws-cdk/aws-s3-assets';
import {
  Construct,
  Duration,
  IConstruct,
  Size,
} from '@aws-cdk/core';
import {
  BlockVolumeFormat,
  CloudWatchAgent,
  CloudWatchConfigBuilder,
  IScriptHost,
  LogGroupFactory,
  LogGroupFactoryProps,
  MountableBlockVolume,
  StaticPrivateIpServer,
} from './';
import {
  LinuxMountPointProps,
} from './mountable-filesystem';
import {
  tagConstruct,
} from './runtime-info';

/**
 * Information about the NFS export for a client.
 */
export interface NfsExport {
  /**
   * The machine name to export to. For possible values, see {@link https://linux.die.net/man/5/exports|Machine Name Formats}.
   * @see https://linux.die.net/man/5/exports
   */
  readonly client: string;
  /**
   * The NFS export options applied.
   * @see https://linux.die.net/man/5/exports
   */
  readonly nfsOptions: string[];
}

/**
* Specification for a when a new volume is being created by an NfsInstance.
*/
export interface NfsInstanceNewVolumeProps {
  /**
  * The size, in Gigabytes, of a new encrypted volume to be created to hold the NFS file-system
  * A new volume is created only if a value for the volume property is not provided.
  *
  * @default 20 GiB
  */
  readonly size?: Size;

  /**
  * If creating a new EBS Volume, then this property provides a KMS key to use to encrypt
  * the Volume's data. If you do not provide a value for this property, then your default
  * service-owned KMS key will be used to encrypt the new Volume.
  *
  * @default Your service-owned KMS key is used to encrypt a new volume.
  */
  readonly encryptionKey?: IKey;

  /**
  * The type of file-system to build on the volume.
  *
  * @default XFS
  */
  readonly fileSystemType?: BlockVolumeFormat;
}

/**
* Specification of the Amazon Elastic Block Storage (EBS) Volume that will be used by
* a {@link NfsInstance} for the file-system.
*
* You must provide either an existing EBS Volume to mount to the instance, or the
* {@link NfsInstance} will create a new EBS Volume of the given size that is
* encrypted. The encryption will be with the given KMS key, if one is provided.
*/
export interface NfsInstanceVolumeProps {
  /**
  * An existing EBS volume. This volume is mounted to the {@link NfsInstance} using
  * the scripting in {@link MountableEbs}, and is subject to the restrictions outlined
  * in that class. The Volume must not be partitioned.
  *
  * @default A new encrypted volume is created for use by the instance.
  */
  readonly volume?: IVolume;

  /**
  * Properties for a new volume that will be constructed for use by this instance.
  *
  * @default A service-key encrypted 20Gb volume will be created.
  */
  readonly volumeProps?: NfsInstanceNewVolumeProps;
}

/**
* Properties for a newly created {@link NfsInstance}.
*/
export interface NfsInstanceProps {
  /**
  * Private DNS zone to register the instance hostname within. An A Record will automatically be created
  * within this DNS zone for the provided hostname to allow connection to instance's static private IP.
  */
  readonly dnsZone: IPrivateHostedZone;

  /**
   * The hostname to register the instance's listening interface as. The hostname must be
   * from 1 to 63 characters long and may contain only the letters from a-z, digits from 0-9,
   * and the hyphen character.
   *
   * The fully qualified domain name (FQDN) of this host will be this hostname dot the zoneName
   * of the given dnsZone.
   */
  readonly hostname: string;

  /**
   * Properties for mounting the volume onto the instance.
   */
  readonly mount: LinuxMountPointProps;

  /**
   * Specification of the Amazon Elastic Block Storage (EBS) Volume that will be used by
   * the instance to store the file-system. The Volume must not be partitioned.
   *
   * @default A new 20 GiB encrypted EBS volume is created
   */
  readonly volume?: NfsInstanceVolumeProps;

  /**
  * The VPC in which to create the NfsInstance.
  */
  readonly vpc: IVpc;

  /**
  * Where to place the instance within the VPC.
  *
  * @default The instance is placed within a Private subnet.
  */
  readonly vpcSubnets?: SubnetSelection;

  /**
  * The type of instance to launch. Note that this must be an x86-64 instance type.
  *
  * @default m5.xlarge
  */
  readonly instanceType?: InstanceType;

  /**
  * Name of the EC2 SSH keypair to grant access to the instance.
  *
  * @default No SSH access will be possible.
  */
  readonly keyName?: string;

  /**
  * Properties for setting up the NFS Instance's LogGroup in CloudWatch
  *
  * @default - LogGroup will be created with all properties' default values to the LogGroup: /renderfarm/<construct id>
  */
  readonly logGroupProps?: LogGroupFactoryProps;

  /**
  * An IAM role to associate with the instance profile that is assigned to this instance.
  * The role must be assumable by the service principal `ec2.amazonaws.com`
  *
  * @default A role will automatically be created, it can be accessed via the `role` property.
  */
  readonly role?: IRole;

  /**
  * The security group to assign to this instance.
  *
  * @default A new security group is created for this instance.
  */
  readonly securityGroup?: ISecurityGroup;
}

/**
* Essential properties of an NFS instance.
*/
export interface INfsInstance extends IConnectable, IConstruct {
  /**
  * The full host name that can be used to connect to the file-system running on this
  * instance.
  */
  readonly fullHostname: string;

  /**
  * The port to connect to.
  */
  readonly port: number;

  /**
   * The exports of this NFS instance.
   */
  readonly exports: NfsExport[];

  /**
  * Adds security groups to the server.
  * @param securityGroups The security groups to add.
  */
  addSecurityGroup(...securityGroups: ISecurityGroup[]): void;
}

/**
* This construct provides a {@link StaticPrivateIpServer} that is hosting a Network File System (NFS). The data for this file-system
* is stored in an Amazon Elastic Block Storage (EBS) Volume that is automatically attached to the instance when it is
* launched, and is separate from the instance's root volume; it is recommended that you set up a backup schedule for
* this volume.
*
* When this instance is first launched, or relaunched after an instance replacement, it will:
* 1. Attach an EBS volume to the instance at the specified mount point;
* 2. Automatically install the specified file-system type on the volume;
*
* The instance's launch logs will be automatically stored in Amazon CloudWatch logs; the
* default log group name is: /renderfarm/<this construct ID>
*
* Resources Deployed
* ------------------------
* - {@link StaticPrivateIpServer} that hosts the NFS.
* - An A-Record in the provided PrivateHostedZone to create a DNS entry for this server's static private IP.
* - An encrypted Amazon Elastic Block Store (EBS) Volume for the file-system.
* - Amazon CloudWatch log group that contains instance-launch logs.
*
* Security Considerations
* ------------------------
* - The instances deployed by this construct download and run scripts from your CDK bootstrap bucket when that instance
*   is launched. You must limit write access to your CDK bootstrap bucket to prevent an attacker from modifying the actions
*   performed by these scripts. We strongly recommend that you either enable Amazon S3 server access logging on your CDK
*   bootstrap bucket, or enable AWS CloudTrail on your account to assist in post-incident analysis of compromised production
*   environments.
* - The EBS Volume that is created by, or provided to, this construct is used to store your file-system. To
*   protect the sensitive data in your file-system, you should not grant access to this EBS Volume to any principal or instance
*   other than the instance created by this construct. Furthermore, we recommend that you ensure that the volume that is
*   used for this purpose is encrypted at rest.
* - This construct uses this package's {@link StaticPrivateIpServer}, {@link CloudWatchAgent},
*   {@link ExportingLogGroup}, and {@link MountableBlockVolume}. Security considerations that are outlined by the documentation
*   for those constructs should also be taken into account.
*/
export class NfsInstance extends Construct implements INfsInstance, IGrantable {
  // How often Cloudwatch logs will be flushed.
  private static CLOUDWATCH_LOG_FLUSH_INTERVAL: Duration = Duration.seconds(15);
  // Default prefix for a LogGroup if one isn't provided in the props.
  private static DEFAULT_LOG_GROUP_PREFIX: string = '/renderfarm/';
  // Size of the EBS volume, if we create one.
  private static DEFAULT_DEVICE_SIZE = Size.gibibytes(20);
  // Size of the root device volume on the instance.
  private static ROOT_DEVICE_SIZE = Size.gibibytes(10);

  /**
  * Allows for providing security group connections to/from this instance.
  */
  public readonly connections: Connections;

  /**
  * The principal to grant permission to. Granting permissions to this principal will grant
  * those permissions to the instance role.
  */
  public readonly grantPrincipal: IPrincipal;

  /**
  * @inheritdoc
  */
  public readonly fullHostname: string;

  /**
  * The server that this construct creates to host the NFS filesystem.
  */
  public readonly server: StaticPrivateIpServer;

  /**
  * The EBS Volume on which we are storing the file-system.
  */
  public readonly volume: IVolume;

  /**
  * The port to connect to.
  */
  public readonly port: number;

  /**
  * The IAM role that is assumed by the instance.
  */
  public readonly role: IRole;

  /**
  * The UserData for this instance.
  * UserData is a script that is run automatically by the instance the very first time that a new instance is started.
  */
  public readonly userData: UserData;

  /**
   * Mount point of the EBS volume.
   */
  public readonly mount: LinuxMountPointProps;

  /**
   * @inheritdoc
   */
  public readonly exports: NfsExport[];

  /**
   * Path on the server instance for the downloaded `exportNfsDirectory.sh` script.
   */
  private readonly exportNfsDirectoryScriptPath: string;

  constructor(scope: Construct, id: string, props: NfsInstanceProps) {
    super(scope, id);

    this.mount = props.mount;
    this.exports = [];

    // Select the subnet for this instance.
    const { subnets } = props.vpc.selectSubnets(props.vpcSubnets);
    if (subnets.length === 0) {
      throw new Error(`Did not find any subnets matching ${JSON.stringify(props.vpcSubnets)}. Please use a different selection.`);
    }
    const subnet = subnets[0];

    this.server = new StaticPrivateIpServer(this, 'Server', {
      vpc: props.vpc,
      vpcSubnets: { subnets: [ subnet ] },
      instanceType: props.instanceType ?? InstanceType.of(InstanceClass.M5, InstanceSize.XLARGE),
      machineImage: MachineImage.latestAmazonLinux({ generation: AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      blockDevices: [
        {
          deviceName: '/dev/xvda', // Root volume
          volume: BlockDeviceVolume.ebs(NfsInstance.ROOT_DEVICE_SIZE.toGibibytes(), { encrypted: true }),
        },
      ],
      keyName: props.keyName,
      resourceSignalTimeout: Duration.minutes(5),
      role: props.role,
      securityGroup: props.securityGroup,
    });

    new ARecord(this, 'ARecord', {
      target: RecordTarget.fromIpAddresses(this.server.privateIpAddress),
      zone: props.dnsZone,
      recordName: props.hostname,
    });

    this.volume = props.volume?.volume ?? new Volume(this, 'Volume', {
      size: NfsInstance.DEFAULT_DEVICE_SIZE, // First so it can be overriden by the next entry
      ...props.volume?.volumeProps,
      availabilityZone: subnet.availabilityZone,
      encrypted: true,
    });
    let volumeFormat = BlockVolumeFormat.XFS;
    if (props.volume?.volume === undefined && props.volume?.volumeProps?.fileSystemType) {
      volumeFormat = props.volume.volumeProps.fileSystemType;
    }
    const volumeMount = new MountableBlockVolume(this, {
      blockVolume: this.volume,
      volumeFormat,
    });

    // Set up the server's UserData.
    this.server.userData.addCommands('set -xefuo pipefail');
    this.server.userData.addSignalOnExitCommand(this.server.autoscalingGroup);
    this.configureCloudWatchLogStreams(this.server, id, props.logGroupProps); // MUST BE FIRST
    volumeMount.mountToLinuxInstance(this.server, props.mount);
    this.configureNfsServer();
    const exportNfsDirectoryAsset = new Asset(this, 'ExportNfsDirectoryAsset', {
      path: path.join(__dirname, '..', 'scripts', 'bash', 'exportNfsDirectory.sh'),
    });
    this.exportNfsDirectoryScriptPath = this.server.userData.addS3DownloadCommand({
      bucket: exportNfsDirectoryAsset.bucket,
      bucketKey: exportNfsDirectoryAsset.s3ObjectKey,
    });

    this.port = 2049;
    this.connections = new Connections({
      defaultPort: Port.tcp(this.port),
      securityGroups: this.server.connections.securityGroups,
    });
    this.grantPrincipal = this.server.grantPrincipal;
    this.role = this.server.role;
    this.userData = this.server.userData;
    this.fullHostname = `${props.hostname}.${props.dnsZone.zoneName}`;

    this.node.defaultChild = this.server;

    // Tag deployed resources with RFDK meta-data
    tagConstruct(this);
  }

  /**
   * Shares the root of the EBS volume mounted to this NFS server with the client.
   * @param client The machine name to export to. For possible values, see {@link https://linux.die.net/man/5/exports|Machine Name Formats}.
   * @param nfsOptions NFS export options. Default is `[rw,sync,no_subtree_check,insecure]`. See {@link https://linux.die.net/man/5/exports|General Options}.
   */
  public share(client: string, nfsOptions: string[] = ['rw', 'sync', 'no_subtree_check', 'insecure']) {
    this.exports.push({
      client,
      nfsOptions,
    });

    this.server.userData.addExecuteFileCommand({
      filePath: this.exportNfsDirectoryScriptPath,
      arguments: `"${this.mount.location}" "${client}" "${nfsOptions}"`,
    });
  }

  /**
  * @inheritdoc
  */
  public addSecurityGroup(...securityGroups: ISecurityGroup[]): void {
    securityGroups?.forEach(securityGroup => this.server.autoscalingGroup.addSecurityGroup(securityGroup));
  }

  /**
  * Adds UserData commands to install & configure the CloudWatch Agent onto the instance.
  *
  * The commands configure the agent to stream the cloud-init logs to a new CloudWatch log group
  *
  * @param host The instance/host to setup the CloudWatchAgent upon.
  * @param groupName Name to append to the log group prefix when forming the log group name.
  * @param logGroupProps Properties for the log group
  */
  protected configureCloudWatchLogStreams(host: IScriptHost, groupName: string, logGroupProps?: LogGroupFactoryProps) {
    const prefix = logGroupProps?.logGroupPrefix ?? NfsInstance.DEFAULT_LOG_GROUP_PREFIX;
    const defaultedLogGroupProps = {
      ...logGroupProps,
      logGroupPrefix: prefix,
    };
    const logGroup = LogGroupFactory.createOrFetch(this, 'NfsInstanceLogGroupWrapper', groupName, defaultedLogGroupProps);

    logGroup.grantWrite(host.grantPrincipal);

    const cloudWatchConfigurationBuilder = new CloudWatchConfigBuilder(NfsInstance.CLOUDWATCH_LOG_FLUSH_INTERVAL);

    cloudWatchConfigurationBuilder.addLogsCollectList(logGroup.logGroupName,
      'cloud-init-output',
      '/var/log/cloud-init-output.log');

    new CloudWatchAgent(this, 'NfsInstanceLogsConfig', {
      cloudWatchConfig: cloudWatchConfigurationBuilder.generateCloudWatchConfiguration(),
      host,
    });
  }

  /**
   * Configures the NFS server.
   */
  private configureNfsServer() {
    this.server.userData.addCommands(
      // Setup NFS service
      'sudo yum install -y nfs-utils nfs-utils-lib',
      'sudo service nfs start',
      'sudo chkconfig --level 35 nfs on',
    );
  }
}
