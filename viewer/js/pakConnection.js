// ─── WebSocket client for alicia-editor PAK server ──────────────────────────

const DEFAULT_URL = 'ws://localhost:8083';

export class PakConnection {
  constructor(url = DEFAULT_URL) {
    this.url = url;
    this.ws = null;
    this._pending = [];     // queue of { resolve, reject, wantBinary }
    this._binaryHeader = null; // stashed JSON header preceding a binary frame
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.binaryType = 'arraybuffer';

      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error('WebSocket connection failed'));
      this.ws.onclose = () => {
        // Reject any pending requests.
        for (const p of this._pending) p.reject(new Error('Connection closed'));
        this._pending = [];
      };

      this.ws.onmessage = (event) => this._onMessage(event);
    });
  }

  disconnect() {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  get connected() {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // Ask the server to open a PAK file (triggers native file dialog).
  // Returns the asset listing: { action, path, data: [{path, size, ...}] }
  openPak() {
    return this._sendJSON({ action: 'read' }, false);
  }

  // Fetch a single asset's binary data by its PAK path.
  // Returns an ArrayBuffer with the decompressed data.
  fetchAsset(path) {
    return this._sendJSON({ action: 'fetch', path }, true);
  }

  // Ask the editor server to open a native file picker and add/replace
  // an asset in the in-memory PAK.
  // Returns a fresh listing payload: { action, path, data, message }.
  addAssetFromFile(path, options = {}) {
    const payload = { action: 'add_asset_from_file', path };
    if (typeof options.isCompressed === 'boolean') {
      payload.is_compressed = options.isCompressed;
    }
    return this._sendJSON(payload, false);
  }

  // Ask the editor server to export the currently loaded PAK to a new file.
  // Returns: { action: "exported", path: "..." }.
  exportPak() {
    return this._sendJSON({ action: 'export' }, false);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _sendJSON(obj, wantBinary) {
    return new Promise((resolve, reject) => {
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }
      this._pending.push({ resolve, reject, wantBinary });
      this.ws.send(JSON.stringify(obj));
    });
  }

  _onMessage(event) {
    if (event.data instanceof ArrayBuffer) {
      // Binary frame — this is the asset data following a JSON header.
      const pending = this._pending.shift();
      if (pending) {
        pending.resolve(event.data);
      }
      this._binaryHeader = null;
      return;
    }

    // Text frame — parse as JSON.
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.action === 'error') {
      const pending = this._pending.shift();
      if (pending) pending.reject(new Error(msg.message));
      return;
    }

    if (msg.action === 'asset_data') {
      // This is just the header before the binary frame — stash it and wait.
      this._binaryHeader = msg;
      return;
    }

    // Any other JSON response (e.g. asset_listing) resolves the pending request.
    const pending = this._pending.shift();
    if (pending) pending.resolve(msg);
  }
}
