/**
 * ExpenseSnap - Accounts & cloud copy (Firebase Authentication + Cloud Firestore)
 *
 * Signed out (the default): nothing changes. Receipts stay only on this device
 * and no Firebase code is even downloaded.
 *
 * Signed in: each person has a private account (email + password). Every
 * receipt and report is saved under users/{uid}/ in Cloud Firestore, so any
 * phone or laptop signed in to the same account sees the same receipts, even
 * if the other device was off when they were added.
 *
 * How it works, simply:
 * - The app keeps using its normal on-device database (js/store.js), one
 *   per account, so it works offline exactly like before.
 * - Every change made here goes into an "outbox" (saved on the device) and is
 *   uploaded when there is a connection. Firestore's own offline cache also
 *   keeps queued uploads across restarts.
 * - Changes from the cloud are copied back into this device's database.
 *   If both sides changed the same receipt, the newest change wins.
 * - Photos and PDFs are stored in Firestore too, split into pieces of about
 *   700 KB (Firestore documents can be at most 1 MB). No Cloud Storage
 *   bucket is needed, so the project can stay on the free Spark plan.
 */
(function () {
  const SDK_VERSION = '13.4.0';
  const SDK_URL = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;

  // From Firebase console > Project settings > General > Your apps > Web app.
  // These values are not secret; the security rules (firestore.rules) are
  // what keep each account's receipts private. Until apiKey and appId are
  // filled in, the Account section stays hidden and the app works as before.
  const FIREBASE_WEB_CONFIG = {
    apiKey: '',
    authDomain: 'expensesnap-jp.firebaseapp.com',
    projectId: 'expensesnap-jp',
    appId: ''
  };

  const UID_KEY = 'expensesnap_account_uid';
  const EMAIL_KEY = 'expensesnap_account_email';
  const EMULATOR_KEY = 'expensesnap_emulator';
  const LOCAL_DB_NAME = 'ExpenseSnapDB'; // the signed-out database
  const DEFAULT_REPORT_ID = 'rep_main';
  const CHUNK_CHARS = 700000;            // ~700 KB per piece, under Firestore's 1 MB limit
  const MAX_FILE_CHARS = 9 * 1024 * 1024; // one save must stay under Firestore's 10 MB limit
  const FILE_FIELDS = ['dataUrl', 'thumbnailDataUrl', 'rawArrayBuffer'];

  // Local testing only: on localhost, ?emulator (remembered) talks to the
  // Firebase Local Emulator Suite instead of the real project.
  function useEmulator() {
    if (!['localhost', '127.0.0.1'].includes(location.hostname)) return false;
    if (new URLSearchParams(location.search).has('emulator')) localStorage.setItem(EMULATOR_KEY, '1');
    return localStorage.getItem(EMULATOR_KEY) === '1';
  }

  function abToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
  }

  function base64ToAb(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  async function sha256(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest).slice(0, 16)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Firestore cannot store `undefined`
  function clean(obj) {
    const out = {};
    Object.keys(obj).forEach(k => { if (obj[k] !== undefined) out[k] = obj[k]; });
    return out;
  }

  const AUTH_ERRORS = {
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'Wrong email or password.',
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-email': 'Type your email address first.',
    'auth/missing-password': 'Type your password.',
    'auth/email-already-in-use': 'That email already has an account. Use Sign in instead.',
    'auth/weak-password': 'Use a password with at least 6 characters.',
    'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
    'auth/network-request-failed': 'No internet connection. Try again when you\'re online.',
    'auth/operation-not-allowed': 'Email sign-in isn\'t turned on yet in the Firebase console.',
    'auth/configuration-not-found': 'Email sign-in isn\'t turned on yet in the Firebase console.'
  };

  function friendlyError(err) {
    return AUTH_ERRORS[err && err.code] || ((err && err.message) || 'Something went wrong.');
  }

  class AccountManager {
    constructor() {
      this.uid = localStorage.getItem(UID_KEY) || null;
      this.email = localStorage.getItem(EMAIL_KEY) || '';
      this.emulator = useEmulator();
      this.configured = this.emulator || !!(FIREBASE_WEB_CONFIG.apiKey && FIREBASE_WEB_CONFIG.appId);
      this.fb = null;
      this._sdkPromise = null;
      this.outbox = { receipts: {}, reports: {} };
      this._seq = 0;
      this.remote = { reports: new Map(), receipts: new Map() };
      this.serverSeen = { reports: false, receipts: false };
      this.pendingWrites = false;
      this.mirrorStarted = false;
      this.unsubs = [];
      this.status = this.uid ? 'connecting' : 'signed-out';
      this.lastError = '';
      this.listeners = [];
      this._reconciling = null;
      this._reconcileAgain = false;
      this._flushing = null;
      this._flushAgain = false;
      this._outboxSave = Promise.resolve();
      this.signingOut = false;
    }

    isConfigured() { return this.configured; }
    isSignedIn() { return !!this.uid; }
    pendingCount() {
      return Object.keys(this.outbox.receipts).length + Object.keys(this.outbox.reports).length;
    }

    onChange(cb) { this.listeners.push(cb); cb(this.snapshot()); }
    snapshot() {
      return { configured: this.configured, signedIn: this.isSignedIn(), email: this.email,
        status: this.status, pending: this.pendingCount(), error: this.lastError };
    }
    _emit() { const s = this.snapshot(); this.listeners.forEach(cb => { try { cb(s); } catch (e) { console.error(e); } }); }
    _setStatus(status) { this.status = status; this._emit(); }

    // Called by app.js right after the on-device database opens. Never waits
    // for the network, so the app starts just as fast offline.
    async init() {
      if (!this.uid) return;
      const saved = await window.store.getMeta('cloudOutbox');
      if (saved && saved.value) this.outbox = { receipts: saved.value.receipts || {}, reports: saved.value.reports || {} };
      window.store.subscribe((event, data) => this._onLocalChange(event, data));
      window.addEventListener('online', () => { this._connect(); this.flush(); });
      window.addEventListener('offline', () => this._refreshStatus());
      this._connect();
    }

    // ---------- Firebase SDK (loaded only when needed, from Google's CDN) ----------
    _loadSdk() {
      if (this.fb) return Promise.resolve(this.fb);
      if (!this.configured) return Promise.reject(new Error('Accounts are not set up yet.'));
      if (!this._sdkPromise) {
        this._sdkPromise = (async () => {
          const [appMod, authMod, fsMod] = await Promise.all([
            import(`${SDK_URL}/firebase-app.js`),
            import(`${SDK_URL}/firebase-auth.js`),
            import(`${SDK_URL}/firebase-firestore.js`)
          ]);
          const config = this.emulator
            ? { apiKey: 'demo-key', authDomain: 'localhost', projectId: 'demo-expensesnap', appId: 'demo-app' }
            : FIREBASE_WEB_CONFIG;
          const app = appMod.initializeApp(config);
          const auth = authMod.getAuth(app);
          let db;
          try {
            db = fsMod.initializeFirestore(app, {
              localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() })
            });
          } catch (err) {
            console.warn('Firestore offline cache unavailable, using memory cache:', err);
            db = fsMod.getFirestore(app);
          }
          if (this.emulator) {
            const host = location.hostname;
            authMod.connectAuthEmulator(auth, `http://${host}:9099`, { disableWarnings: true });
            fsMod.connectFirestoreEmulator(db, host, 8181);
          }
          this.fb = { app, auth, db, A: authMod, F: fsMod };
          return this.fb;
        })().catch(err => { this._sdkPromise = null; throw err; });
      }
      return this._sdkPromise;
    }

    async _connect() {
      if (!this.uid || this._authUnsub) return;
      try {
        const { auth, A } = await this._loadSdk();
        if (this._authUnsub) return;
        this._authUnsub = A.onAuthStateChanged(auth, (user) => {
          if (this.signingOut) return;
          if (!user) {
            // The account was signed out elsewhere or removed. Go back to
            // local mode; this device's copy is kept, not deleted.
            this._useAccount(null);
            return;
          }
          if (user.uid !== this.uid) { this._useAccount(user); return; }
          this.email = user.email || this.email;
          localStorage.setItem(EMAIL_KEY, this.email);
          this._startMirror();
        });
      } catch (err) {
        // Usually: offline and the Firebase code isn't saved yet. The app
        // keeps working; changes wait in the outbox.
        console.warn('Account sync not available yet:', err);
        this._setStatus('offline');
      }
    }

    // Switch this device to an account (or back to local mode) and restart.
    _useAccount(user) {
      if (user) {
        localStorage.setItem(UID_KEY, user.uid);
        localStorage.setItem(EMAIL_KEY, user.email || '');
      } else {
        localStorage.removeItem(UID_KEY);
        localStorage.removeItem(EMAIL_KEY);
      }
      location.reload();
    }

    // ---------- Sign up / in / out / reset ----------
    async signUp(email, password) {
      const { auth, A } = await this._loadSdk();
      const cred = await A.createUserWithEmailAndPassword(auth, email.trim(), password);
      this._useAccount(cred.user);
    }

    async signIn(email, password) {
      const { auth, A } = await this._loadSdk();
      const cred = await A.signInWithEmailAndPassword(auth, email.trim(), password);
      this._useAccount(cred.user);
    }

    async resetPassword(email) {
      const { auth, A } = await this._loadSdk();
      await A.sendPasswordResetEmail(auth, email.trim());
    }

    // Signs out and removes this account's receipts from THIS device (they
    // stay safe in the account). Returns false if the user cancelled.
    async signOut({ confirmFn = (msg) => window.confirm(msg) } = {}) {
      const pending = this.pendingCount();
      if (pending > 0 && !confirmFn(`${pending} change(s) haven't uploaded yet. If you sign out now, they will be lost. Sign out anyway?`)) {
        return false;
      }
      this.signingOut = true;
      this.unsubs.forEach(u => u());
      this.unsubs = [];
      try {
        const { auth, A, db, F } = await this._loadSdk();
        await A.signOut(auth);
        await F.terminate(db);
        await F.clearIndexedDbPersistence(db).catch(() => {});
      } catch (err) {
        console.warn('Sign-out cleanup:', err);
      }
      const dbName = window.store.dbName;
      if (window.store.db) window.store.db.close();
      await new Promise(resolve => {
        const req = indexedDB.deleteDatabase(dbName);
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      this._useAccount(null);
      return true;
    }

    // ---------- Outbox: changes made on this device ----------
    _mark(kind, id, op) {
      if (!id) return;
      this.outbox[kind][id] = { op, seq: ++this._seq + Date.now() * 1000 };
    }

    async _onLocalChange(event, data) {
      if (!data) data = {};
      switch (event) {
        case 'receipt:added':
        case 'receipt:updated':
        case 'receipt:sync_upsert':
          this._mark('receipts', data.id, 'put');
          this._mark('reports', data.reportId, 'put');
          break;
        case 'receipt:deleted':
        case 'receipt:sync_deleted':
          this._mark('receipts', data.receiptId, 'del');
          this._mark('reports', data.reportId, 'put');
          break;
        case 'report:created':
        case 'report:updated':
          this._mark('reports', data.id, 'put');
          break;
        case 'receipts:reordered':
          this._mark('reports', data.reportId, 'put');
          break;
        case 'report:deleted':
          this._mark('reports', data.reportId, 'del');
          (data.receiptIds || []).forEach(id => this._mark('receipts', id, 'del'));
          break;
        case 'backup:restored':
        case 'sync:full_applied':
          (await window.store.getAllReports()).forEach(r => this._mark('reports', r.id, 'put'));
          (await window.store.getAllReceipts()).forEach(r => this._mark('receipts', r.id, 'put'));
          break;
        default:
          return;
      }
      await this._saveOutbox();
      this._refreshStatus();
      this.flush();
    }

    _saveOutbox() {
      this._outboxSave = this._outboxSave.then(() =>
        window.store.setMeta('cloudOutbox', { receipts: this.outbox.receipts, reports: this.outbox.reports })
      ).catch(err => console.error('Outbox save failed:', err));
      return this._outboxSave;
    }

    // Upload everything in the outbox. Safe to call any number of times.
    flush() {
      if (!this.mirrorStarted) return Promise.resolve();
      if (this._flushing) { this._flushAgain = true; return this._flushing; }
      this._flushing = (async () => {
        do {
          this._flushAgain = false;
          await this._flushOnce();
        } while (this._flushAgain);
      })().catch(err => {
        console.error('Upload failed:', err);
        this.lastError = 'Upload failed: ' + (err.message || err);
      }).finally(() => { this._flushing = null; this._refreshStatus(); });
      return this._flushing;
    }

    async _flushOnce() {
      const jobs = [];
      for (const kind of ['reports', 'receipts']) {
        for (const [id, entry] of Object.entries(this.outbox[kind])) {
          jobs.push(this._upload(kind, id, entry.op).then(() => {
            // Only clear it if nothing newer was queued meanwhile
            if (this.outbox[kind][id] && this.outbox[kind][id].seq === entry.seq) delete this.outbox[kind][id];
          }));
        }
      }
      if (!jobs.length) return;
      const results = await Promise.allSettled(jobs);
      results.filter(r => r.status === 'rejected').forEach(r => console.error('Upload error:', r.reason));
      await this._saveOutbox();
    }

    _userDoc(...path) {
      const { db, F } = this.fb;
      return F.doc(db, 'users', this.uid, ...path);
    }

    async _upload(kind, id, op) {
      const { db, F } = this.fb;
      if (kind === 'reports') {
        const ref = this._userDoc('reports', id);
        const report = op === 'put' ? await window.store.getReport(id) : null;
        if (report) return F.setDoc(ref, clean(report));
        return F.deleteDoc(ref);
      }

      const ref = this._userDoc('receipts', id);
      const receipt = op === 'put' ? await window.store.getReceipt(id) : null;
      const remote = this.remote.receipts.get(id);
      const batch = F.writeBatch(db);

      if (!receipt) {
        // Delete the receipt and all its file pieces
        let chunkIds = [];
        if (remote && remote.fileParts) {
          Object.entries(remote.fileParts).forEach(([field, n]) => {
            for (let i = 0; i < n; i++) chunkIds.push(`${field}_${i}`);
          });
        } else {
          const snap = await F.getDocs(F.collection(db, 'users', this.uid, 'receipts', id, 'chunks'));
          chunkIds = snap.docs.map(d => d.id);
        }
        chunkIds.forEach(cid => batch.delete(this._userDoc('receipts', id, 'chunks', cid)));
        batch.delete(ref);
        return batch.commit();
      }

      // Split the file fields from the rest of the receipt
      const files = {};
      const doc = {};
      Object.keys(receipt).forEach(k => {
        if (k === 'cloudFileHash') return;
        if (FILE_FIELDS.includes(k)) {
          const v = receipt[k];
          if (k === 'rawArrayBuffer') { if (v && v.byteLength) files[k] = abToBase64(v); }
          else if (v) files[k] = String(v);
        } else {
          doc[k] = receipt[k];
        }
      });
      const total = Object.values(files).reduce((n, s) => n + s.length, 0);
      if (total > MAX_FILE_CHARS) {
        this.lastError = `"${receipt.notes || receipt.fileName || 'A receipt'}" is too large to save to your account (over 9 MB). It stays on this device.`;
        this._emit();
        return; // dropped from the outbox; never retried
      }
      const hash = await sha256(FILE_FIELDS.map(f => f + ':' + (files[f] || '')).join('|'));
      const parts = {};
      if (!remote || remote.fileHash !== hash) {
        Object.entries(files).forEach(([field, str]) => {
          const n = Math.ceil(str.length / CHUNK_CHARS);
          parts[field] = n;
          for (let i = 0; i < n; i++) {
            batch.set(this._userDoc('receipts', id, 'chunks', `${field}_${i}`), { d: str.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS) });
          }
        });
        // Remove leftover pieces from an older, bigger version of the file
        if (remote && remote.fileParts) {
          Object.entries(remote.fileParts).forEach(([field, n]) => {
            for (let i = parts[field] || 0; i < n; i++) batch.delete(this._userDoc('receipts', id, 'chunks', `${field}_${i}`));
          });
        }
      } else {
        Object.assign(parts, remote.fileParts || {});
      }
      // The receipt and its pieces are saved together (all or nothing), so
      // another device never sees a receipt whose photo isn't there yet.
      batch.set(ref, clean({ ...doc, fileParts: parts, fileHash: hash }));
      await batch.commit();
      await window.store.patchReceiptQuietly(id, { cloudFileHash: hash });
    }

    // ---------- Mirror: changes coming from the cloud ----------
    _startMirror() {
      if (this.mirrorStarted) return;
      this.mirrorStarted = true;
      const { db, F } = this.fb;
      ['reports', 'receipts'].forEach(kind => {
        const col = F.collection(db, 'users', this.uid, kind);
        this.unsubs.push(F.onSnapshot(col, { includeMetadataChanges: true }, (snap) => {
          const map = this.remote[kind];
          map.clear();
          snap.docs.forEach(d => map.set(d.id, d.data()));
          if (!snap.metadata.fromCache) this.serverSeen[kind] = true;
          this.pendingWrites = snap.metadata.hasPendingWrites;
          this._reconcile();
          this._refreshStatus();
        }, (err) => {
          console.error('Cloud listener error:', err);
          this.lastError = err.code === 'permission-denied' ? 'The cloud refused access (security rules).' : (err.message || String(err));
          this._setStatus('error');
        }));
      });
      this.flush();
    }

    _reconcile() {
      if (this._reconciling) { this._reconcileAgain = true; return this._reconciling; }
      this._reconciling = (async () => {
        do {
          this._reconcileAgain = false;
          await this._reconcileOnce();
        } while (this._reconcileAgain);
      })().catch(err => console.error('Cloud apply failed:', err))
        .finally(() => { this._reconciling = null; this._refreshStatus(); });
      return this._reconciling;
    }

    async _reconcileOnce() {
      const st = window.store;
      const localReports = new Map((await st.getAllReports()).map(r => [r.id, r]));
      const localReceipts = new Map((await st.getAllReceipts()).map(r => [r.id, r]));
      const change = { putReports: [], putReceipts: [], delReports: [], delReceipts: [] };

      for (const [id, r] of this.remote.reports) {
        if (this.outbox.reports[id]) continue; // our own newer change is on its way up
        const local = localReports.get(id);
        if (!local || (r.updatedAt || 0) > (local.updatedAt || 0)) change.putReports.push(r);
      }
      for (const [id, r] of this.remote.receipts) {
        if (this.outbox.receipts[id]) continue;
        const local = localReceipts.get(id);
        if (local && (r.updatedAt || 0) <= (local.updatedAt || 0) && local.cloudFileHash === r.fileHash) continue;
        if (local && (r.updatedAt || 0) < (local.updatedAt || 0)) continue;
        const { fileParts, fileHash, ...fields } = r;
        let fileData;
        if (local && local.cloudFileHash === fileHash) {
          fileData = { dataUrl: local.dataUrl, thumbnailDataUrl: local.thumbnailDataUrl, rawArrayBuffer: local.rawArrayBuffer };
        } else {
          fileData = await this._downloadFile(id, fileParts || {});
          if (!fileData) continue; // pieces not there yet; try again next time
        }
        change.putReceipts.push({ ...fields, ...fileData, cloudFileHash: fileHash });
      }
      // Something here but not in the cloud, and not waiting to upload, was
      // deleted on another device. Only trusted once the server has answered.
      if (this.serverSeen.reports) {
        for (const id of localReports.keys()) {
          if (!this.remote.reports.has(id) && !this.outbox.reports[id] && id !== DEFAULT_REPORT_ID) change.delReports.push(id);
        }
      }
      if (this.serverSeen.receipts) {
        for (const id of localReceipts.keys()) {
          if (!this.remote.receipts.has(id) && !this.outbox.receipts[id]) change.delReceipts.push(id);
        }
      }
      await st.applyCloudChanges(change);
    }

    async _downloadFile(id, fileParts) {
      const { db, F } = this.fb;
      const out = { dataUrl: '', thumbnailDataUrl: '', rawArrayBuffer: null };
      const needed = Object.values(fileParts).reduce((a, b) => a + b, 0);
      if (!needed) return out;
      const snap = await F.getDocs(F.collection(db, 'users', this.uid, 'receipts', id, 'chunks'));
      const pieces = new Map(snap.docs.map(d => [d.id, d.data().d]));
      for (const [field, n] of Object.entries(fileParts)) {
        let s = '';
        for (let i = 0; i < n; i++) {
          const part = pieces.get(`${field}_${i}`);
          if (typeof part !== 'string') return null;
          s += part;
        }
        out[field] = field === 'rawArrayBuffer' ? base64ToAb(s) : s;
      }
      return out;
    }

    _refreshStatus() {
      if (!this.uid) return this._setStatus('signed-out');
      if (this.status === 'error') return this._emit();
      if (!navigator.onLine) return this._setStatus('offline');
      if (!this.mirrorStarted) return this._setStatus('connecting');
      if (this.pendingCount() > 0 || this.pendingWrites) return this._setStatus('uploading');
      if (!this.serverSeen.reports || !this.serverSeen.receipts) return this._setStatus('connecting');
      this._setStatus('synced');
    }

    // ---------- One-time move of signed-out receipts into the account ----------
    _openLocalOnlyDb() {
      return new Promise((resolve) => {
        const req = indexedDB.open(LOCAL_DB_NAME);
        // No signed-out database on this device: don't create an empty one
        req.onupgradeneeded = (e) => { e.target.transaction.abort(); };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(null);
        req.onblocked = () => resolve(null);
      });
    }

    _readAll(db, storeName) {
      return new Promise((resolve) => {
        if (!db.objectStoreNames.contains(storeName)) return resolve([]);
        const req = db.transaction(storeName, 'readonly').objectStore(storeName).getAll();
        req.onsuccess = () => resolve(req.result || []);
        req.onerror = () => resolve([]);
      });
    }

    // How many receipts saved while signed out could be moved in
    async localOnlyReceiptCount() {
      if (!this.uid) return 0;
      const db = await this._openLocalOnlyDb();
      if (!db) return 0;
      try {
        const meta = await this._readAll(db, 'meta');
        const moved = meta.find(m => m.key === 'movedToAccounts');
        if (moved && (moved.value || []).includes(this.uid)) return 0;
        return (await this._readAll(db, 'receipts')).length;
      } finally { db.close(); }
    }

    // Copies (does not delete) this device's signed-out receipts into the account
    async moveLocalReceiptsIntoAccount() {
      const db = await this._openLocalOnlyDb();
      if (!db) return 0;
      let reports, receipts;
      try {
        reports = await this._readAll(db, 'reports');
        receipts = await this._readAll(db, 'receipts');
        const meta = await this._readAll(db, 'meta');
        const moved = (meta.find(m => m.key === 'movedToAccounts') || {}).value || [];
        await new Promise((resolve, reject) => {
          const tx = db.transaction('meta', 'readwrite');
          tx.objectStore('meta').put({ key: 'movedToAccounts', value: [...new Set([...moved, this.uid])] });
          tx.oncomplete = resolve; tx.onerror = () => reject(tx.error);
        });
      } finally { db.close(); }
      const now = Date.now();
      const st = window.store;
      await st.applyCloudChanges({
        putReports: reports.map(r => ({ ...r, updatedAt: now })),
        putReceipts: receipts.map(r => { const { cloudFileHash, ...rest } = r; return { ...rest, updatedAt: now }; })
      });
      reports.forEach(r => this._mark('reports', r.id, 'put'));
      receipts.forEach(r => this._mark('receipts', r.id, 'put'));
      await this._saveOutbox();
      this._refreshStatus();
      this.flush();
      return receipts.length;
    }
  }

  window.accountManager = new AccountManager();
  window.accountManager.friendlyError = friendlyError;
})();
