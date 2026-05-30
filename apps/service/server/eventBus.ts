import { EventEmitter } from 'node:events';

export type ServerEvent =
  | { type: 'thread:updated'; payload: unknown }
  | { type: 'draft:ready'; payload: unknown }
  | { type: 'account:status'; payload: unknown }
  | { type: 'sync:progress'; payload: unknown };

/** In-process pub/sub feeding the SSE endpoint. Domain events are emitted in later phases. */
export class EventBus {
  private readonly emitter = new EventEmitter();

  emit(event: ServerEvent): void {
    this.emitter.emit('event', event);
  }

  subscribe(listener: (event: ServerEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }
}
