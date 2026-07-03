import type { CidrEntry } from './geoip';
import type { DomainEntry } from './geosite';

export type WorkerRequest =
  | { id: number; type: 'matchDomain'; domain: string }
  | { id: number; type: 'matchIp'; ip: string }
  | { id: number; type: 'listGeoSiteCategories' }
  | { id: number; type: 'listGeoIpCategories' }
  | { id: number; type: 'getCategoryDomains'; category: string }
  | { id: number; type: 'getCategoryCidrs'; category: string }
  | { id: number; type: 'refreshCache' };

export type ProgressStage = 'downloading' | 'parsing' | 'ready';
export type ProgressMessage = { type: 'progress'; kind: 'geosite' | 'geoip'; stage: ProgressStage };

export type RpcResponse = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
export type WorkerResponse = RpcResponse | ProgressMessage;

// Plain `Omit<Union, K>` collapses a discriminated union down to its common
// keys; this distributes the Omit over each union member instead.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type PendingCall = { resolve: (value: unknown) => void; reject: (reason: Error) => void };

export class GeodataClient {
  private worker: Worker;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private progressListeners = new Set<(p: ProgressMessage) => void>();

  constructor() {
    this.worker = new Worker(new URL('../../workers/geodata.worker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => this.handleMessage(e.data);
  }

  private handleMessage(msg: WorkerResponse): void {
    if (!('id' in msg)) {
      for (const listener of this.progressListeners) listener(msg);
      return;
    }
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.ok) pending.resolve(msg.result);
    else pending.reject(new Error(msg.error));
  }

  private call<T>(request: DistributiveOmit<WorkerRequest, 'id'>): Promise<T> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.worker.postMessage({ ...request, id } as WorkerRequest);
    });
  }

  matchDomain(domain: string): Promise<string[]> {
    return this.call({ type: 'matchDomain', domain });
  }

  matchIp(ip: string): Promise<string[]> {
    return this.call({ type: 'matchIp', ip });
  }

  listGeoSiteCategories(): Promise<string[]> {
    return this.call({ type: 'listGeoSiteCategories' });
  }

  listGeoIpCategories(): Promise<string[]> {
    return this.call({ type: 'listGeoIpCategories' });
  }

  getCategoryDomains(category: string): Promise<DomainEntry[]> {
    return this.call({ type: 'getCategoryDomains', category });
  }

  getCategoryCidrs(category: string): Promise<CidrEntry[]> {
    return this.call({ type: 'getCategoryCidrs', category });
  }

  refreshCache(): Promise<void> {
    return this.call({ type: 'refreshCache' });
  }

  onProgress(cb: (p: ProgressMessage) => void): () => void {
    this.progressListeners.add(cb);
    return () => this.progressListeners.delete(cb);
  }

  terminate(): void {
    this.worker.terminate();
  }
}
