import { createHmac, randomBytes } from 'node:crypto';
import { canonicalJson, hashArgs } from './canonical-json.mjs';

/**
 * Re-export canonical JSON and argument hashing utilities.
 */
export { canonicalJson, hashArgs };

/**
 * Schema fragment adding the optional `confirmToken` parameter.
 */
export const inputSchemaExtension = Object.freeze({
  type: 'object',
  properties: {
    confirmToken: {
      type: 'string',
      description: 'Confirmation token issued by the server. Required to execute this action.'
    }
  }
});

/**
 * Helper to merge `confirmToken` into an MCP tool's inputSchema.
 *
 * @param {Record<string, unknown>} [schema={}]
 * @returns {Record<string, unknown>}
 */
export function withConfirmToken(schema = {}) {
  const existingProperties = (schema && schema.properties) ? schema.properties : {};
  return {
    ...schema,
    type: schema?.type || 'object',
    properties: {
      ...existingProperties,
      confirmToken: {
        type: 'string',
        description: 'Confirmation token issued by the server. Required to execute this action.'
      }
    }
  };
}

/**
 * Normalizes an injectable store interface or default in-memory Map.
 *
 * @param {any} store
 * @returns {{ get(key: string): Promise<any> | any, set(key: string, value: any): Promise<any> | any, delete(key: string): Promise<any> | any }}
 */
function normalizeStore(store) {
  if (!store) {
    const map = new Map();
    return {
      get: (key) => map.get(key),
      set: (key, value) => map.set(key, value),
      delete: (key) => map.delete(key)
    };
  }
  return {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
    delete: (key) => store.delete(key)
  };
}

/**
 * Creates an MCP confirmation gate instance.
 *
 * @param {object} [options]
 * @param {number} [options.ttlMs=120000] - Token time-to-live in milliseconds
 * @param {string | Buffer} [options.secret] - Cryptographic secret for HMAC-SHA256
 * @param {() => number} [options.now=Date.now] - Clock function
 * @param {object} [options.store] - Storage adapter { get, set, delete }
 * @param {(entry: object) => void} [options.onAudit] - Audit event callback
 * @returns {object} Gate instance
 */
export function createConfirmGate(options = {}) {
  const {
    ttlMs = 120000,
    secret,
    now = Date.now,
    store: rawStore,
    onAudit
  } = options;

  const secretKey = secret
    ? (Buffer.isBuffer(secret) ? secret : Buffer.from(String(secret), 'utf8'))
    : randomBytes(32);

  const store = normalizeStore(rawStore);
  const audit = [];

  const gate = {
    ttlMs,
    secret: secretKey,
    now,
    store,
    audit,
    inputSchemaExtension,

    /**
     * Wraps an MCP tool handler with a two-step confirmation guard.
     *
     * @param {string} name - Tool name
     * @param {(args: Record<string, unknown>) => string} describeAction - Function describing the action to human
     * @param {(args: Record<string, unknown>, extra?: any) => Promise<any>} handler - Target tool implementation
     * @returns {(args?: Record<string, unknown>, extra?: any) => Promise<any>}
     */
    wrap(name, describeAction, handler) {
      if (typeof name !== 'string' || !name) {
        throw new TypeError('Tool name must be a non-empty string');
      }
      if (typeof describeAction !== 'function') {
        throw new TypeError('describeAction must be a function');
      }
      if (typeof handler !== 'function') {
        throw new TypeError('handler must be a function');
      }

      return async function wrappedToolHandler(args = {}, extra) {
        const rawArgs = args || {};
        const confirmToken = rawArgs.confirmToken;
        const cleanArgs = { ...rawArgs };
        delete cleanArgs.confirmToken;

        const currentArgsHash = hashArgs(rawArgs);
        const currentTime = typeof now === 'function' ? now() : Date.now();

        const reject = (reason, recordedHash = currentArgsHash) => {
          const auditEntry = {
            tool: name,
            argsHash: recordedHash,
            stage: 'rejected',
            reason,
            at: currentTime
          };
          gate.audit.push(auditEntry);
          if (typeof onAudit === 'function') {
            onAudit(auditEntry);
          }

          const errorPayload = {
            isError: true,
            reason,
            error: `Confirmation failed: ${reason}`
          };

          return {
            isError: true,
            reason,
            content: [
              {
                type: 'text',
                text: JSON.stringify(errorPayload)
              }
            ]
          };
        };

        // Flow (1): Call without confirmToken
        if (!confirmToken || typeof confirmToken !== 'string' || confirmToken.trim() === '') {
          const nonce = randomBytes(16).toString('hex');
          const expiresAt = currentTime + ttlMs;
          const dataToSign = `${name}:${currentArgsHash}:${nonce}:${expiresAt}`;
          const signature = createHmac('sha256', secretKey).update(dataToSign).digest('hex');
          const issuedToken = `${nonce}.${expiresAt}.${signature}`;

          const record = {
            tool: name,
            argsHash: currentArgsHash,
            nonce,
            expiresAt,
            signature,
            used: false
          };
          await store.set(issuedToken, record);

          const auditEntry = {
            tool: name,
            argsHash: currentArgsHash,
            stage: 'requested',
            at: currentTime
          };
          gate.audit.push(auditEntry);
          if (typeof onAudit === 'function') {
            onAudit(auditEntry);
          }

          const prompt = describeAction(cleanArgs);
          const responsePayload = {
            confirmation_required: true,
            prompt,
            confirmToken: issuedToken,
            expiresAt
          };

          return {
            ...responsePayload,
            content: [
              {
                type: 'text',
                text: JSON.stringify(responsePayload)
              }
            ]
          };
        }

        // Flow (2) & (3): Call with confirmToken
        const record = await store.get(confirmToken);
        if (!record || typeof record !== 'object') {
          return reject('unknown_token');
        }

        // Validate HMAC signature of stored record
        const expectedData = `${record.tool}:${record.argsHash}:${record.nonce}:${record.expiresAt}`;
        const expectedSig = createHmac('sha256', secretKey).update(expectedData).digest('hex');
        if (record.signature !== expectedSig) {
          return reject('unknown_token', record.argsHash);
        }

        // Check if already used
        if (record.used) {
          return reject('reused', record.argsHash);
        }

        // Check expiration
        if (currentTime >= record.expiresAt) {
          return reject('expired', record.argsHash);
        }

        // Check tool name and canonical arguments match
        if (record.tool !== name || record.argsHash !== currentArgsHash) {
          return reject('args_mismatch', record.argsHash);
        }

        // Valid confirmation: mark token as used
        record.used = true;
        await store.set(confirmToken, record);

        const auditEntry = {
          tool: name,
          argsHash: currentArgsHash,
          stage: 'confirmed',
          at: currentTime
        };
        gate.audit.push(auditEntry);
        if (typeof onAudit === 'function') {
          onAudit(auditEntry);
        }

        // Run the underlying handler
        Object.defineProperty(cleanArgs, 'confirmToken', {
          value: confirmToken,
          enumerable: false,
          configurable: true,
          writable: true
        });

        return await handler(cleanArgs, extra);
      };
    }
  };

  return gate;
}

export default createConfirmGate;
