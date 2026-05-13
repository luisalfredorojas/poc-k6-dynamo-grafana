import express from 'express';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

const app = express();
const port = process.env.PORT || 4000;

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({
  endpoint: process.env.DYNAMODB_ENDPOINT,
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
}));

app.get('/health', (_req, res) => res.json({ ok: true }));

app.get('/runs', async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 100);
    const out = await ddb.send(new ScanCommand({
      TableName: 'k6_test_runs',
      Limit: limit,
    }));
    const items = (out.Items ?? [])
      .sort((a, b) => String(b.started_at ?? '').localeCompare(String(a.started_at ?? '')));
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/runs/:run_id', async (req, res) => {
  try {
    const out = await ddb.send(new QueryCommand({
      TableName: 'k6_test_runs',
      KeyConditionExpression: 'run_id = :rid',
      ExpressionAttributeValues: { ':rid': req.params.run_id },
    }));
    res.json(out.Items?.[0] ?? null);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/thresholds', async (req, res) => {
  try {
    const runId = req.query.run_id;
    if (!runId) return res.status(400).json({ error: 'run_id query param required' });
    const out = await ddb.send(new QueryCommand({
      TableName: 'k6_thresholds',
      KeyConditionExpression: 'run_id = :rid',
      ExpressionAttributeValues: { ':rid': String(runId) },
    }));
    res.json(out.Items ?? []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/thresholds/all', async (_req, res) => {
  try {
    const out = await ddb.send(new ScanCommand({ TableName: 'k6_thresholds' }));
    res.json(out.Items ?? []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(port, () => console.log(`api-gateway listening on :${port}`));
