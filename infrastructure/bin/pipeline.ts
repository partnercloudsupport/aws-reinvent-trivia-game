#!/usr/bin/env node
import codebuild = require('@aws-cdk/aws-codebuild');
import codepipeline = require('@aws-cdk/aws-codepipeline');
import cfn = require('@aws-cdk/aws-cloudformation');
import iam = require('@aws-cdk/aws-iam');
import cdk = require('@aws-cdk/cdk');

export interface TriviaGameCfnPipelineProps {
    stackName: string;
    directory: string;
}

export class TriviaGameCfnPipeline extends cdk.Construct {
    constructor(parent: cdk.Construct, name: string, props: TriviaGameCfnPipelineProps) {
        super(parent, name);

        const pipeline = new codepipeline.Pipeline(this, 'Pipeline', {
            pipelineName: 'reinvent-trivia-game-' + props.stackName,
        });

        // Source
        const githubAccessToken = new cdk.SecretParameter(this, 'GitHubToken', { ssmParameter: 'GitHubToken' });
        new codepipeline.GitHubSourceAction(this, 'GitHubSource', {
            stage: pipeline.addStage('Source'),
            owner: 'clareliguori',
            repo: 'aws-reinvent-trivia-game',
            oauthToken: githubAccessToken.value
        });

        // Build
        const buildProject = new codebuild.Project(this, 'BuildProject', {
            source: new codebuild.GitHubSource({
                cloneUrl: 'https://github.com/clareliguori/aws-reinvent-trivia-game',
                oauthToken: githubAccessToken.value
            }),
            buildSpec: props.directory + '/buildspec.yml',
            environment: {
              buildImage: codebuild.LinuxBuildImage.UBUNTU_14_04_NODEJS_10_1_0
            },
            artifacts: new codebuild.S3BucketBuildArtifacts({
                bucket: pipeline.artifactBucket,
                name: 'output.zip'
            })
        });

        buildProject.addToRolePolicy(new iam.PolicyStatement().addAllResources().addAction('ec2:DescribeAvailabilityZones'));
        buildProject.addToRolePolicy(new iam.PolicyStatement()
            .addAction('ssm:GetParameter')
            .addResource(cdk.ArnUtils.fromComponents({
                service: 'ssm',
                resource: 'parameter',
                resourceName: 'CertificateArn-*'
            })));

        const buildStage = pipeline.addStage('Build');
        const buildAction = buildProject.addBuildToPipeline(buildStage, 'CodeBuild');

        // Test
        const testStage = pipeline.addStage('Test');
        const templatePrefix =  'TriviaGame' + props.stackName.charAt(0).toUpperCase() + props.stackName.slice(1);
        const testStackName = 'reinvent-trivia-' + props.stackName + '-test';
        const changeSetName = 'StagedChangeSet';

        new cfn.PipelineCreateReplaceChangeSetAction(this, 'PrepareChangesTest', {
            stage: testStage,
            stackName: testStackName,
            changeSetName,
            runOrder: 1,
            fullPermissions: true,
            templatePath: buildAction.outputArtifact.atPath(templatePrefix + 'Test.template.yaml'),
        });

        new cfn.PipelineExecuteChangeSetAction(this, 'ExecuteChangesTest', {
            stage: testStage,
            stackName: testStackName,
            changeSetName,
            runOrder: 2
        });

        // Prod
        const prodStage = pipeline.addStage('Prod');
        const prodStackName = 'reinvent-trivia-' + props.stackName + '-prod';

        new cfn.PipelineCreateReplaceChangeSetAction(this, 'PrepareChanges', {
            stage: prodStage,
            stackName: prodStackName,
            changeSetName,
            runOrder: 1,
            fullPermissions: true,
            templatePath: buildAction.outputArtifact.atPath(templatePrefix + 'Prod.template.yaml'),
        });

        new cfn.PipelineExecuteChangeSetAction(this, 'ExecuteChangesProd', {
            stage: prodStage,
            stackName: prodStackName,
            changeSetName,
            runOrder: 2
        });
    }
}