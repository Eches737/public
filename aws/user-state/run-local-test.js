// Quick local test runner for the user-state lambda in LOCAL_S3 mode.
// Usage: LOCAL_S3=1 node aws/user-state/run-local-test.js

const assert = require('assert');
const handler = require('./index').handler;

async function run() {
  console.log('Running local test (LOCAL_S3=1)');

  // POST to create
  const postEvent = {
    httpMethod: 'POST',
    body: JSON.stringify({ userSub: 'test-user-1', sidebar: { items: [{ id: 1, label: 'a' }] }, papers: {} })
  };

  const postResp = await handler(postEvent);
  console.log('POST resp:', postResp);
  assert.strictEqual(postResp.statusCode, 200, 'POST should return 200');

  // GET to read
  const getEvent = {
    httpMethod: 'GET',
    queryStringParameters: { userSub: 'test-user-1' }
  };
  const getResp = await handler(getEvent);
  console.log('GET resp:', getResp);
  assert.strictEqual(getResp.statusCode, 200, 'GET should return 200');
  const body = JSON.parse(getResp.body);
  assert.deepStrictEqual(body.sidebar, { items: [{ id: 1, label: 'a' }] });

  console.log('Local test passed');
}

run().catch((err) => {
  console.error('Local test failed', err);
  process.exit(1);
});
