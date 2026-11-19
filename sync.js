/* ATOM Habits - data model, merge and GitHub sync.
 *
 * Everything lives in one JSON file (habits.json) on the `data` branch of your private
 * repo, read and written through the GitHub contents API with a token you paste into
 * Settings on each device. The token is kept only in this device's storage - it is never
 * part of the app's code.
 *
 * Document:
 *   { v: 1,
 *     habits:   { <id>: { id, name, description, icon, color, type: "build"|"quit",
 *                         goal: { period: "none"|"day"|"week"|"month", count },
 *                         perDay, archived, order, createdAt, updatedAt, deleted? } },
 *     days:     { <habit id>: { "YYYY-MM-DD": [count, updatedAt, note?] } },
 *     settings: { weekStart: 1 (Mon) | 0 (Sun), updatedAt } }
 *
 * Merging two copies never loses a change: each habit and each (habit, day) keeps the copy
 * with the newer updatedAt. Deleting a habit leaves a { deleted: true } tombstone so the
 * delete wins over an older copy on another device. atom_habits.py merges the same way.
 */
(function () {
  "use strict";

  const BRANCH = "data";
  const FILE = "habits.json";

  function emptyDoc() {
    return { v: 1, habits: {}, days: {}, settings: { weekStart: 1, updatedAt: 0 } };
  }

  function normalize(doc) {
    const d = doc && typeof doc === "object" ? doc : {};
    return {
      v: 1,
      habits: d.habits && typeof d.habits === "object" ? d.habits : {},
      days: d.days && typeof d.days === "object" ? d.days : {},
      settings: Object.assign({ weekStart: 1, updatedAt: 0 }, d.settings || {}),
    };
  }

  function newer(a, b, stamp) {
    if (!a) return b;
    if (!b) return a;
    const ta = stamp(a), tb = stamp(b);
    if (ta !== tb) return ta > tb ? a : b;
    // same timestamp: pick deterministically so every device ends up identical
    return JSON.stringify(a) >= JSON.stringify(b) ? a : b;
  }

  function merge(a, b) {
    a = normalize(a);
    b = normalize(b);
    const out = emptyDoc();
    for (const id of new Set([...Object.keys(a.habits), ...Object.keys(b.habits)])) {
      out.habits[id] = newer(a.habits[id], b.habits[id], (h) => h.updatedAt || 0);
    }
    for (const id of new Set([...Object.keys(a.days), ...Object.keys(b.days)])) {
      const da = a.days[id] || {}, db = b.days[id] || {}, m = {};
      for (const day of new Set([...Object.keys(da), ...Object.keys(db)])) {
        m[day] = newer(da[day], db[day], (v) => v[1] || 0);
      }
      out.days[id] = m;
    }
    out.settings = newer(a.settings, b.settings, (s) => s.updatedAt || 0);
    return out;
  }

  function same(a, b) {
    return JSON.stringify(canon(a)) === JSON.stringify(canon(b));
  }

  function canon(v) {                       // key-sorted copy, for comparisons
    if (Array.isArray(v)) return v.map(canon);
    if (v && typeof v === "object") {
      const o = {};
      for (const k of Object.keys(v).sort()) o[k] = canon(v[k]);
      return o;
    }
    return v;
  }

  // ---- base64 <-> UTF-8 ----------------------------------------------------------------
  function b64decode(s) {
    const bin = atob(s.replace(/\s/g, ""));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  function b64encode(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }

  // ---- GitHub ------------------------------------------------------------------------
  class SyncError extends Error {
    constructor(message, kind) {
      super(message);
      this.kind = kind;                       // "auth" | "missing" | "network" | "conflict" | "other"
    }
  }

  class GitHubStore {
    constructor(repo, token) {
      this.repo = repo;                       // "owner/name"
      this.token = token;
    }

    async _req(method, body) {
      const url = `https://api.github.com/repos/${this.repo}/contents/${FILE}` +
        (method === "GET" ? `?ref=${BRANCH}&t=${Date.now()}` : "");
      let res;
      try {
        res = await fetch(url, {
          method,
          cache: "no-store",
          headers: {
            Authorization: `Bearer ${this.token}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
            ...(body ? { "Content-Type": "application/json" } : {}),
          },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch (e) {
        throw new SyncError("Offline - changes are saved on this device", "network");
      }
      if (res.status === 401) throw new SyncError("Token rejected - paste a new one in Settings", "auth");
      if (res.status === 403) {
        const t = await res.text();
        if (/rate limit/i.test(t)) throw new SyncError("GitHub rate limit - retrying soon", "network");
        throw new SyncError("Token can't access the repo (needs Contents: read & write)", "auth");
      }
      if (res.status === 404) throw new SyncError("Repo or data branch not found - check Settings", "missing");
      if (res.status === 409 || res.status === 422) throw new SyncError("conflict", "conflict");
      if (!res.ok) throw new SyncError(`GitHub error ${res.status}`, "other");
      return res.json();
    }

    async load() {
      const r = await this._req("GET");
      let text;
      if (r.content) text = b64decode(r.content);
      else if (r.download_url) {             // files over 1 MB come without inline content
        const raw = await fetch(r.git_url, { cache: "no-store", headers: {
          Authorization: `Bearer ${this.token}`, Accept: "application/vnd.github.raw+json" } });
        text = await raw.text();
      } else text = "{}";
      return { doc: normalize(JSON.parse(text || "{}")), sha: r.sha };
    }

    async save(doc, sha, message) {
      const body = { message, branch: BRANCH, sha,
                     content: b64encode(JSON.stringify(canon(doc), null, 1) + "\n") };
      const r = await this._req("PUT", body);
      return r.content.sha;
    }
  }

  /* Keeps a local copy (works offline), pushes your changes, and pulls everyone else's.
   * onChange(doc) fires whenever the local copy changes because of a pull. */
  class Syncer {
    constructor({ storageKey, onChange, onStatus, device }) {
      this.key = storageKey;
      this.onChange = onChange;
      this.onStatus = onStatus;
      this.device = device;
      this.doc = this._read("doc") ? normalize(this._read("doc")) : emptyDoc();
      this.dirty = !!this._read("dirty");
      this.lastSync = this._read("lastSync") || 0;
      this.busy = null;
      this.pushTimer = null;
      this.pendingMsg = [];
      this.status = { state: "idle", text: "" };
      this.rev = 0;                           // bumped on every local edit
    }

    _read(k) {
      try { return JSON.parse(localStorage.getItem(`${this.key}.${k}`)); } catch (e) { return null; }
    }
    _write(k, v) {
      try { localStorage.setItem(`${this.key}.${k}`, JSON.stringify(v)); } catch (e) { /* private mode */ }
    }

    get config() {
      return this._read("config") || { repo: "", token: "" };
    }
    set config(c) {
      this._write("config", c);
    }
    get connected() {
      const c = this.config;
      return !!(c.repo && c.token);
    }

    _setStatus(state, text) {
      this.status = { state, text };
      if (this.onStatus) this.onStatus(this.status);
    }

    /* Apply a local edit: mutate(doc) changes the document; we save it and schedule a push. */
    change(mutate, message) {
      mutate(this.doc);
      this.rev++;
      this.dirty = true;
      this._write("doc", this.doc);
      this._write("dirty", true);
      if (message) this.pendingMsg.push(message);
      clearTimeout(this.pushTimer);
      this.pushTimer = setTimeout(() => this.sync(), 700);
    }

    replaceAll(doc) {                         // import
      this.doc = normalize(doc);
      this.rev++;
      this.dirty = true;
      this._write("doc", this.doc);
      this._write("dirty", true);
      return this.sync();
    }

    /* Pull, merge, and push if we have anything the server doesn't. Never runs twice at once. */
    sync() {
      if (!this.connected) {
        this._setStatus("local", "Not connected - saved on this device only");
        return Promise.resolve();
      }
      if (this.busy) {
        this.again = true;
        return this.busy;
      }
      this.busy = this._sync().finally(() => {
        this.busy = null;
        if (this.again) {
          this.again = false;
          this.sync();
        }
      });
      return this.busy;
    }

    async _sync() {
      const { repo, token } = this.config;
      const store = new GitHubStore(repo, token);
      this._setStatus("syncing", "Syncing…");
      try {
        for (let attempt = 0; attempt < 5; attempt++) {
          const remote = await store.load();
          const rev = this.rev;
          const before = JSON.stringify(canon(this.doc));
          const merged = merge(remote.doc, this.doc);
          const needPush = !same(merged, remote.doc);
          if (needPush) {
            const msgs = this.pendingMsg.splice(0);
            const msg = (msgs.length ? msgs.slice(0, 3).join(", ") + (msgs.length > 3 ? "…" : "")
                         : "Sync") + ` · ${this.device}`;
            try {
              await store.save(merged, remote.sha, msg);
            } catch (e) {
              if (e.kind === "conflict") {           // someone saved in between: merge again
                this.pendingMsg.unshift(...msgs);
                continue;
              }
              this.pendingMsg.unshift(...msgs);
              throw e;
            }
          }
          // edits made while we were talking to GitHub stay dirty for the next round
          const editedMeanwhile = this.rev !== rev;
          this.doc = merge(this.doc, merged);
          this.dirty = editedMeanwhile;
          this._write("doc", this.doc);
          this._write("dirty", this.dirty);
          this.lastSync = Date.now();
          this._write("lastSync", this.lastSync);
          if (before !== JSON.stringify(canon(this.doc)) && this.onChange) this.onChange(this.doc);
          this._setStatus("ok", "Synced");
          if (editedMeanwhile) this.again = true;
          return;
        }
        throw new SyncError("Kept colliding with another device - will retry", "network");
      } catch (e) {
        this._setStatus(e.kind === "auth" || e.kind === "missing" ? "error" : "offline", e.message);
      }
    }
  }

  window.HabitSync = { merge, normalize, emptyDoc, same, Syncer, GitHubStore, SyncError };
})();
