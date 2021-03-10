/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

/* istanbul ignore file */

import * as path from 'path';

import {
  OperatingSystemType,
  Port,
} from '@aws-cdk/aws-ec2';
import * as fsx from '@aws-cdk/aws-fsx';
import {
  Asset,
} from '@aws-cdk/aws-s3-assets';
import {
  Construct,
  Stack,
} from '@aws-cdk/core';

import {
  MountPermissionsHelper,
} from './mount-permissions-helper';
import {
  IMountableLinuxFilesystem,
  IMountingInstance,
  LinuxMountPointProps,
} from './mountable-filesystem';

/**
 * Enumeration of the different linux distributions supported by FSx for Lustre.
 * @see https://docs.aws.amazon.com/fsx/latest/LustreGuide/install-lustre-client.html
 */
export enum LinuxDistribution {
  /** Amazon Linux */
  AMAZON_LINUX,
  /** Amazon Linux 2 */
  AMAZON_LINUX_2,
  /** Centos & Red Hat 7.5 */
  CENTOS_AND_REDHAT_7_5,
  /** Centos & Red Hat 7.6 */
  CENTOS_AND_REDHAT_7_6,
  /** Centos & Red Hat 7.7 */
  CENTOS_AND_REDHAT_7_7,
  /** Centos & Red Hat 7.8 on x86_64 instances */
  CENTOS_AND_REDHAT_7_8_X86,
  /** Centos & Red Hat 7.9 on x86_64 instances */
  CENTOS_AND_REDHAT_7_9_X86,
  /** Centos & Red Hat 7.8 on Arm-based AWS Graviton-powered instances */
  CENTOS_AND_REDHAT_7_8_GRAVITON,
  /** Centos & Red Hat 7.9 on Arm-based AWS Graviton-powered instances */
  CENTOS_AND_REDHAT_7_9_GRAVITON,
  /** Centos & Red Hat 8.2 (and newer) */
  CENTOS_AND_REDHAT_8_2,
  /** Ubuntu 16.04 */
  UBUNTU_16_04,
  /** Ubuntu 18.04 */
  UBUNTU_18_04,
  /** Ubuntu 20.04 */
  UBUNTU_20_04,
  /** SUSE Linux 12 SP3 */
  SUSE_LINUX_12_SP3,
  /** SUSE Linux 12 SP4 */
  SUSE_LINUX_12_SP4,
  /** SUSE Linux 12 SP5 */
  SUSE_LINUX_12_SP5,
}

/**
 * Properties that are required to create a {@link MountableFsxLustre}.
 */
export interface MountableFsxLustreProps {
  /**
   * The {@link https://docs.aws.amazon.com/cdk/api/latest/docs/@aws-cdk_aws-fsx.LustreFileSystem.html|FSx}
   * filesystem that will be mounted by the object.
   */
  readonly filesystem: fsx.LustreFileSystem;

  /**
   * The linux distribution this FSx for Lustre file system can be mounted to.
   */
  readonly linuxDistribution: Extract<LinuxDistribution, LinuxDistribution.AMAZON_LINUX_2>;

  /**
   * Extra NFSv4 mount options that will be added to /etc/fstab for the file system.
   * See: {@link https://www.man7.org/linux/man-pages//man5/nfs.5.html}
   *
   * The given values will be joined together into a single string by commas.
   * ex: ['soft', 'rsize=4096'] will become 'soft,rsize=4096'
   *
   * @default No extra options.
   */
  readonly extraMountOptions?: string[];
}

/**
 * This class encapsulates scripting that can be used to mount an Amazon FSx for Lustre File System onto
 * an instance.
 *
 * Security Considerations
 * ------------------------
 * - Using this construct on an instance will result in that instance dynamically downloading and running scripts
 *   from your CDK bootstrap bucket when that instance is launched. You must limit write access to your CDK bootstrap
 *   bucket to prevent an attacker from modifying the actions performed by these scripts. We strongly recommend that
 *   you either enable Amazon S3 server access logging on your CDK bootstrap bucket, or enable AWS CloudTrail on your
 *   account to assist in post-incident analysis of compromised production environments.
 */
export class MountableFsxLustre implements IMountableLinuxFilesystem {
  constructor(protected readonly scope: Construct, protected readonly props: MountableFsxLustreProps) {}

  /**
   * The linux distribution this FSx for Lustre file system can be mounted to.
   */
  public get linuxDistribution(): LinuxDistribution {
    return this.props.linuxDistribution;
  }

  /**
   * @inheritdoc
   */
  public mountToLinuxInstance(target: IMountingInstance, mount: LinuxMountPointProps): void {
    if (target.osType !== OperatingSystemType.LINUX) {
      throw new Error('Target instance must be Linux.');
    }

    target.connections.allowTo(this.props.filesystem, this.props.filesystem.connections.defaultPort as Port);

    const mountScriptAsset = this.mountAssetSingleton();
    mountScriptAsset.grantRead(target.grantPrincipal);
    const mountScript: string = target.userData.addS3DownloadCommand({
      bucket: mountScriptAsset.bucket,
      bucketKey: mountScriptAsset.s3ObjectKey,
    });

    const mountDir: string = path.posix.normalize(mount.location);
    const mountOptions: string[] = [ MountPermissionsHelper.toLinuxMountOption(mount.permissions) ];
    if (this.props.extraMountOptions) {
      mountOptions.push( ...this.props.extraMountOptions);
    }
    const mountOptionsStr: string = mountOptions.join(',');

    target.userData.addCommands(
      ...this.getLustreClientInstallationCommands(),
      'TMPDIR=$(mktemp -d)',
      'pushd "$TMPDIR"',
      `unzip ${mountScript}`,
      `bash ./mountFsxLustre.sh ${this.props.filesystem.fileSystemId} ${mountDir} ${this.props.filesystem.mountName} ${mountOptionsStr}`,
      'popd',
      `rm -f ${mountScript}`,
    );
  }

