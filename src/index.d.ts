export type AuditStage = 'requested' | 'confirmed' | 'rejected';
export type RejectReason = 'expired' | 'reused' | 'args_mismatch' | 'unknown_token';

export interface AuditEntry {
  tool: string;
  argsHash: string;
  stage: AuditStage;
  reason?: RejectReason;
  at: number;
}

export interface Store {
  get(key: string): Promise<any> | any;
  set(key: string, value: any): Promise<any> | any;
  delete(key: string): Promise<any> | any;
}

export interface ConfirmGateOptions {
  ttlMs?: number;
  secret?: string | Buffer;
  now?: () => number;
  store?: Store | Map<string, any>;
  onAudit?: (entry: AuditEntry) => void;
}

export interface CallToolResult {
  content: Array<{ type: 'text'; text: string; [key: string]: unknown }>;
  isError?: boolean;
  reason?: RejectReason;
  confirmation_required?: boolean;
  prompt?: string;
  confirmToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface ConfirmGate {
  readonly ttlMs: number;
  readonly secret: Buffer;
  readonly now: () => number;
  readonly store: Store;
  readonly audit: AuditEntry[];
  readonly inputSchemaExtension: Record<string, unknown>;
  wrap<TArgs = Record<string, unknown>, TExtra = unknown>(
    name: string,
    describeAction: (args: TArgs) => string,
    handler: (args: TArgs, extra?: TExtra) => Promise<CallToolResult>
  ): (args?: TArgs & { confirmToken?: string }, extra?: TExtra) => Promise<CallToolResult>;
}

export function createConfirmGate(options?: ConfirmGateOptions): ConfirmGate;
export default createConfirmGate;

export function withConfirmToken<T extends Record<string, unknown>>(schema?: T): T & Record<string, unknown>;

export const inputSchemaExtension: Record<string, unknown>;

export function canonicalJson(value: unknown): string;

export function hashArgs(args: Record<string, unknown> | null | undefined): string;
