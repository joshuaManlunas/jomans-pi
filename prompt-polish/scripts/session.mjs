import { addPolishHistoryItem, polishPrompt } from './polish.mjs';
import { copyPromptText } from './clipboard.mjs';

// A host-neutral draft/history controller. The host owns UI and storage.
export class PolishSession {
  constructor({ readDraft, writeDraft, saveHistory, notify = () => {}, complete = polishPrompt, writeClipboard } = {}) {
    this.readDraft = readDraft;
    this.writeDraft = writeDraft;
    this.saveHistory = saveHistory;
    this.notify = notify;
    this.complete = complete;
    this.writeClipboard = writeClipboard;
    this.generation = 0;
    this.submission = 0;
    this.start();
  }

  start(items = []) {
    this.invalidate();
    this.history = [];
    // Storage is oldest-first; replay preserves the extension's newest-first view.
    for (const item of items) {
      if (item && typeof item.original === 'string' && typeof item.improved === 'string' && item.improved.trim()) {
        this.history = addPolishHistoryItem(this.history, {
          original: item.original, improved: item.improved,
          timestamp: typeof item.timestamp === 'number' ? item.timestamp : 0,
        });
      }
    }
    this.polished = this.history[0]?.improved;
    this.controlsVisible = this.polished !== undefined;
    this.expanded = false;
    this.persistenceAvailable = true;
  }

  invalidate() {
    this.generation++;
    this.controller?.abort();
    this.controller = undefined;
    this.running = false;
  }

  stop() { this.start(); }

  submit() {
    this.submission++;
    this.expanded = false;
    this.controlsVisible = false;
  }

  preview() {
    if (this.polished === undefined) {
      this.notify('Polish a prompt first', 'info');
      return undefined;
    }
    this.controlsVisible = true;
    this.expanded = !this.expanded;
    return this.polished;
  }

  async copy() {
    if (this.polished === undefined) {
      this.notify('Polish a prompt first', 'info');
      return false;
    }
    return copyPromptText(this.polished, this.notify, this.writeClipboard);
  }

  restore(index) {
    const item = this.history[index];
    if (!item) return undefined;
    this.polished = item.improved;
    this.controlsVisible = true;
    this.writeDraft?.(item.improved);
    this.notify('Polished prompt restored', 'info');
    return item.improved;
  }

  async polish(context, options = {}) {
    if (this.running) {
      this.notify('Prompt improvement already running', 'info');
      return undefined;
    }
    const original = this.readDraft?.();
    if (typeof original !== 'string' || !original.trim()) {
      this.notify('Enter a prompt first', 'info');
      return undefined;
    }
    const generation = this.generation;
    const submission = this.submission;
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (context.signal?.aborted) abort();
    else context.signal?.addEventListener('abort', abort, { once: true });
    this.controller = controller;
    this.running = true;
    try {
      const improved = await this.complete(original, { ...context, signal: controller.signal }, options);
      if (generation !== this.generation) return undefined;
      const changed = this.readDraft() !== original;
      this.polished = improved;
      this.history = addPolishHistoryItem(this.history, { original, improved, timestamp: Date.now() });
      if (this.persistenceAvailable) {
        try {
          if (!this.saveHistory) throw new Error('No storage');
          // Keep persistence synchronous to avoid stale writes across session changes.
          const saved = this.saveHistory([...this.history].reverse());
          if (saved && typeof saved.then === 'function') {
            // Consume rejections, but reject asynchronous persistence as unsupported.
            Promise.resolve(saved).catch(() => {});
            throw new Error('saveHistory must be synchronous');
          }
        } catch {
          this.persistenceAvailable = false;
          this.notify('Prompt history is memory-only; it could not be saved to this session', 'warning');
        }
      }
      if (!changed) this.writeDraft?.(improved);
      this.controlsVisible = submission === this.submission;
      this.notify(changed ? 'Editor changed; improved prompt was saved to history but not applied' : 'Prompt improved', changed ? 'warning' : 'info');
      return improved;
    } catch (error) {
      if (generation === this.generation) this.notify(`Prompt improvement failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
      return undefined;
    } finally {
      context.signal?.removeEventListener('abort', abort);
      if (this.controller === controller) {
        this.controller = undefined;
        this.running = false;
      }
    }
  }
}
