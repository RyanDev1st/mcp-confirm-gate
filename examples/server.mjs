import http from 'node:http';
import crypto from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConfirmGate, withConfirmToken } from '../src/index.mjs';

/**
 * Creates and starts a minimal Streamable HTTP MCP server with a guarded delete_record tool.
 *
 * @param {object} [options]
 * @param {number} [options.port=0]
 * @param {object} [options.gate]
 * @returns {Promise<{ server: http.Server, mcpServer: Server, transport: StreamableHTTPServerTransport, port: number, gate: object, records: Set<string>, close: () => Promise<void> }>}
 */
export async function createExampleServer(options = {}) {
  const {
    port = 0,
    gate = createConfirmGate({ ttlMs: 60000 })
  } = options;

  // In-memory records state
  const records = new Set(['rec_001', 'rec_002', 'rec_003']);

  const mcpServer = new Server({
    name: 'mcp-confirm-gate-example-server',
    version: '1.0.0'
  }, {
    capabilities: {
      tools: {}
    }
  });

  const baseSchema = {
    type: 'object',
    properties: {
      id: {
        type: 'string',
        description: 'The record identifier to delete'
      }
    },
    required: ['id']
  };

  const toolInputSchema = withConfirmToken(baseSchema);

  // Wrapped delete_record handler behind confirm gate
  const deleteRecordHandler = gate.wrap(
    'delete_record',
    (args) => `Permanently delete record ${args.id} from database`,
    async (args) => {
      const { id } = args;
      if (!records.has(id)) {
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ success: false, message: `Record ${id} not found` })
            }
          ]
        };
      }
      records.delete(id);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ success: true, message: `Record ${id} deleted successfully` })
          }
        ]
      };
    }
  );

  // MCP ListTools handler
  mcpServer.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: 'delete_record',
          description: 'Permanently deletes a record. Requires confirmation before deletion occurs.',
          inputSchema: toolInputSchema
        }
      ]
    };
  });

  // MCP CallTool handler
  mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    if (name === 'delete_record') {
      return await deleteRecordHandler(args);
    }
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: `Unknown tool: ${name}`
        }
      ]
    };
  });

  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID()
  });

  await mcpServer.connect(transport);

  const server = http.createServer(async (req, res) => {
    await transport.handleRequest(req, res);
  });

  await new Promise((resolve) => {
    server.listen(port, resolve);
  });

  const boundPort = server.address().port;

  const close = async () => {
    await transport.close();
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  };

  return {
    server,
    mcpServer,
    transport,
    port: boundPort,
    gate,
    records,
    close
  };
}

// Start standalone if executed directly
if (process.argv[1] && (process.argv[1].endsWith('server.mjs') || process.argv[1].endsWith('server.js'))) {
  const listenPort = parseInt(process.env.PORT || '3000', 10);
  const instance = await createExampleServer({ port: listenPort });
  console.log(`Streamable HTTP MCP Example Server running at http://localhost:${instance.port}/mcp`);
}
