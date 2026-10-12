import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createConfirmGate, withConfirmToken, inputSchemaExtension } from '../src/index.mjs';
import { createExampleServer } from '../examples/server.mjs';

test('1. A first call returns confirmation_required and the handler is not called', async () => {
  let handlerCalled = false;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrapped = gate.wrap(
    'delete_db',
    (args) => `Delete database ${args.dbName}`,
    async (args) => {
      handlerCalled = true;
      return { content: [{ type: 'text', text: 'Database deleted' }] };
    }
  );

  const res = await wrapped({ dbName: 'prod_main' });

  assert.strictEqual(handlerCalled, false, 'Handler must not be called on first invocation');
  assert.ok(res.content && res.content[0] && res.content[0].text, 'Result must contain content text');

  const payload = JSON.parse(res.content[0].text);
  assert.strictEqual(payload.confirmation_required, true, 'confirmation_required must be true');
  assert.strictEqual(payload.prompt, 'Delete database prod_main');
  assert.ok(typeof payload.confirmToken === 'string' && payload.confirmToken.length > 0, 'confirmToken must be issued');
  assert.ok(typeof payload.expiresAt === 'number' && payload.expiresAt > Date.now(), 'expiresAt must be a future timestamp');
});

test('2. Confirming with the issued token calls the handler exactly once', async () => {
  let callCount = 0;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrapped = gate.wrap(
    'delete_db',
    (args) => `Delete database ${args.dbName}`,
    async (args) => {
      callCount++;
      return { content: [{ type: 'text', text: `Database ${args.dbName} deleted` }] };
    }
  );

  const firstRes = await wrapped({ dbName: 'prod_main' });
  const token = JSON.parse(firstRes.content[0].text).confirmToken;
  assert.strictEqual(callCount, 0);

  const secondRes = await wrapped({ dbName: 'prod_main', confirmToken: token });
  assert.strictEqual(callCount, 1, 'Handler must be called exactly once');
  assert.strictEqual(secondRes.content[0].text, 'Database prod_main deleted');
});

test('3. Reusing the same token gives reused', async () => {
  let callCount = 0;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrapped = gate.wrap(
    'transfer_funds',
    (args) => `Transfer ${args.amount} to ${args.recipient}`,
    async (args) => {
      callCount++;
      return { content: [{ type: 'text', text: 'Funds transferred' }] };
    }
  );

  const firstRes = await wrapped({ amount: 500, recipient: 'Alice' });
  const token = JSON.parse(firstRes.content[0].text).confirmToken;

  // First use: succeeds
  const secondRes = await wrapped({ amount: 500, recipient: 'Alice', confirmToken: token });
  assert.strictEqual(callCount, 1);
  assert.strictEqual(secondRes.isError, undefined);

  // Second use: must be rejected with 'reused'
  const thirdRes = await wrapped({ amount: 500, recipient: 'Alice', confirmToken: token });
  assert.strictEqual(callCount, 1, 'Handler must not be called on token reuse');
  assert.strictEqual(thirdRes.isError, true);
  assert.strictEqual(thirdRes.reason, 'reused');

  const errorPayload = JSON.parse(thirdRes.content[0].text);
  assert.strictEqual(errorPayload.reason, 'reused');
});

test('4. Changing any arg gives args_mismatch (including key-order changes, which must NOT count as a mismatch: canonical JSON)', async () => {
  let callCount = 0;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrapped = gate.wrap(
    'update_policy',
    (args) => `Update policy ${args.policyId}`,
    async (args) => {
      callCount++;
      return { content: [{ type: 'text', text: `Updated ${args.policyId}` }] };
    }
  );

  // Issue token for args with specific key ordering
  const firstRes = await wrapped({ policyId: 'POL-101', tier: 'premium', active: true });
  const token = JSON.parse(firstRes.content[0].text).confirmToken;

  // Tampering with an argument value
  const tamperedRes = await wrapped({
    policyId: 'POL-101',
    tier: 'basic', // Changed tier
    active: true,
    confirmToken: token
  });
  assert.strictEqual(callCount, 0, 'Handler must not be called with tampered args');
  assert.strictEqual(tamperedRes.isError, true);
  assert.strictEqual(tamperedRes.reason, 'args_mismatch');

  // Key-order changes: same arguments in reverse/shuffled order MUST be accepted
  const reorderedRes = await wrapped({
    active: true,
    policyId: 'POL-101',
    tier: 'premium',
    confirmToken: token
  });
  assert.strictEqual(callCount, 1, 'Handler must be called when key ordering is altered');
  assert.strictEqual(reorderedRes.content[0].text, 'Updated POL-101');
});

test('5. Advancing the injected now past the TTL gives expired', async () => {
  let currentTime = 1_000_000;
  let callCount = 0;
  const gate = createConfirmGate({
    ttlMs: 5_000,
    now: () => currentTime
  });

  const wrapped = gate.wrap(
    'restart_server',
    () => 'Restart server cluster',
    async () => {
      callCount++;
      return { content: [{ type: 'text', text: 'Restarted' }] };
    }
  );

  const firstRes = await wrapped({ cluster: 'eu-west-1' });
  const token = JSON.parse(firstRes.content[0].text).confirmToken;

  // Advance time past the 5-second TTL
  currentTime += 5_001;

  const expiredRes = await wrapped({ cluster: 'eu-west-1', confirmToken: token });
  assert.strictEqual(callCount, 0, 'Handler must not be called on expired token');
  assert.strictEqual(expiredRes.isError, true);
  assert.strictEqual(expiredRes.reason, 'expired');
});