  /**
   * Fetch the Asset singleton for the FSx for Lustre mounting scripts, or generate it if needed.
   */
  protected mountAssetSingleton(): Asset {
    const stack = Stack.of(this.scope);
    const uuid = '0db888da-5901-4948-aaa5-e71c541c8060';
    const uniqueId = 'MountableFsxLustreAsset' + uuid.replace(/[-]/g, '');
    return (stack.node.tryFindChild(uniqueId) as Asset) ?? new Asset(stack, uniqueId, {
      path: path.join(__dirname, '..', 'scripts', 'bash'),
      exclude: [ '**/*', '!mountFsxLustre.sh', '!metadataUtilities.sh', '!ec2-certificates.crt' ],
    });
  }

  /**
   * Gets the bash commands to install the Lustre client on the current linux distribution.
   * @see https://docs.aws.amazon.com/fsx/latest/LustreGuide/install-lustre-client.html
   * @returns Bash commands to install the Lustre client.
   */
  private getLustreClientInstallationCommands(): string[] {
    function createIsKernelVersionLowerFunc(): string {
      return [
        'function is_kernel_version_lower() {',
        '  local IFS=$3',
        '  read -r -a lhs_array <<< "$1"',
        '  read -r -a rhs_array <<< "$2"',
        '  if [ ${#lhs_array[@]} -ne ${#rhs_array[@]} ]; then',
        '    echo "ERROR: Kernel version lengths do not match: $1 $2"',
        '    exit 1',
        '  fi',
        '  for i in ${!lhs_array[@]}; do',
        '    local lhs="${lhs_array[$i]}"',
        '    local rhs="${rhs_array[$i]}"',
        '    if [[ $lhs =~ ^[0-9]+$ && $rhs =~ ^[0-9]+$ && $lhs -lt $rhs ]]; then',
        '      return 0',
        '    fi',
        '  done',
        '  return 1',
        '}',
      ].join('\n');
    }

    switch (this.linuxDistribution) {
      // https://docs.aws.amazon.com/fsx/latest/LustreGuide/install-lustre-client.html#lustre-client-amazon-linux
      case LinuxDistribution.AMAZON_LINUX_2:
        const al2X86KernelPattern =      '^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]+\\.[0-9]+\\.amzn2\\.x86_64$';
        const al2GravitonKernelPattern = '^[0-9]+\\.[0-9]+\\.[0-9]+-[0-9]+\\.[0-9]+\\.amzn2\\.aarch64$';
        return [
          createIsKernelVersionLowerFunc(),
          'set -x',
          'KERNEL_VERSION=$(uname -r)',
          `if [[ "$KERNEL_VERSION" =~ ${al2X86KernelPattern} ]]; then`,
          '  MIN_VER="4.14.104-95.84.amzn2.x86_64"',
          `elif [[ "$KERNEL_VERSION" =~ ${al2GravitonKernelPattern} ]]; then`,
          '  MIN_VER="4.14.181-142.260.amzn2.aarch64"',
          'else',
          '  echo "Not on Amazon Linux 2. Exiting..."; exit 1',
          'fi',
          'if is_kernel_version_lower $KERNEL_VERSION $MIN_VER ".-"; then',
          '  sudo yum -y update kernel && sudo reboot',
          'fi',
          'sudo amazon-linux-extras install -y lustre2.10',
        ];

      case LinuxDistribution.AMAZON_LINUX:
        // TODO
      case LinuxDistribution.CENTOS_AND_REDHAT_7_5:
      case LinuxDistribution.CENTOS_AND_REDHAT_7_6:
        // TODO
      case LinuxDistribution.CENTOS_AND_REDHAT_7_7:
      case LinuxDistribution.CENTOS_AND_REDHAT_7_8_X86:
      case LinuxDistribution.CENTOS_AND_REDHAT_7_9_X86:
        // TODO
      case LinuxDistribution.CENTOS_AND_REDHAT_7_8_GRAVITON:
      case LinuxDistribution.CENTOS_AND_REDHAT_7_9_GRAVITON:
        // TODO
      case LinuxDistribution.CENTOS_AND_REDHAT_8_2:
        // TODO
      case LinuxDistribution.UBUNTU_16_04:
        // TODO
      case LinuxDistribution.UBUNTU_18_04:
        // TODO
      case LinuxDistribution.UBUNTU_20_04:
        // TODO
      case LinuxDistribution.SUSE_LINUX_12_SP3:
        // TODO
      case LinuxDistribution.SUSE_LINUX_12_SP4:
        // TODO
      case LinuxDistribution.SUSE_LINUX_12_SP5:
        // TODO
      default:
        throw new Error(`Linux distribution ${this.linuxDistribution} is not currently not supported`);
    }
  }
}
