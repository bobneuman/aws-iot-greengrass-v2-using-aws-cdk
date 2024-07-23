import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as iot from 'aws-cdk-lib/aws-iot';
import * as opensearch from 'aws-cdk-lib/aws-opensearchservice';
import * as hose from 'aws-cdk-lib/aws-kinesisfirehose';

import * as base from '../../../lib/template/stack/base/base-stack';
import { AppContext } from '../../../lib/template/app-context';

enum OpenSearchSelection {
    DEVELOP,
    CUSTOM,
    LEGACY
}

export class DataPipelineStack extends base.BaseStack {

    constructor(appContext: AppContext, stackConfig: any) {
        super(appContext, stackConfig);

        const domain = this.createOpenSearch();

        const fhose = this.createFirehose2OS(domain);

        if (fhose != undefined) {
            this.createIoTRuleToFirehose(stackConfig.IoTRuleNameFirehoseIngestion, fhose.deliveryStreamName!);
        }
    }

    private createFirehose2OS(domain: opensearch.IDomain): hose.CfnDeliveryStream | undefined {
        const osBucket = this.createS3Bucket('firehose-os')

        const baseName = 'Firehose2OS';
        const role = new iam.Role(this, `${baseName}Role`, {
            roleName: `${this.projectPrefix}-${baseName}Role`,
            assumedBy: new iam.ServicePrincipal('firehose.amazonaws.com'),
        });
        role.addToPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                actions: [
                    'es:ESHttpPost',
                    'es:ESHttpPut',
                    'es:ESHttpGet',
                    // 'es:*',
                    'es:DescribeElasticsearchDomain',
                    'es:DescribeElasticsearchDomains',
                    'es:DescribeElasticsearchDomainConfig',
                ]
            })
        );
        role.addToPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                actions: [
                    's3:AbortMultipartUpload',
                    's3:GetBucketLocation',
                    's3:GetObject',
                    's3:ListBucket',
                    's3:ListBucketMultipartUploads',
                    's3:PutObject',
                ]
            })
        );
        role.addToPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                actions: [
                    'logs:PutLogEvents'
                ]
            })
        );
        this.exportOutput('Firehose2OSRole', role.roleArn)

        if (this.stackConfig.IoTRuleEnable) {
            const fhose = new hose.CfnDeliveryStream(this, 'firehose', {
                deliveryStreamName: `${this.projectPrefix}-OS-Delivery`,
                elasticsearchDestinationConfiguration: {
                    indexName: 'index-thing-data',
                    domainArn: domain.domainArn,
                    roleArn: role.roleArn,
                    indexRotationPeriod: 'OneDay',
                    s3BackupMode: 'FailedDocumentsOnly',
                    s3Configuration: {
                        bucketArn: osBucket.bucketArn,
                        roleArn: role.roleArn,
                        prefix: 'fail',
                    }
                }
            });
            return fhose;
        } else {
            return undefined;
        }
    }

    private createIoTRuleToFirehose(ruleNameSuffix: string, streamName: string) {
        const ruleName = `${this.projectPrefix}_${ruleNameSuffix}`.toLowerCase().replace('-', '_');
        const sql = `SELECT * FROM '#'`; // $aws/rules/rule_name/thing-name/data-type

        const role = new iam.Role(this, `${ruleNameSuffix}Role`, {
            roleName: `${this.projectPrefix}-${ruleNameSuffix}Role`,
            assumedBy: new iam.ServicePrincipal('iot.amazonaws.com'),
        });
        role.addToPolicy(
            new iam.PolicyStatement({
                resources: ['*'],
                actions: [
                    'firehose:*'
                ]
            })
        );

        new iot.CfnTopicRule(this, ruleNameSuffix, {
            ruleName: ruleName,
            topicRulePayload: {
                ruleDisabled: false,
                sql: sql,
                awsIotSqlVersion: '2016-03-23',
                actions: [{ firehose: { deliveryStreamName: streamName, roleArn: role.roleArn } }],
            }
        });
    }

    private createOpenSearch(): opensearch.IDomain {
        let domain = undefined;
        const temp: string = this.stackConfig.OpenSearchSelection;
        const selection: OpenSearchSelection = (<any>OpenSearchSelection)[temp];
        const selectionName = Object.values(OpenSearchSelection)[selection];
        console.info('==> OpenSearch Selection: ', selectionName);

        const domainName = this.stackConfig.DomainName;
        const fullDomainName = `${this.projectPrefix}-${domainName}`.toLowerCase().replace('_', '-');
        const masterUserName = this.stackConfig.MasterUserName;
        const ipAddressList = this.stackConfig.OSConditionAddress || []; // Ensure this is defined
        const conditions = this.createPolicyConditions(ipAddressList);

        if (selection == OpenSearchSelection.DEVELOP) {
            const config = this.stackConfig.OpenSearchCandidate[selectionName]

            domain = new opensearch.Domain(this, domainName, {
                domainName: fullDomainName,
                version: opensearch.EngineVersion.OPENSEARCH_2_13,
                enforceHttps: true,
                nodeToNodeEncryption: true,
                encryptionAtRest: {
                    enabled: true,
                },
                capacity: {
                    masterNodeInstanceType: config.MasterNodeType,
                    dataNodeInstanceType: config.DataNodeType
                },
                logging: {
                    slowSearchLogEnabled: true,
                    appLogEnabled: true,
                    slowIndexLogEnabled: true,
                },
                fineGrainedAccessControl: {
                    masterUserName: masterUserName,
                },
                useUnsignedBasicAuth: false,
                accessPolicies: [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        principals: [new iam.AnyPrincipal()],
                        resources: [`arn:aws:es:${this.region}:${this.account}:domain/${fullDomainName}/*`],
                        actions: [
                            'es:ESHttp*',
                        ],
                        conditions: conditions
                    })
                ]
            });
        } else if (selection == OpenSearchSelection.CUSTOM) {
            const config = this.stackConfig.OpenSearchCandidate[selectionName]

            domain = new opensearch.Domain(this, domainName, {
                domainName: fullDomainName,
                version: opensearch.EngineVersion.OPENSEARCH_1_0,
                capacity: {
                    masterNodes: config.MasterNodeCount,
                    masterNodeInstanceType: config.MasterNodeType,
                    dataNodes: config.DataNodeCount,
                    dataNodeInstanceType: config.DataNodeType
                },
                ebs: {
                    volumeSize: config.VolumeSize
                },
                zoneAwareness: {
                    availabilityZoneCount: config.AZCount
                },
                enforceHttps: true,
                nodeToNodeEncryption: true,
                encryptionAtRest: {
                    enabled: true,
                },
                fineGrainedAccessControl: {
                    masterUserName: masterUserName,
                },
                useUnsignedBasicAuth: false,
                accessPolicies: [
                    new iam.PolicyStatement({
                        effect: iam.Effect.ALLOW,
                        principals: [new iam.AnyPrincipal()],
                        resources: [`arn:aws:es:${this.region}:${this.account}:domain/${fullDomainName}/*`],
                        actions: [
                            'es:ESHttp*',
                        ],
                        conditions: conditions
                    })
                ]
            });

        } else if (selection == OpenSearchSelection.LEGACY) {
            const config = this.stackConfig.OpenSearchCandidate[selectionName]

            const domainEndpoint = config.DomainEndpoint;
            domain = opensearch.Domain.fromDomainEndpoint(this, domainName, domainEndpoint);
        } else {
            console.error('OpenSearch Creation Fail - Wrong Selection');
        }

        return domain!;
    }

    private createPolicyConditions(ipAddressList: string[]| undefined): any {
        const condition: any = {};

        if (ipAddressList && ipAddressList.length > 0)  {
            condition['IpAddress'] = {
                'aws:SourceIp': ipAddressList
            }
        }

        return condition
    }
}