test('6. A forged token string gives unknown_token', async () => {
  let callCount = 0;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrapped = gate.wrap(
    'delete_account',
    () => 'Delete user account',
    async () => {
      callCount++;
      return { content: [{ type: 'text', text: 'Account deleted' }] };
    }
  );

  const forgedRes = await wrapped({
    userId: 'usr_777',
    confirmToken: 'badnonce.9999999999.0123456789abcdef0123456789abcdef'
  });

  assert.strictEqual(callCount, 0, 'Handler must not be called with forged token');
  assert.strictEqual(forgedRes.isError, true);
  assert.strictEqual(forgedRes.reason, 'unknown_token');
});

test('7. A token issued for tool A, used on tool B, is rejected', async () => {
  let toolACalled = false;
  let toolBCalled = false;
  const gate = createConfirmGate({ ttlMs: 60000 });

  const wrappedA = gate.wrap(
    'toolA',
    () => 'Execute Tool A',
    async () => {
      toolACalled = true;
      return { content: [{ type: 'text', text: 'Tool A succeeded' }] };
    }
  );

  const wrappedB = gate.wrap(
    'toolB',
    () => 'Execute Tool B',
    async () => {
      toolBCalled = true;
      return { content: [{ type: 'text', text: 'Tool B succeeded' }] };
    }
  );

  // Request token from tool A
  const firstResA = await wrappedA({ action: 'run' });
  const tokenA = JSON.parse(firstResA.content[0].text).confirmToken;

  // Attempt to use tool A token on tool B
  const resB = await wrappedB({ action: 'run', confirmToken: tokenA });

  assert.strictEqual(toolACalled, false);
  assert.strictEqual(toolBCalled, false, 'Tool B handler must not be called with Tool A token');
  assert.strictEqual(resB.isError, true, 'Cross-tool token usage must be rejected');
  assert.strictEqual(resB.reason, 'args_mismatch');
});

test('8. The audit log records the stages in order', async () => {
  const auditEvents = [];
  const gate = createConfirmGate({
    ttlMs: 60000,
    onAudit: (entry) => auditEvents.push(entry)
  });

  const wrapped = gate.wrap(
    'nuke_records',
    () => 'Nuke all records',
    async () => ({ content: [{ type: 'text', text: 'Records nuked' }] })
  );

  // Stage 1: requested
  const reqRes = await wrapped({ target: 'archived' });
  const token = JSON.parse(reqRes.content[0].text).confirmToken;

  // Stage 2: confirmed
  await wrapped({ target: 'archived', confirmToken: token });

  // Stage 3: rejected (reused)
  await wrapped({ target: 'archived', confirmToken: token });

  assert.strictEqual(gate.audit.length, 3);
  assert.strictEqual(gate.audit[0].stage, 'requested');
  assert.strictEqual(gate.audit[0].tool, 'nuke_records');

  assert.strictEqual(gate.audit[1].stage, 'confirmed');
  assert.strictEqual(gate.audit[1].tool, 'nuke_records');

  assert.strictEqual(gate.audit[2].stage, 'rejected');
  assert.strictEqual(gate.audit[2].reason, 'reused');
  assert.strictEqual(gate.audit[2].tool, 'nuke_records');

  // Verify onAudit callback received the same events
  assert.deepStrictEqual(auditEvents, gate.audit);
});

test('9. The examples/server.mjs handshake via the SDK Client over StreamableHTTPClientTransport works: initialize, then tools/list shows confirmToken in the schema, then the two-step call works end to end', async () => {
  const serverInstance = await createExampleServer({ port: 0 });
  const serverUrl = new URL(`http://127.0.0.1:${serverInstance.port}/mcp`);

  const clientTransport = new StreamableHTTPClientTransport(serverUrl);
  const client = new Client({
    name: 'test-mcp-client',
    version: '1.0.0'
  });

  try {
    // 1. Initialize handshake
    await client.connect(clientTransport);

    // 2. tools/list shows confirmToken in the schema
    const toolsResult = await client.listTools();
    const deleteTool = toolsResult.tools.find((t) => t.name === 'delete_record');
    assert.ok(deleteTool, 'delete_record tool must be present in tools/list');
    assert.ok(
      deleteTool.inputSchema?.properties?.confirmToken,
      'inputSchema must contain confirmToken property'
    );

    // 3. First call without confirmToken returns confirmation_required
    assert.strictEqual(serverInstance.records.has('rec_001'), true);
    const step1Result = await client.callTool({
      name: 'delete_record',
      arguments: { id: 'rec_001' }
    });

    assert.ok(step1Result.content?.[0]?.text);
    const step1Data = JSON.parse(step1Result.content[0].text);
    assert.strictEqual(step1Data.confirmation_required, true);
    assert.ok(typeof step1Data.confirmToken === 'string' && step1Data.confirmToken.length > 0);
    assert.strictEqual(serverInstance.records.has('rec_001'), true, 'Record must not be deleted after step 1');

    // 4. Second call with confirmToken executes deletion
    const step2Result = await client.callTool({
      name: 'delete_record',
      arguments: {
        id: 'rec_001',
        confirmToken: step1Data.confirmToken
      }
    });

    assert.ok(step2Result.content?.[0]?.text);
    const step2Data = JSON.parse(step2Result.content[0].text);
    assert.strictEqual(step2Data.success, true);
    assert.strictEqual(serverInstance.records.has('rec_001'), false, 'Record must be deleted after step 2');
  } finally {
    await client.close();
    await serverInstance.close();
  }
});
