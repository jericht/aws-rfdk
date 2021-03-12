/**
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  arrayWith,
  countResources,
  expect as cdkExpect,
  haveResource,
  haveResourceLike,
  objectLike,
} from '@aws-cdk/assert';
import {
  InstanceType,
  SecurityGroup,
  SubnetType,
  Volume,
  Vpc,
} from '@aws-cdk/aws-ec2';
import {
  Role,
  ServicePrincipal,
} from '@aws-cdk/aws-iam';
import {
  Key,
} from '@aws-cdk/aws-kms';
import {
  ILogGroup,
  RetentionDays,
} from '@aws-cdk/aws-logs';
import {
  PrivateHostedZone,
} from '@aws-cdk/aws-route53';
import {
  App,
  Size,
  Stack,
} from '@aws-cdk/core';
import {
  LinuxMountPointProps,
  MountPermissions,
  NfsInstance,
} from '../lib';
import {
  CWA_ASSET_LINUX,
} from './asset-constants';
import {
  testConstructTags,
} from './tag-helpers';
import {
  escapeTokenRegex,
} from './token-regex-helpers';

describe('NfsInstance', () => {
  let app: App;
  let stack: Stack;
  let vpc: Vpc;
  let dnsZone: PrivateHostedZone;

  const hostname = 'hostname';
  const zoneName = 'testZone';
  const mount: LinuxMountPointProps = {
    location: '/mnt/nfs',
    permissions: MountPermissions.READWRITE,
  };

  beforeEach(() => {
    app = new App();
    stack = new Stack(app, 'Stack');
    vpc = new Vpc(stack, 'Vpc');
    dnsZone = new PrivateHostedZone(stack, 'PrivateHostedZone', {
      vpc,
      zoneName,
    });
  });

  describe('created with defaults', () => {
    let instance: NfsInstance;

    beforeEach(() => {
      // WHEN
      instance = new NfsInstance(stack, 'NfsInstance', {
        vpc,
        dnsZone,
        hostname,
        mount,
      });
    });

    test('creates autoscaling group', () => {
      // THEN
      cdkExpect(stack).to(haveResource('AWS::AutoScaling::AutoScalingGroup'));
      cdkExpect(stack).to(haveResourceLike('AWS::AutoScaling::LaunchConfiguration', {
        InstanceType: 'm5.xlarge',
        BlockDeviceMappings: arrayWith(
          objectLike({
            Ebs: objectLike({
              Encrypted: true,
            }),
          }),
        ),
      }));
      instance.mount;
    });

    test('creates a recordset', () => {
      // THEN
      cdkExpect(stack).to(haveResourceLike('AWS::Route53::RecordSet', {
        Name: hostname + '.' + zoneName + '.',
      }));
    });

    test('creates an encrypted volume', () => {
      // THEN
      cdkExpect(stack).to(haveResourceLike('AWS::EC2::Volume', {
        Encrypted: true,
        Tags: arrayWith(
          objectLike({
            Key: 'VolumeGrantAttach-05fee6c4c31971e957580804cfbba342',
            Value: 'e18bab11e5d3ff4627950d27e5cada1d',
          }),
        ),
      }));
    });

    test('grants cloudwatch log streaming permissions', () => {
      // THEN
      cdkExpect(stack).to(haveResourceLike('AWS::IAM::Policy', {
        PolicyDocument: objectLike({
          Statement: arrayWith(
            {
              Action: [
                'logs:CreateLogStream',
                'logs:PutLogEvents',
              ],
              Effect: 'Allow',
              Resource: stack.resolve((instance.node.tryFindChild('NfsInstanceLogGroupWrapper') as ILogGroup).logGroupName),
            },
            {
              Action: [
                's3:GetObject*',
                's3:GetBucket*',
                's3:List*',
              ],
              Effect: 'Allow',
              Resource: [
                {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':s3:::',
                      {
                        Ref: CWA_ASSET_LINUX.Bucket,
                      },
                    ],
                  ],
                },
                {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':s3:::',
                      {
                        Ref: CWA_ASSET_LINUX.Bucket,
                      },
                      '/*',
                    ],
                  ],
                },
              ],
            },
          ),
        }),
      }));
    });

    test('grants access to CDK asset bucket', () => {
      cdkExpect(stack).to(haveResourceLike('AWS::IAM::Policy', {
        PolicyDocument: objectLike({
          Statement: arrayWith(
            {
              Action: [
                's3:GetObject*',
                's3:GetBucket*',
                's3:List*',
              ],
              Effect: 'Allow',
              Resource: [
                {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':s3:::',
                      {
                        Ref: CWA_ASSET_LINUX.Bucket,
                      },
                    ],
                  ],
                },
                {
                  'Fn::Join': [
                    '',
                    [
                      'arn:',
                      {
                        Ref: 'AWS::Partition',
                      },
                      ':s3:::',
                      {
                        Ref: CWA_ASSET_LINUX.Bucket,
                      },
                      '/*',
                    ],
                  ],
                },
              ],
            },
          ),
        }),
      }));
    });

    test('creates log retention', () => {
      cdkExpect(stack).to(haveResourceLike('Custom::LogRetention', {
        LogGroupName: '/renderfarm/NfsInstance',
      }));
    });

    test('creates ssm parameter for cloud-init-output', () => {
      const cloudInitLogPath = '/var/log/cloud-init-output.log';
      const cloudInitLogPrefix = 'cloud-init-output';

      cdkExpect(stack).to(haveResourceLike('AWS::SSM::Parameter', {
        Description: 'config file for Repository logs config',
        Value: objectLike({
          'Fn::Join': arrayWith(
            arrayWith(
              '\",\"log_stream_name\":\"' + cloudInitLogPrefix + '-{instance_id}\",\"file_path\":\"' + cloudInitLogPath + '\",' +
              '\"timezone\":\"Local\"}]}},\"log_stream_name\":\"DefaultLogStream-{instance_id}\",\"force_flush_interval\":15}}',
            ),
          ),
        }),
      }));
    });

    test('has public members set', () => {
      // THEN
      expect(instance.connections).toBeDefined();
      expect(instance.connections.securityGroups).toEqual(instance.server.connections.securityGroups);

      expect(instance.grantPrincipal).toBeDefined();
      expect(instance.grantPrincipal).toBe(instance.server.grantPrincipal);

      expect(instance.port).toBeDefined();

      expect(instance.role).toBeDefined();
      expect(instance.role).toBe(instance.server.role);

      expect(instance.userData).toBeDefined();
      expect(instance.userData).toBe(instance.server.userData);

      expect(instance.fullHostname).toBeDefined();

      expect(instance.exports).toBeDefined();

      expect(instance.mount).toBeDefined();
      expect(instance.mount).toEqual(mount);
    });

    describe('user data', () => {
      let userData: string;

      // Common patterns to match in the user data script
      const token = '${Token[TOKEN.\\d+]}';
      const createTempDir = 'mkdir -p $\\(dirname \'/tmp/' + token + token + '\'\\)\n';
      const s3Copy = 'aws s3 cp \'s3://' + token + '/' + token + token + '\' \'/tmp/' + token + token + '\'\n';

      beforeEach(() => {
        // WHEN
        userData = instance.userData.render();
      });

      test('has signal on exit', () => {
        // THEN
        const exitTrap = '#!/bin/bash\n' +
                        'function exitTrap(){\n' +
                        'exitCode=$?\n' +
                        `/opt/aws/bin/cfn-signal --stack Stack --resource ${stack.resolve(instance.server.autoscalingGroup.autoScalingGroupName)} --region ${token}` +
                          ' -e $exitCode || echo \'Failed to send Cloudformation Signal\'' +
                          '}';
        expect(userData).toMatch(new RegExp(escapeTokenRegex(exitTrap)));

        const callExitTrap = 'trap exitTrap EXIT';
        expect(userData).toMatch(new RegExp(callExitTrap));
      });

      test('sets bash settings', () => {
        // THEN
        const settings = 'set -xefuo pipefail';
        expect(userData).toMatch(new RegExp(settings));
      });

      test('configures cloudwatch agent', () => {
        // THEN
        const setE = 'set -e\n';
        const setChmod = 'chmod \\+x \'/tmp/' + token + token + '\'\n';
        const execute = '\'/tmp/' + token + token + '\' -i ${Token[AWS.Region.\\d+]} ' + token + '\n';
        expect(userData).toMatch(new RegExp(escapeTokenRegex(createTempDir + s3Copy + setE + setChmod + execute)));
      });

      test('mounts ebs volume', () => {
        // THEN
        const mountEbsCommands = 'TMPDIR=$\\(mktemp -d\\)\n' +
                      'pushd \"$TMPDIR\"\n' +
                      'unzip /tmp/' + token + token + '\n' +
                      `bash ./mountEbsBlockVolume.sh ${token} xfs ${mount.location} rw \"\"\n` +
                      'popd\n' +
                      'rm -f /tmp/' + token + token;
        expect(userData).toMatch(new RegExp(escapeTokenRegex(createTempDir + s3Copy + mountEbsCommands)));
      });

      test('configures nfs', () => {
        // THEN
        const nfsConfig = 'sudo yum install -y nfs-utils nfs-utils-lib\n' +
                          'sudo service nfs start\n' +
                          'sudo chkconfig --level 35 nfs on';
        expect(userData).toMatch(new RegExp(escapeTokenRegex(nfsConfig)));
      });
    });
  });

  test('throw exception when no available subnets', () => {
    // GIVEN
    const invalidSubnets = {
      subnetType: SubnetType.PRIVATE,
      availabilityZones: ['dummy zone'],
    };

    // THEN
    expect(() => {
      new NfsInstance(stack, 'NfsInstance', {
        vpc,
        dnsZone,
        hostname,
        mount,
        vpcSubnets: invalidSubnets,
      });
    }).toThrowError(/Did not find any subnets matching/);
  });

  test('changing instance type works correctly', () => {
    // GIVEN
    const expectedInstanceType = 'm4.micro';

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      instanceType: new InstanceType(expectedInstanceType),
    });

    // THEN
    cdkExpect(stack).to(haveResourceLike('AWS::AutoScaling::LaunchConfiguration', {
      InstanceType: expectedInstanceType,
    }));
  });

  test('allowing ssh connection with key name', () => {
    // GIVEN
    const expectedKeyName = 'someKeyName';

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      keyName: expectedKeyName,
    });

    // THEN
    cdkExpect(stack).to(haveResourceLike('AWS::AutoScaling::LaunchConfiguration', {
      KeyName: expectedKeyName,
    }));
  });

  test('setting security group works correctly', () => {
    // GIVEN
    const actualSecurityGroup = new SecurityGroup(stack, 'SecurityGroup', {
      securityGroupName: 'CustomSecurityGroup',
      vpc,
    });

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      securityGroup: actualSecurityGroup,
    });

    // THEN
    cdkExpect(stack).to(countResources('AWS::EC2::SecurityGroup', 1));
  });

  test('setting role works correctly', () => {
    // GIVEN
    const expectedRole = new Role(stack, 'Role', {
      assumedBy: new ServicePrincipal('ec2.amazonaws.com'),
      roleName: 'CustomRole',
    });

    // WHEN
    const instance = new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      role: expectedRole,
    });

    // THEN
    expect(instance.server.role).toBe(expectedRole);
    expect(instance.role).toBe(expectedRole);
  });

  test('setting custom data volume works correctly', () => {
    // GIVEN
    const actualVolume = new Volume(stack, 'Volume', {
      availabilityZone: 'us-east-1a',
      size: Size.gibibytes(50),
    });

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      volume: {
        volume: actualVolume,
      },
    });

    // THEN
    cdkExpect(stack).to(countResources('AWS::EC2::Volume', 1));
  });

  test('setting custom encryption key for data volume works correctly', () => {
    // GIVEN
    const actualEncryptionKey = new Key(stack, 'Key', {
      description: 'Key for testing',
    });

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      volume: {
        volumeProps: {
          encryptionKey: actualEncryptionKey,
        },
      },
    });

    // THEN
    cdkExpect(stack).to(haveResourceLike('AWS::EC2::Volume', {
      Encrypted: true,
      KmsKeyId: stack.resolve(actualEncryptionKey.keyArn),
    }));
  });

  test('setting custom size for data volume works correctly', () => {
    // GIVEN
    const volumeSize = 123;

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      volume: {
        volumeProps: {
          size: Size.gibibytes(volumeSize),
        },
      },
    });

    // THEN
    cdkExpect(stack).to(haveResourceLike('AWS::EC2::Volume', {
      Size: volumeSize,
    }));
  });

  test('setting LogGroup bucket name enables export to S3', () => {
    // GIVEN
    const bucketName = 'test-bucket';

    // WHEN
    const instance = new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      logGroupProps: {
        bucketName,
      },
    });

    cdkExpect(stack).to(haveResource('AWS::Events::Rule', {
      Targets: arrayWith(objectLike({
        Input: `{\"BucketName\":\"${bucketName}\",\"ExportFrequencyInHours\":1,\"LogGroupName\":\"/renderfarm/${instance.node.id}\",\"RetentionInHours\":72}`,
      })),
    }));
  });

  test.each([
    'test-prefix/',
    '',
  ])('is created with correct LogGroup prefix %s', (testPrefix: string) => {
    // GIVEN
    const id = 'NfsInstance';

    // WHEN
    new NfsInstance(stack, id, {
      vpc,
      dnsZone,
      hostname,
      mount,
      logGroupProps: {
        logGroupPrefix: testPrefix,
      },
    });

    // THEN
    cdkExpect(stack).to(haveResource('Custom::LogRetention', {
      LogGroupName: testPrefix + id,
    }));
  });

  test('is created with correct LogGroup retention', () => {
    // GIVEN
    const retention = RetentionDays.ONE_DAY;

    // WHEN
    new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
      logGroupProps: {
        retention,
      },
    });

    // THEN
    cdkExpect(stack).to(haveResource('Custom::LogRetention', {
      RetentionInDays: retention,
    }));
  });

  test('adds security group', () => {
    // GIVEN
    const securityGroup = new SecurityGroup(stack, 'NewSecurityGroup', {
      vpc,
    });
    const instance = new NfsInstance(stack, 'NfsInstance', {
      vpc,
      dnsZone,
      hostname,
      mount,
    });

    // WHEN
    instance.addSecurityGroup(securityGroup);

    // THEN
    cdkExpect(stack).to(haveResourceLike('AWS::AutoScaling::LaunchConfiguration', {
      SecurityGroups: arrayWith(stack.resolve(securityGroup.securityGroupId)),
    }));
  });

  testConstructTags({
    constructName: 'NfsInstance',
    createConstruct: () => {
      const isolatedStack = new Stack(app, 'IsolatedStack');
      new NfsInstance(isolatedStack, 'NfsInstance', {
        vpc,
        dnsZone,
        hostname,
        mount,
      });
      return isolatedStack;
    },
    resourceTypeCounts: {
      'AWS::EC2::SecurityGroup': 1,
      'AWS::IAM::Role': 1,
      'AWS::AutoScaling::AutoScalingGroup': 1,
      'AWS::EC2::NetworkInterface': 1,
      'AWS::EC2::Volume': 1,
      'AWS::SSM::Parameter': 1,
    },
  });
});

/* tslint:enable */