/** In-process progress tracker for the one-time sent-mail mining run. */
export interface MiningSnapshot {
  running: boolean;
  total: number;
  done: number;
}

export class MiningJob {
  private _running = false;
  private _total = 0;
  private _done = 0;

  get running(): boolean {
    return this._running;
  }

  start(total: number): void {
    this._running = true;
    this._total = total;
    this._done = 0;
  }

  tick(): void {
    this._done += 1;
  }

  finish(): void {
    this._running = false;
  }

  snapshot(): MiningSnapshot {
    return { running: this._running, total: this._total, done: this._done };
  }
}
