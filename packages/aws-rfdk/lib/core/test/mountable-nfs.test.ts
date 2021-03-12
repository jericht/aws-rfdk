/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  expect as cdkExpect,
  haveResourceLike,
} from '@aws-cdk/assert';
import {
  AmazonLinuxGeneration,
  Instance,
  InstanceType,
  MachineImage,
  SecurityGroup,
  Vpc,
  WindowsVersion,
} from '@aws-cdk/aws-ec2';
import { PrivateHostedZone } from '@aws-cdk/aws-route53';
import {
  Stack,
} from '@aws-cdk/core';

import {
  LinuxMountPointProps,
  MountableNfs,
  MountPermissions,
  NfsInstance,
} from '../lib';

import {
  escapeTokenRegex,
} from './token-regex-helpers';

describe('Test MountableNFS', () => {
  let stack: Stack;
  let vpc: Vpc;
  let dnsZone: PrivateHostedZone;
  let nfsFS: NfsInstance;
  let nfsSecurityGroup: SecurityGroup;
  let instance: Instance;
  let instanceSecurityGroup: SecurityGroup;
  const hostname = 'hostname';
  const zoneName = 'zoneName';
  const mountProps: LinuxMountPointProps = {
    location: '/mnt/nfs',
    permissions: MountPermissions.READWRITE,
  };

  beforeEach(() => {
    stack = new Stack();
    vpc = new Vpc(stack, 'Vpc');
    dnsZone = new PrivateHostedZone(stack, 'DnsZone', {
      vpc,
      zoneName,
    });
    nfsSecurityGroup = new SecurityGroup(stack, 'NFSSecurityGroup', { vpc });
    nfsFS = new NfsInstance(stack, 'NFS', {
      vpc,
      dnsZone,
      hostname,
      mount: mountProps,
      securityGroup: nfsSecurityGroup,
    });
    instanceSecurityGroup = new SecurityGroup(stack, 'InstanceSecurityGroup', { vpc });
    instance = new Instance(stack, 'Instance', {
      vpc,
      instanceType: new InstanceType('t3.small'),
      machineImage: MachineImage.latestAmazonLinux({ generation: AmazonLinuxGeneration.AMAZON_LINUX_2 }),
      securityGroup: instanceSecurityGroup,
    });
  });

  test('defaults', () => {
    // GIVEN
    const mount = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
    });
    const location = '/mnt/nfs/fs1';

    // WHEN
    mount.mountToLinuxInstance(instance, {
      location,
    });
    const userData = instance.userData.render();
    // THEN

    // Make sure the instance has been granted ingress to the NFS server's security group
    cdkExpect(stack).to(haveResourceLike('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 2049,
      ToPort: 2049,
      SourceSecurityGroupId: stack.resolve(instanceSecurityGroup.securityGroupId),
      GroupId: stack.resolve(nfsSecurityGroup.securityGroupId),
    }));
    // Make sure we download the mountEfs script asset bundle
    const s3Copy = 'aws s3 cp \'s3://${Token[TOKEN.\\d+]}/${Token[TOKEN.\\d+]}${Token[TOKEN.\\d+]}\' \'/tmp/${Token[TOKEN.\\d+]}${Token[TOKEN.\\d+]}\'';
    expect(userData).toMatch(new RegExp(escapeTokenRegex(s3Copy)));
    expect(userData).toMatch(new RegExp(escapeTokenRegex('unzip /tmp/${Token[TOKEN.\\d+]}${Token[TOKEN.\\d+]}')));
    // Make sure we execute the script with the correct args
    expect(userData).toMatch(new RegExp(escapeTokenRegex(`bash ./mountNfs.sh ${nfsFS.fullHostname} ${mountProps.location} ${location} rw`)));
  });

  test('assert Linux-only', () => {
    // GIVEN
    const windowsInstance = new Instance(stack, 'WindowsInstance', {
      vpc,
      instanceType: new InstanceType('t3.small'),
      machineImage: MachineImage.latestWindows(WindowsVersion.WINDOWS_SERVER_2019_ENGLISH_FULL_SQL_2017_STANDARD),
    });
    const mount = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
    });

    // THEN
    expect(() => {
      mount.mountToLinuxInstance(windowsInstance, {
        location: '/mnt/nfs/fs1',
        permissions: MountPermissions.READONLY,
      });
    }).toThrowError('Target instance must be Linux.');
  });

  test('readonly mount', () => {
    // GIVEN
    const mount = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
    });
    const location = '/mnt/nfs/fs1';

    // WHEN
    mount.mountToLinuxInstance(instance, {
      location,
      permissions: MountPermissions.READONLY,
    });
    const userData = instance.userData.render();

    // THEN
    expect(userData).toMatch(new RegExp(escapeTokenRegex(`bash ./mountNfs.sh ${nfsFS.fullHostname} ${mountProps.location} ${location} r`)));
  });

  test('extra mount options', () => {
    // GIVEN
    const extraMountOptions = [ 'option1', 'option2' ];
    const mount = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
      extraMountOptions,
    });
    const location = '/mnt/nfs/fs1';

    // WHEN
    mount.mountToLinuxInstance(instance, {
      location,
    });
    const userData = instance.userData.render();

    // THEN
    expect(userData).toMatch(new RegExp(escapeTokenRegex(`bash ./mountNfs.sh ${nfsFS.fullHostname} ${mountProps.location} ${location} rw,${extraMountOptions.join(',')}`)));
  });

  test('asset is singleton', () => {
    // GIVEN
    const mount1 = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
    });
    const mount2 = new MountableNfs(nfsFS, {
      filesystem: nfsFS,
    });
    const location = '/mnt/nfs/fs1';

    // WHEN
    mount1.mountToLinuxInstance(instance, {
      location,
    });
    mount2.mountToLinuxInstance(instance, {
      location,
    });
    const userData = instance.userData.render();
    const s3Copy = 'aws s3 cp \'s3://${Token[TOKEN.\\d+]}/${Token[TOKEN.\\d+]}${Token[TOKEN.\\d+]}\'';
    const regex = new RegExp(escapeTokenRegex(s3Copy), 'g');
    const matches = userData.match(regex) ?? [];

    // THEN
    // The source of the asset copy should be identical from mount1 & mount2
    expect(matches).toHaveLength(2);
    expect(matches[0]).toBe(matches[1]);
  });
});
