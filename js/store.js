/**
 * ExpenseSnap - Storage & State Management (IndexedDB + Cloud Sync)
 */

class ExpenseStore {
  constructor() {
    this.dbName = 'ExpenseSnapDB';
    this.dbVersion = 1;
    this.db = null;
    this.listeners = [];
    this.activeReportId = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.dbVersion);

      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('reports')) {
          const reportStore = db.createObjectStore('reports', { keyPath: 'id' });
          reportStore.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('receipts')) {
          const receiptStore = db.createObjectStore('receipts', { keyPath: 'id' });
          receiptStore.createIndex('reportId', 'reportId');
          receiptStore.createIndex('createdAt', 'createdAt');
        }
        if (!db.objectStoreNames.contains('meta')) {
          db.createObjectStore('meta', { keyPath: 'key' });
        }
      };

      request.onsuccess = async (e) => {
        this.db = e.target.result;
        // Load active report ID
        const activeMeta = await this.getMeta('activeReportId');
        if (activeMeta && activeMeta.value) {
          this.activeReportId = activeMeta.value;
        } else {
          // Check if any report exists, if not create default
          const reports = await this.getAllReports();
          if (reports.length === 0) {
            const defaultReport = await this.createReport('November Expense Report');
            this.activeReportId = defaultReport.id;
          } else {
            this.activeReportId = reports[0].id;
          }
          await this.setMeta('activeReportId', this.activeReportId);
        }
        resolve(this);
      };

      request.onerror = (e) => {
        console.error('IndexedDB Error:', e);
        reject(e);
      };
    });
  }

  // --- Pub / Sub Event System ---
  subscribe(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  notify(event, data) {
    for (const listener of this.listeners) {
      try {
        listener(event, data);
      } catch (err) {
        console.error('Listener notification error:', err);
      }
    }
  }

  // --- Meta Key-Value Store ---
  async getMeta(key) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readonly');
      const store = tx.objectStore('meta');
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async setMeta(key, value) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('meta', 'readwrite');
      const store = tx.objectStore('meta');
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // --- Reports Management ---
  async getAllReports() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('reports', 'readonly');
      const store = tx.objectStore('reports');
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async getReport(reportId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('reports', 'readonly');
      const store = tx.objectStore('reports');
      const req = store.get(reportId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getActiveReport() {
    if (!this.activeReportId) return null;
    return this.getReport(this.activeReportId);
  }

  async setActiveReport(reportId) {
    this.activeReportId = reportId;
    await this.setMeta('activeReportId', reportId);
    this.notify('report:changed', { reportId });
  }

  async createReport(title, options = {}) {
    const report = {
      id: 'rep_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      title: title || 'New Expense Report',
      submitterName: options.submitterName || '',
      department: options.department || '',
      currency: options.currency || 'USD',
      receiptOrder: [],
      pdfSettings: {
        layout: options.layout || 'full', // 'full', 'two_up', 'grid'
        addCover: options.addCover !== undefined ? options.addCover : true
      },
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('reports', 'readwrite');
      const store = tx.objectStore('reports');
      const req = store.add(report);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify('report:created', report);
    return report;
  }

  async updateReport(reportId, updates) {
    const report = await this.getReport(reportId);
    if (!report) return null;

    const updated = {
      ...report,
      ...updates,
      updatedAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('reports', 'readwrite');
      const store = tx.objectStore('reports');
      const req = store.put(updated);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify('report:updated', updated);
    return updated;
  }

  async deleteReport(reportId) {
    // Delete all associated receipts
    const receipts = await this.getReceiptsForReport(reportId);
    const tx = this.db.transaction(['reports', 'receipts'], 'readwrite');
    const reportStore = tx.objectStore('reports');
    const receiptStore = tx.objectStore('receipts');

    reportStore.delete(reportId);
    for (const r of receipts) {
      receiptStore.delete(r.id);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    // If active report was deleted, switch to another
    if (this.activeReportId === reportId) {
      const remaining = await this.getAllReports();
      if (remaining.length > 0) {
        await this.setActiveReport(remaining[0].id);
      } else {
        const newRep = await this.createReport('New Expense Report');
        await this.setActiveReport(newRep.id);
      }
    }

    this.notify('report:deleted', { reportId });
  }

  // --- Receipts Management ---
  async getReceiptsForReport(reportId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('receipts', 'readonly');
      const store = tx.objectStore('receipts');
      const index = store.index('reportId');
      const req = index.getAll(reportId);
      req.onsuccess = () => {
        const list = req.result || [];
        // Sort according to report.receiptOrder if present
        this.getReport(reportId).then((report) => {
          if (report && report.receiptOrder && report.receiptOrder.length > 0) {
            const map = new Map(list.map(r => [r.id, r]));
            const ordered = [];
            for (const id of report.receiptOrder) {
              if (map.has(id)) {
                ordered.push(map.get(id));
                map.delete(id);
              }
            }
            // Append any not in order list
            for (const r of map.values()) {
              ordered.push(r);
            }
            resolve(ordered);
          } else {
            // Default sort by date or createdAt
            list.sort((a, b) => (a.date || '').localeCompare(b.date || '') || a.createdAt - b.createdAt);
            resolve(list);
          }
        });
      };
      req.onerror = () => reject(req.error);
    });
  }

  async getReceipt(receiptId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction('receipts', 'readonly');
      const store = tx.objectStore('receipts');
      const req = store.get(receiptId);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async addReceipt(receiptData) {
    const reportId = receiptData.reportId || this.activeReportId;
    const receipt = {
      id: 'rec_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
      reportId: reportId,
      type: receiptData.type || 'image', // 'image' or 'pdf'
      fileName: receiptData.fileName || 'Receipt',
      fileSize: receiptData.fileSize || 0,
      mimeType: receiptData.mimeType || 'image/jpeg',
      dataUrl: receiptData.dataUrl || '', // For images
      rawArrayBuffer: receiptData.rawArrayBuffer || null, // For PDFs
      thumbnailDataUrl: receiptData.thumbnailDataUrl || '',
      date: receiptData.date || new Date().toISOString().split('T')[0],
      merchant: receiptData.merchant || 'Merchant',
      category: receiptData.category || 'Meals & Entertainment',
      paymentMethod: receiptData.paymentMethod || 'Corporate Card',
      amount: parseFloat(receiptData.amount) || 0.0,
      currency: receiptData.currency || 'USD',
      notes: receiptData.notes || '',
      rotation: receiptData.rotation || 0,
      enhanceContrast: !!receiptData.enhanceContrast,
      pageCount: receiptData.pageCount || 1,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    // Save receipt and update report receiptOrder
    const report = await this.getReport(reportId);
    const updatedOrder = (report && report.receiptOrder) ? [...report.receiptOrder, receipt.id] : [receipt.id];

    const tx = this.db.transaction(['receipts', 'reports'], 'readwrite');
    tx.objectStore('receipts').add(receipt);
    if (report) {
      report.receiptOrder = updatedOrder;
      report.updatedAt = Date.now();
      tx.objectStore('reports').put(report);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    this.notify('receipt:added', receipt);
    return receipt;
  }

  async updateReceipt(receiptId, updates) {
    const receipt = await this.getReceipt(receiptId);
    if (!receipt) return null;

    const updated = {
      ...receipt,
      ...updates,
      updatedAt: Date.now()
    };

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('receipts', 'readwrite');
      const store = tx.objectStore('receipts');
      const req = store.put(updated);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify('receipt:updated', updated);
    return updated;
  }

  async deleteReceipt(receiptId) {
    const receipt = await this.getReceipt(receiptId);
    if (!receipt) return;

    const reportId = receipt.reportId;
    const report = await this.getReport(reportId);

    const tx = this.db.transaction(['receipts', 'reports'], 'readwrite');
    tx.objectStore('receipts').delete(receiptId);

    if (report && report.receiptOrder) {
      report.receiptOrder = report.receiptOrder.filter(id => id !== receiptId);
      report.updatedAt = Date.now();
      tx.objectStore('reports').put(report);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    this.notify('receipt:deleted', { receiptId, reportId });
  }

  async setReceiptOrder(reportId, orderedIds) {
    const report = await this.getReport(reportId);
    if (!report) return;

    report.receiptOrder = orderedIds;
    report.updatedAt = Date.now();

    await new Promise((resolve, reject) => {
      const tx = this.db.transaction('reports', 'readwrite');
      const store = tx.objectStore('reports');
      const req = store.put(report);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });

    this.notify('receipts:reordered', { reportId, orderedIds });
  }

  // --- Backup & Restore ---
  async exportFullBackup() {
    const reports = await this.getAllReports();
    const allReceipts = [];
    for (const rep of reports) {
      const list = await this.getReceiptsForReport(rep.id);
      allReceipts.push(...list);
    }

    const backup = {
      version: 1,
      appName: 'ExpenseSnap',
      exportedAt: new Date().toISOString(),
      reports,
      receipts: allReceipts.map(r => ({
        ...r,
        // Convert ArrayBuffer to Base64 for clean JSON serialization
        rawArrayBuffer: r.rawArrayBuffer ? this._arrayBufferToBase64(r.rawArrayBuffer) : null
      }))
    };

    return JSON.stringify(backup, null, 2);
  }

  async importFullBackup(jsonString) {
    const backup = JSON.parse(jsonString);
    if (!backup.reports || !backup.receipts) {
      throw new Error('Invalid ExpenseSnap backup file format.');
    }

    const tx = this.db.transaction(['reports', 'receipts'], 'readwrite');
    const reportStore = tx.objectStore('reports');
    const receiptStore = tx.objectStore('receipts');

    for (const rep of backup.reports) {
      reportStore.put(rep);
    }

    for (const r of backup.receipts) {
      if (r.rawArrayBuffer && typeof r.rawArrayBuffer === 'string') {
        r.rawArrayBuffer = this._base64ToArrayBuffer(r.rawArrayBuffer);
      }
      receiptStore.put(r);
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    if (backup.reports.length > 0) {
      await this.setActiveReport(backup.reports[0].id);
    }
    this.notify('backup:restored', {});
  }

  _arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  _base64ToArrayBuffer(base64) {
    const binaryString = window.atob(base64);
    const len = binaryString.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binaryString.charCodeAt(i);
    }
    return bytes.buffer;
  }
}

// Global store instance
window.store = new ExpenseStore();
