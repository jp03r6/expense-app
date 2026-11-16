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
        try {
          // Make sure exactly one starter report exists. The check and the
          // create run inside ONE database transaction, so two windows starting
          // at the same moment can no longer both create "November Expense Report".
          await this._ensureDefaultReport();
          // Tidy up empty copies left behind by that old race (never touches
          // a report that has receipts).
          await this.removeEmptyDuplicateReports();
          await this._resolveActiveReport();
        } catch (err) {
          console.error('Store startup error:', err);
        }
        resolve(this);
      };

      request.onerror = (e) => {
        console.error('IndexedDB Error:', e);
        reject(e);
      };
    });
  }

  _newReportRecord(title, options = {}) {
    return {
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
  }

  // Creates the starter report only if the database has no reports at all.
  // Count + add happen in one readwrite transaction; IndexedDB runs
  // overlapping readwrite transactions one at a time, even across tabs.
  _ensureDefaultReport() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['reports', 'meta'], 'readwrite');
      const reports = tx.objectStore('reports');
      let created = null;
      const countReq = reports.count();
      countReq.onsuccess = () => {
        if (countReq.result === 0) {
          created = this._newReportRecord('November Expense Report');
          reports.add(created);
          tx.objectStore('meta').put({ key: 'activeReportId', value: created.id });
        }
      };
      tx.oncomplete = () => resolve(created);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  /**
   * Removes EMPTY duplicate reports: a report is removed only when another
   * report has the same title (ignoring case/spaces) and the removed one has
   * zero receipts. In each same-title group we keep the oldest report that
   * has receipts (or the oldest one if none do). Safe to run any number of
   * times. Returns the ids it removed.
   */
  removeEmptyDuplicateReports() {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['reports', 'receipts', 'meta'], 'readwrite');
      const reportStore = tx.objectStore('reports');
      const receiptIndex = tx.objectStore('receipts').index('reportId');
      const metaStore = tx.objectStore('meta');
      const removed = [];

      const allReq = reportStore.getAll();
      allReq.onsuccess = () => {
        const reports = sortReports(allReq.result || []);
        const groups = new Map();
        reports.forEach(r => {
          const key = String(r.title || '').trim().toLowerCase();
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(r);
        });
        const dupGroups = [...groups.values()].filter(g => g.length > 1);
        if (dupGroups.length === 0) return;

        // Count receipts for every report in a duplicate group
        const counts = new Map();
        let pending = 0;
        dupGroups.flat().forEach(r => {
          pending++;
          const req = receiptIndex.count(r.id);
          req.onsuccess = () => {
            counts.set(r.id, req.result);
            if (--pending === 0) decide();
          };
        });

        const decide = () => {
          const replacement = new Map(); // removed id -> kept id
          dupGroups.forEach(group => {
            const keeper = group.find(r => counts.get(r.id) > 0) || group[0];
            group.forEach(r => {
              if (r.id !== keeper.id && counts.get(r.id) === 0) {
                reportStore.delete(r.id);
                removed.push(r.id);
                replacement.set(r.id, keeper.id);
              }
            });
          });
          if (removed.length === 0) return;
          const metaReq = metaStore.get('activeReportId');
          metaReq.onsuccess = () => {
            const current = metaReq.result && metaReq.result.value;
            if (current && replacement.has(current)) {
              metaStore.put({ key: 'activeReportId', value: replacement.get(current) });
            }
          };
        };
      };

      tx.oncomplete = () => {
        if (removed.length) console.info('Removed empty duplicate reports:', removed);
        resolve(removed);
      };
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // Active report must point at a report that exists; otherwise fall back
  // to the oldest report.
  async _resolveActiveReport() {
    const activeMeta = await this.getMeta('activeReportId');
    const reports = sortReports(await this.getAllReports());
    const wanted = activeMeta && activeMeta.value;
    let chosen = reports.find(r => r.id === wanted);
    if (!chosen) chosen = reports[0] || null;
    this.activeReportId = chosen ? chosen.id : null;
    if (chosen && chosen.id !== wanted) {
      await this.setMeta('activeReportId', chosen.id);
    }
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
    const report = this._newReportRecord(title, options);

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
      date: receiptData.date || new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0],
      merchant: receiptData.merchant || 'Merchant',
      category: receiptData.category || 'Meals',
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

    const oldReportId = receipt.reportId;
    const updated = {
      ...receipt,
      ...updates,
      updatedAt: Date.now()
    };
    const newReportId = updated.reportId;
    const moved = !!(newReportId && oldReportId && newReportId !== oldReportId);

    if (moved) {
      const oldReport = await this.getReport(oldReportId);
      const newReport = await this.getReport(newReportId);

      await new Promise((resolve, reject) => {
        const tx = this.db.transaction(['receipts', 'reports'], 'readwrite');
        tx.objectStore('receipts').put(updated);

        if (oldReport) {
          if (oldReport.receiptOrder) {
            oldReport.receiptOrder = oldReport.receiptOrder.filter(id => id !== receiptId);
          }
          oldReport.updatedAt = Date.now();
          tx.objectStore('reports').put(oldReport);
        }

        if (newReport) {
          if (!newReport.receiptOrder) newReport.receiptOrder = [];
          if (!newReport.receiptOrder.includes(receiptId)) {
            newReport.receiptOrder.push(receiptId);
          }
          newReport.updatedAt = Date.now();
          tx.objectStore('reports').put(newReport);
        }

        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    } else {
      await new Promise((resolve, reject) => {
        const tx = this.db.transaction('receipts', 'readwrite');
        const store = tx.objectStore('receipts');
        const req = store.put(updated);
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error);
      });
    }

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

  // --- Real-Time Sync Ingestion ---
  async upsertReceiptFromSync(receipt) {
    if (!receipt || !receipt.id) return;
    const reportId = receipt.reportId || this.activeReportId;
    const report = await this.getReport(reportId);

    const tx = this.db.transaction(['receipts', 'reports'], 'readwrite');
    tx.objectStore('receipts').put(receipt);

    if (report) {
      if (!report.receiptOrder) report.receiptOrder = [];
      if (!report.receiptOrder.includes(receipt.id)) {
        report.receiptOrder.push(receipt.id);
        report.updatedAt = Date.now();
        tx.objectStore('reports').put(report);
      }
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    this.notify('receipt:sync_upsert', receipt);
  }

  async deleteReceiptFromSync(receiptId) {
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

    this.notify('receipt:sync_deleted', { receiptId, reportId });
  }

  async applyFullSync(report, receipts) {
    if (!report) return;
    const tx = this.db.transaction(['reports', 'receipts'], 'readwrite');
    const reportStore = tx.objectStore('reports');
    const receiptStore = tx.objectStore('receipts');

    reportStore.put(report);
    if (receipts && Array.isArray(receipts)) {
      for (const r of receipts) {
        receiptStore.put(r);
      }
    }

    await new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });

    await this.setActiveReport(report.id);
    this.notify('sync:full_applied', { report, receipts });
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

// Oldest first (by creation time, then title) so every report list matches
function sortReports(reports) {
  return [...reports].sort((a, b) =>
    (a.createdAt || 0) - (b.createdAt || 0) || String(a.title || '').localeCompare(String(b.title || '')));
}
window.sortReports = sortReports;

// Global store instance
window.store = new ExpenseStore();


/**
 * Canonical expense categories and payment methods, plus aliases for older
 * saved receipts. These helpers never rewrite stored data: known old names
 * map to the new labels when displayed; anything else is shown as stored.
 */
const CANONICAL_CATEGORIES = ['Meals', 'Transportation', 'Lodging', 'Office Supplies'];
const CANONICAL_PAYMENTS = ['Corporate Card', 'Personal Card', 'Cash'];

const CATEGORY_ALIASES = {
  'meals': 'Meals',
  'meals & entertainment': 'Meals',
  'meals and entertainment': 'Meals',
  'transportation': 'Transportation',
  'lodging': 'Lodging',
  'travel & lodging': 'Lodging',
  'travel and lodging': 'Lodging',
  'office supplies': 'Office Supplies',
  'office supplies & tech': 'Office Supplies',
  'office supplies and tech': 'Office Supplies'
};

const CATEGORY_SLUGS = {
  'Meals': 'meals',
  'Transportation': 'transport',
  'Lodging': 'lodging',
  'Office Supplies': 'office'
};

function _labelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function canonicalCategory(value) {
  const key = _labelKey(value);
  if (!key) return null;
  return CATEGORY_ALIASES[key] || null;
}

function displayCategory(value) {
  return canonicalCategory(value) || String(value || '').trim() || 'Meals';
}

function categorySlug(value) {
  const canonical = canonicalCategory(value);
  return CATEGORY_SLUGS[canonical] || 'other';
}

function canonicalPayment(value) {
  const key = _labelKey(value);
  if (!key) return null;
  if (key.includes('corporate') || key.includes('company')) return 'Corporate Card';
  if (key.includes('personal')) return 'Personal Card';
  if (key.includes('cash')) return 'Cash';
  return null;
}

function displayPayment(value) {
  return canonicalPayment(value) || String(value || '').trim() || 'Corporate Card';
}

window.expenseLabels = {
  CATEGORIES: CANONICAL_CATEGORIES,
  PAYMENTS: CANONICAL_PAYMENTS,
  canonicalCategory,
  displayCategory,
  categorySlug,
  canonicalPayment,
  displayPayment
};

