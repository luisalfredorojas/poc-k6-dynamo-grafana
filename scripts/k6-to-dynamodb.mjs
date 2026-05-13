import { readFileSync } from 'fs';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, BatchWriteCommand } from '@aws-sdk/lib-dynamodb';

const ENDPOINT = process.env.DYNAMODB_ENDPOINT || 'http://dynamodb-local:8000';
const REGION   = process.env.AWS_REGION         || 'us-east-1';
const RUN_ID   = process.env.RUN_ID             || 'run-local';
const SUMMARY  = process.env.SUMMARY_PATH       || '/app/out/summary.json';

const client = DynamoDBDocumentClient.from(new DynamoDBClient({
  endpoint: ENDPOINT,
  region: REGION,
  credentials: {
    accessKeyId:     process.env.AWS_ACCESS_KEY_ID     || 'local',
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY || 'local',
  },
}));

let summary;
try {
  summary = JSON.parse(readFileSync(SUMMARY, 'utf8'));
} catch (e) {
  console.error(`Failed to read summary file at ${SUMMARY}:`, e.message);
  process.exit(1);
}

const { thresholds = [], ...runData } = summary;

console.log(`Ingesting run ${RUN_ID} into DynamoDB at ${ENDPOINT}...`);

await client.send(new PutCommand({
  TableName: 'k6_test_runs',
  Item: {
    ...runData,
    run_id: RUN_ID,
  },
}));
console.log('  k6_test_runs: inserted run summary');

if (thresholds.length > 0) {
  const CHUNK = 25;
  for (let i = 0; i < thresholds.length; i += CHUNK) {
    const chunk = thresholds.slice(i, i + CHUNK);
    await client.send(new BatchWriteCommand({
      RequestItems: {
        k6_thresholds: chunk.map((t) => ({
          PutRequest: {
            Item: {
              run_id:     RUN_ID,
              metric:     t.metric,
              expression: t.expression,
              passed:     t.passed,
            },
          },
        })),
      },
    }));
  }
  console.log(`  k6_thresholds: inserted ${thresholds.length} threshold(s)`);
} else {
  console.log('  k6_thresholds: no thresholds to insert');
}

console.log('Ingest complete.');
