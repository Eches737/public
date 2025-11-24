// Simple helper to use a local in-memory store when LOCAL_S3=1 for tests
const LOCAL_MAP = global.__LOCAL_S3_MAP || (global.__LOCAL_S3_MAP = new Map());

function makeS3Client() {
  if (process.env.LOCAL_S3 === '1') {
    return null; // signal to use LOCAL_MAP
  }
  // require lazily so tests that run with LOCAL_S3 don't need the aws sdk installed
  const { S3Client } = require('@aws-sdk/client-s3');
  return new S3Client({ region: process.env.AWS_REGION || 'us-east-1' });
}

async function getObjectFromS3(client, Bucket, Key) {
  if (!client) {
    const str = LOCAL_MAP.get(Key);
    if (str === undefined) throw Object.assign(new Error('NotFound'), { code: 'NoSuchKey' });
    return str;
  }

  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new GetObjectCommand({ Bucket, Key });
  const resp = await client.send(cmd);
  const streamToString = (stream) => new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (c) => chunks.push(Buffer.from(c)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
  return await streamToString(resp.Body);
}

async function putObjectToS3(client, Bucket, Key, Body) {
  if (!client) {
    LOCAL_MAP.set(Key, Body);
    return;
  }
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const cmd = new PutObjectCommand({ Bucket, Key, Body });
  await client.send(cmd);
}

function jsonResponse(statusCode, body) {
  return {
    statusCode,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  };
}

exports.handler = async (event) => {
  try {
    const client = makeS3Client();
    const BUCKET = process.env.BUCKET_NAME || process.env.BUCKET || 'user-state-bucket-placeholder';

    const method = (event.httpMethod || event.requestContext?.http?.method || 'GET').toUpperCase();
    if (method === 'OPTIONS') return { statusCode: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' } };

    if (method === 'GET') {
      // Accept userSub from query (legacy) or from authorizer (preferred)
      const userSub = event.queryStringParameters?.userSub || event.requestContext?.authorizer?.jwt?.claims?.sub || event.requestContext?.authorizer?.claims?.sub;
      if (!userSub) return jsonResponse(400, { error: 'userSub query required or missing from authorizer' });

      const key = `users/${userSub}/sidebar.json`;
      try {
        const txt = await getObjectFromS3(client, BUCKET, key);
        const parsed = JSON.parse(txt);
        return jsonResponse(200, parsed);
      } catch (err) {
        if (err.code === 'NoSuchKey' || err.code === 'NotFound') return jsonResponse(404, { error: 'not found' });
        console.error('GET error', err);
        return jsonResponse(500, { error: 'internal error', detail: err.message });
      }
    }

    if (method === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      const { sidebar, papers } = body;
      // userSub may come from body (legacy) or from authorizer JWT claims
      const userSub = body.userSub || event.requestContext?.authorizer?.jwt?.claims?.sub || event.requestContext?.authorizer?.claims?.sub;
      if (!userSub) return jsonResponse(400, { error: 'userSub required in body or must be present in authorizer claims' });

      const key = `users/${userSub}/sidebar.json`;
      const payload = JSON.stringify({ sidebar, papers });
      try {
        await putObjectToS3(client, BUCKET, key, payload);
        return jsonResponse(200, { ok: true });
      } catch (err) {
        console.error('PUT error', err);
        return jsonResponse(500, { error: 'failed to write', detail: err.message });
      }
    }

    return jsonResponse(405, { error: 'method not allowed' });
  } catch (err) {
    console.error('handler top error', err);
    return jsonResponse(500, { ok: false, error: err.message });
  }
};
