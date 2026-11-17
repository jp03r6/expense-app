/**
 * ExpenseSnap - Main UI Application Controller
 */

// Phone vs laptop: narrow or touch screens get the phone layouts (home screen,
// Sync scan-first). Must match the check in index.html's <head>.
const PHONE_QUERY = '(max-width: 768px), (pointer: coarse)';

class ExpenseApp {
  constructor() {
    this.currentReceipts = [];
    this.currentReport = null;
    this.allReceipts = [];
    // Date range used to build the PDF report. preset: this_month | last_month | last_90 | custom | month
    this.dateRange = { preset: 'this_month', month: null };
    this.selectedLayout = 'full';
    this.activeTab = 'tab-receipts';
    
    // Receipt form state
    this.stagedFile = null;
    this.stagedReceiptData = null;
    this.editingReceiptId = null;

    // PDF Preview state
    this.previewPdfDoc = null;
    this.previewCurrentPage = 1;
    this.previewTotalPages = 1;
    this.previewRequestId = 0;
    this.previewDebounceTimer = null;
    this.previewObjectUrl = null;
  }

  async init() {
    // 1. Initialize IndexedDB Store
    await window.store.init();
    await window.cloudSyncManager.init();

    // 2. Register Service Worker for PWA
    if ('serviceWorker' in navigator) {
      // updateViaCache: 'none' makes the browser always check the server for a
      // newer sw.js instead of trusting its own HTTP cache.
      navigator.serviceWorker.register('./sw.js', { updateViaCache: 'none' }).then(reg => {
        // Installed apps can stay open for days; look for an update whenever
        // the app comes back to the foreground.
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      }).catch(err => {
        console.warn('Service worker registration failed:', err);
      });

      // When a new version takes over, reload once so the page and its code match.
      const hadController = !!navigator.serviceWorker.controller;
      let reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (!hadController || reloading) return;
        reloading = true;
        window.location.reload();
      });
    }

    // 3. Bind UI Events
    this._bindEvents();
    this.initTheme();

    // 4. Subscribe to Store updates
    window.store.subscribe((event, data) => {
      this.handleStoreUpdate(event, data);
    });

    // 5. Initial Data Load
    await this.refreshAll();

    // 6. Setup Cloud Sync & QR Pairing
    window.cloudSyncManager.onStatusChange((status) => {
      this.handleSyncStatusChange(status);
    });
    this.setupSyncDeviceLayout();
    this.renderQrCode();
    this.setupPhoneHome();

    // A pairing link (?room=...) saves the room code, but never turns Sync on
    // by itself. Point the user at the switch instead.
    if (new URLSearchParams(window.location.search).has('room') && !window.cloudSyncManager.isEnabled()) {
      this.showFullApp('tab-settings');
      this.showToast('Room code saved. Turn on Sync to connect.', 'info');
    }
  }

  initTheme() {
    const savedTheme = localStorage.getItem('expensesnap_theme') || 
      (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    this.applyTheme(savedTheme);

    const toggleBtn = document.getElementById('btnThemeToggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', () => {
        const current = document.documentElement.getAttribute('data-theme') || 'light';
        const next = current === 'dark' ? 'light' : 'dark';
        this.applyTheme(next);
        localStorage.setItem('expensesnap_theme', next);
        this.showToast(`Switched to ${next} mode`, 'info');
      });
    }
  }

  applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    const phoneToggle = document.getElementById('mThemeToggle');
    if (phoneToggle) phoneToggle.checked = theme === 'dark';
    const icon = document.getElementById('themeIcon');
    if (icon) {
      icon.textContent = theme === 'dark' ? '☀️' : '🌙';
    }
  }

  renderQrCode() {
    const link = window.cloudSyncManager.getPairingLink();
    // The laptop layout shows a big QR code; the phone keeps a smaller one
    // under "Other ways to connect".
    document.querySelectorAll('.js-sync-qr').forEach(box => {
      const size = box.classList.contains('qr-code-large') ? 240 : 160;
      box.innerHTML = '';
      if (window.QRCode) {
        new window.QRCode(box, {
          text: link,
          width: size,
          height: size,
          colorDark: '#0f172a',
          colorLight: '#ffffff',
          correctLevel: window.QRCode.CorrectLevel.M
        });
      } else {
        const a = document.createElement('a');
        a.href = link;
        a.textContent = link;
        a.style.cssText = 'word-break: break-all; font-size: 0.8rem; color: var(--primary);';
        box.appendChild(a);
      }
    });

    document.querySelectorAll('.js-room-code').forEach(el => {
      el.textContent = window.cloudSyncManager.syncRoomId;
    });
  }

  // Phone (narrow or touch screen) leads with scanning; laptop leads with the QR code.
  setupSyncDeviceLayout() {
    const area = document.getElementById('syncPairingArea');
    if (!area || !window.matchMedia) return;
    const mq = window.matchMedia(PHONE_QUERY);
    const apply = () => { area.dataset.syncDevice = mq.matches ? 'phone' : 'laptop'; };
    apply();
    if (mq.addEventListener) mq.addEventListener('change', apply);
  }

  handleSyncStatusChange(status) {
    const headerSyncText = document.getElementById('syncText');
    const headerSyncBadge = document.getElementById('syncBadge');

    if (headerSyncText) headerSyncText.textContent = status.label;

    const isSynced = status.peersCount > 0;
    const isLive = status.isLive;

    [headerSyncBadge].forEach(b => {
      if (!b) return;
      b.classList.toggle('synced', isSynced);
      b.classList.toggle('online', isLive && !isSynced);
      b.classList.toggle('syncing', status.status === 'connecting');
    });

    document.querySelectorAll('.js-room-code').forEach(el => { el.textContent = status.roomCode; });

    // Sync switch, warning, and pairing controls follow the on/off state
    const toggle = document.getElementById('toggleSync');
    if (toggle) toggle.checked = !!status.enabled;
    const hint = document.getElementById('syncToggleHint');
    if (hint) hint.textContent = status.enabled ? status.label : 'Off. Nothing is sent anywhere.';
    const pairing = document.getElementById('syncPairingArea');
    if (pairing) pairing.hidden = !status.enabled;
  }

  startQrScanner() {
    this.openModal('modalQrScanner');
    const video = document.getElementById('qrScannerVideo');
    const canvas = document.getElementById('qrScannerCanvas');
    const ctx = canvas.getContext('2d');
    this.scanningActive = true;

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      this.stopQrScanner();
      this.showToast('Camera not supported in this browser.', 'error');
      return;
    }

    navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 640 }, height: { ideal: 480 } }
    }).then(stream => {
      this.scannerStream = stream;
      video.srcObject = stream;
      video.setAttribute('playsinline', 'true');
      video.play();

      const scanFrame = async () => {
        if (!this.scanningActive) return;
        if (video.readyState === video.HAVE_ENOUGH_DATA) {
          // 1. Try native BarcodeDetector if available
          if ('BarcodeDetector' in window) {
            try {
              if (!this.barcodeDetector) {
                this.barcodeDetector = new window.BarcodeDetector({ formats: ['qr_code'] });
              }
              const codes = await this.barcodeDetector.detect(video);
              if (codes.length > 0) {
                this.handleScannedQr(codes[0].rawValue);
                return;
              }
            } catch (e) {}
          }

          // 2. Fallback to jsQR
          if (window.jsQR) {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
            const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const code = window.jsQR(imgData.data, imgData.width, imgData.height, {
              inversionAttempts: "dontInvert"
            });
            if (code && code.data) {
              this.handleScannedQr(code.data);
              return;
            }
          }
        }
        requestAnimationFrame(scanFrame);
      };
      requestAnimationFrame(scanFrame);
    }).catch(err => {
      this.stopQrScanner();
      this.showToast('Camera error: ' + err.message, 'error');
    });
  }

  stopQrScanner() {
    this.scanningActive = false;
    if (this.scannerStream) {
      this.scannerStream.getTracks().forEach(t => t.stop());
      this.scannerStream = null;
    }
    this.closeModal('modalQrScanner');
  }

  handleScannedQr(rawData) {
    this.stopQrScanner();
    if (navigator.vibrate) {
      try { navigator.vibrate([60, 40, 60]); } catch (e) {}
    }

    let roomCode = rawData.trim();
    try {
      if (rawData.includes('?')) {
        const url = new URL(rawData, window.location.origin);
        const r = url.searchParams.get('room');
        if (r) roomCode = r;
      }
    } catch (e) {}

    window.cloudSyncManager.setRoomCode(roomCode);
    this.renderQrCode();
    this.showToast(`Joined room ${window.cloudSyncManager.syncRoomId}.`, 'success');
  }

  _bindEvents() {
    // Modal closing is wired first, with one listener on the whole page, so
    // Cancel, the X, a tap outside the card, and the Escape key keep working
    // even if some later setup step fails.
    this._bindModalClosing();
    this._watchPreviewSize();

    // Navigation Tabs (Desktop & Mobile)
    document.querySelectorAll('[data-tab]').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const tabId = btn.getAttribute('data-tab');
        // From the phone home screen, a tab opens the full app on that tab
        if (document.documentElement.classList.contains('show-home')) this.showFullApp(tabId);
        else this.switchTab(tabId);
      });
    });

    // Date range picker on the PDF tab
    this._bindDateRange();

    // Remember submitter name and department between visits
    ['pdfSubmitterName', 'pdfDepartment'].forEach(id => {
      const el = document.getElementById(id);
      if (!el) return;
      const saved = localStorage.getItem('expensesnap_' + id);
      if (saved) el.value = saved;
      el.addEventListener('input', () => localStorage.setItem('expensesnap_' + id, el.value));
    });

    // Add Receipt Buttons
    const openAddModal = () => this.openAddModal();

    document.getElementById('btnAddReceipt').addEventListener('click', openAddModal);
    document.getElementById('btnAddReceiptHeader').addEventListener('click', openAddModal);
    document.getElementById('btnEmptyAdd').addEventListener('click', openAddModal);
    document.getElementById('fabAddReceipt').addEventListener('click', openAddModal);

    // Dropzone & File Input
    const dropzone = document.getElementById('dropzone');
    const fileInput = document.getElementById('fileInput');

    dropzone.addEventListener('click', () => fileInput.click());

    dropzone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropzone.classList.add('drag-over');
    });

    dropzone.addEventListener('dragleave', () => {
      dropzone.classList.remove('drag-over');
    });

    dropzone.addEventListener('drop', async (e) => {
      e.preventDefault();
      dropzone.classList.remove('drag-over');
      if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
        await this.handleFileUpload(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        // Clear the picker so choosing the same file again still triggers a change
        e.target.value = '';
        await this.handleFileUpload(file);
      }
    });

    // Rotate and enhance inside modal
    document.getElementById('btnModalRotate').addEventListener('click', async () => {
      if (!this.stagedReceiptData || !this.stagedReceiptData.dataUrl) return;
      const currentRot = (this.stagedReceiptData.rotation || 0) + 90;
      this.stagedReceiptData.rotation = currentRot % 360;
      
      const opt = await window.receiptManager.optimizeImage(
        this.stagedReceiptData.dataUrl,
        90,
        this.stagedReceiptData.enhanceContrast
      );
      this.stagedReceiptData.dataUrl = opt.dataUrl;
      this.stagedReceiptData.thumbnailDataUrl = opt.thumbnailUrl;
      document.getElementById('uploadPreviewImg').src = opt.dataUrl;
    });

    document.getElementById('btnModalEnhance').addEventListener('click', async () => {
      if (!this.stagedReceiptData || !this.stagedReceiptData.dataUrl) return;
      this.stagedReceiptData.enhanceContrast = !this.stagedReceiptData.enhanceContrast;
      
      const opt = await window.receiptManager.optimizeImage(
        this.stagedReceiptData.dataUrl,
        0,
        this.stagedReceiptData.enhanceContrast
      );
      this.stagedReceiptData.dataUrl = opt.dataUrl;
      this.stagedReceiptData.thumbnailDataUrl = opt.thumbnailUrl;
      document.getElementById('uploadPreviewImg').src = opt.dataUrl;
      this.showToast(this.stagedReceiptData.enhanceContrast ? 'Thermal contrast boost ON' : 'Standard contrast restored', 'info');
    });

    // Save Receipt to Store
    document.getElementById('btnSaveReceipt').addEventListener('click', async () => {
      const date = document.getElementById('inputDate').value;
      const amount = parseFloat(document.getElementById('inputAmount').value) || 0;
      const merchant = document.getElementById('inputMerchant').value.trim() || 'Receipt';
      const category = document.getElementById('inputCategory').value;
      const paymentMethod = document.getElementById('inputPayment').value;
      const notes = document.getElementById('inputNotes').value.trim();

      if (!this.stagedReceiptData && !this.editingReceiptId) {
        this.showToast('Please take a photo or upload a receipt file first.', 'error');
        return;
      }

      if (this.editingReceiptId) {
        // Update existing receipt
        const updated = await window.store.updateReceipt(this.editingReceiptId, {
          date,
          amount,
          merchant,
          category,
          paymentMethod,
          notes
        });
        if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
        this.showToast('Receipt updated', 'success');
      } else {
        // Add new receipt
        let staged = this.stagedReceiptData;
        if (staged.noReceipt) {
          const { noReceipt, ...rest } = staged;
          staged = { ...rest, ...this._makeNoReceiptImage({ date, amount, merchant, category }) };
        }
        const added = await window.store.addReceipt({
          ...staged,
          date,
          amount,
          merchant,
          category,
          paymentMethod,
          notes,
          // Receipts are one list now; the stored reportId just keeps older
          // versions and sync working.
          reportId: window.store.activeReportId
        });
        if (added) window.cloudSyncManager.broadcastReceiptAdded(added);
        this.showToast('Receipt saved', 'success');
      }

      this.closeModal('modalAddReceipt');
    });

    // Quick Sample Demo Receipts Button
    document.getElementById('btnQuickSample').addEventListener('click', async () => {
      await this.loadSampleReceipts();
    });

    // Spreadsheet Companion: 1-Click Copy for Excel
    document.getElementById('btnCopyExcel').addEventListener('click', async () => {
      try {
        const res = await window.spreadsheetHelper.copyTableForExcel(this._receiptsInRange(this._computeRange()), true);
        this.showToast(`✅ Copied ${res.count} rows to clipboard! Just press Ctrl+V in your company Excel sheet.`, 'success');
      } catch (err) {
        this.showToast('Failed to copy: ' + err.message, 'error');
      }
    });

    // Spreadsheet Companion: Export .xlsx
    document.getElementById('btnExportXlsx').addEventListener('click', () => {
      try {
        const range = this._computeRange();
        window.spreadsheetHelper.exportToExcel(this._exportMeta(range), this._receiptsInRange(range));
        this.showToast('Excel workbook downloaded', 'success');
      } catch (err) {
        this.showToast('Export failed: ' + err.message, 'error');
      }
    });

    // Spreadsheet Companion: Export CSV
    document.getElementById('btnExportCsv').addEventListener('click', () => {
      try {
        const range = this._computeRange();
        window.spreadsheetHelper.exportToCsv(this._exportMeta(range), this._receiptsInRange(range));
        this.showToast('CSV downloaded', 'success');
      } catch (err) {
        this.showToast('Export failed: ' + err.message, 'error');
      }
    });

    // PDF Layout Options Picker (native radios)
    document.querySelectorAll('input[name="pdfLayout"]').forEach(input => {
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.selectedLayout = input.value;
        this.schedulePdfPreviewRefresh(true);
      });
    });

    // Auto-refresh preview when compile options change
    const chkAddCover = document.getElementById('chkAddCover');
    if (chkAddCover) {
      chkAddCover.addEventListener('change', () => this.schedulePdfPreviewRefresh(true));
    }
    ['pdfSubmitterName', 'pdfDepartment'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {
        el.addEventListener('input', () => this.schedulePdfPreviewRefresh(false));
      }
    });

    // PDF Compilation & Download
    document.getElementById('btnCompilePdf').addEventListener('click', async () => {
      await this.compileAndDownloadPdf();
    });

    // PDF Preview Pagination
    document.getElementById('btnPrevPage').addEventListener('click', () => {
      if (this.previewCurrentPage > 1) {
        this.previewCurrentPage--;
        this.renderPreviewPage(this.previewCurrentPage);
      }
    });

    document.getElementById('btnNextPage').addEventListener('click', () => {
      if (this.previewCurrentPage < this.previewTotalPages) {
        this.previewCurrentPage++;
        this.renderPreviewPage(this.previewCurrentPage);
      }
    });

    // Sync Badge in Header
    const syncBadge = document.getElementById('syncBadge');
    if (syncBadge) {
      syncBadge.addEventListener('click', () => {
        this.switchTab('tab-settings');
        this.renderQrCode();
      });
    }

    // In-App QR Scanner Trigger & Close
    ['btnOpenQrScanner', 'btnScanLaptopQr'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.addEventListener('click', () => this.startQrScanner());
    });
    const btnCloseQr = document.getElementById('btnCloseQrScanner');
    if (btnCloseQr) {
      btnCloseQr.addEventListener('click', () => this.stopQrScanner());
    }
    const btnCancelScan = document.getElementById('btnCancelScan');
    if (btnCancelScan) {
      btnCancelScan.addEventListener('click', () => this.stopQrScanner());
    }

    // Multi-Device Cloud Sync Controls
    const toggleSync = document.getElementById('toggleSync');
    if (toggleSync) {
      toggleSync.addEventListener('change', async () => {
        const on = toggleSync.checked;
        await window.cloudSyncManager.setEnabled(on);
        if (on) {
          this.renderQrCode();
          this.showToast('Sync is on. It uses a public relay and is not encrypted yet.', 'info');
        } else {
          this.showToast('Sync is off. Receipts stay on this device.', 'info');
        }
      });
    }

    document.getElementById('btnCopyPairLink').addEventListener('click', () => {
      const link = window.cloudSyncManager.getPairingLink();
      navigator.clipboard.writeText(link);
      this.showToast('Sync link copied! Open on your phone to link.', 'success');
    });

    const btnNewRoom = document.getElementById('btnNewRoomCode');
    if (btnNewRoom) {
      btnNewRoom.addEventListener('click', () => {
        const newCode = window.cloudSyncManager.generateRoomCode();
        window.cloudSyncManager.setRoomCode(newCode);
        this.renderQrCode();
        this.showToast('New room generated: ' + newCode, 'info');
      });
    }

    document.getElementById('btnJoinRoom').addEventListener('click', () => {
      const code = document.getElementById('inputJoinRoom').value.trim();
      if (code) {
        window.cloudSyncManager.setRoomCode(code);
        this.renderQrCode();
        this.showToast(`Joined sync room ${window.cloudSyncManager.syncRoomId}!`, 'success');
      }
    });

    // Backup & Restore
    document.getElementById('btnExportBackup').addEventListener('click', async () => {
      const backupJson = await window.store.exportFullBackup();
      const blob = new Blob([backupJson], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `ExpenseSnap_Backup_${new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().split('T')[0]}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      this.showToast('Backup file downloaded', 'success');
    });

    document.getElementById('inputRestoreBackup').addEventListener('change', async (e) => {
      if (e.target.files && e.target.files.length > 0) {
        const file = e.target.files[0];
        const text = await file.text();
        try {
          await window.store.importFullBackup(text);
          this.showToast('Backup restored successfully!', 'success');
          await this.refreshAll();
        } catch (err) {
          this.showToast('Failed to restore backup: ' + err.message, 'error');
        }
      }
    });

  }

  switchTab(tabId) {
    if (document.documentElement.classList.contains('is-phone') && this.activeTab !== tabId) {
      window.scrollTo(0, 0);
    }
    this.activeTab = tabId;
    
    // Update Desktop Tabs
    document.querySelectorAll('.nav-tabs .tab-btn').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    // Update Mobile Nav
    document.querySelectorAll('.mobile-nav-bar .mobile-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.getAttribute('data-tab') === tabId);
    });

    // Update View Containers
    document.querySelectorAll('.tab-view').forEach(view => {
      view.classList.toggle('active', view.id === tabId);
    });

    // The PDF and Ledger tabs share ONE "Which receipts?" card: move it into
    // the tab being opened so both always show the same date range.
    const slot = document.querySelector(`[data-range-slot="${tabId}"]`);
    const rangeCard = document.getElementById('dateRangeCard');
    if (slot && rangeCard && rangeCard.parentElement !== slot) slot.appendChild(rangeCard);

    // If PDF tab selected, trigger preview refresh
    if (tabId === 'tab-pdf') {
      this.schedulePdfPreviewRefresh(true);
    }

    // If Settings tab selected, re-render QR code
    if (tabId === 'tab-settings') {
      this.renderQrCode();
    }
  }

  _bindModalClosing() {
    document.addEventListener('click', (e) => {
      const closeBtn = e.target.closest('.modal-close');
      if (closeBtn) {
        const modal = closeBtn.closest('.modal-overlay');
        if (modal) this._dismissModal(modal);
        return;
      }
      // Tap on the dark backdrop (not on the card itself)
      if (e.target.classList && e.target.classList.contains('modal-overlay')) {
        this._dismissModal(e.target);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const open = document.querySelectorAll('.modal-overlay.open');
      if (open.length) this._dismissModal(open[open.length - 1]);
    });
  }

  _dismissModal(modal) {
    if (modal.id === 'modalQrScanner') {
      this.stopQrScanner(); // also turns the camera off
      return;
    }
    modal.classList.remove('open');
    if (modal.id === 'modalAddReceipt') {
      this.editingReceiptId = null;
      this.stagedReceiptData = null;
    }
  }

  openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('open');
  }

  closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.remove('open');
  }

  // Opens the add-receipt form, empty and ready for a photo or PDF.
  openAddModal() {
    this.editingReceiptId = null;
    this.stagedReceiptData = null;
    document.getElementById('modalReceiptTitle').textContent = 'Add Receipt or PDF';
    document.getElementById('uploadPreviewSection').style.display = 'none';
    document.getElementById('dropzone').style.display = 'block';
    document.getElementById('inputDate').value = this._localISO(new Date());
    document.getElementById('inputAmount').value = '';
    document.getElementById('inputMerchant').value = '';
    document.getElementById('inputNotes').value = '';
    this._fillLabeledSelect('inputCategory', window.expenseLabels.CATEGORIES, 'Meals', window.expenseLabels.canonicalCategory);
    this._fillLabeledSelect('inputPayment', window.expenseLabels.PAYMENTS, 'Corporate Card', window.expenseLabels.canonicalPayment);
    this.openModal('modalAddReceipt');
  }

  // Opens a saved receipt in the edit form.
  openEditReceipt(r, title = 'Edit Receipt') {
    this.editingReceiptId = r.id;
    this.stagedReceiptData = null;
    document.getElementById('modalReceiptTitle').textContent = title;
    document.getElementById('inputDate').value = r.date || '';
    document.getElementById('inputAmount').value = r.amount || '';
    document.getElementById('inputMerchant').value = r.merchant || '';
    this._fillLabeledSelect('inputCategory', window.expenseLabels.CATEGORIES, r.category, window.expenseLabels.canonicalCategory);
    this._fillLabeledSelect('inputPayment', window.expenseLabels.PAYMENTS, r.paymentMethod, window.expenseLabels.canonicalPayment);
    document.getElementById('inputNotes').value = r.notes || '';

    document.getElementById('uploadPreviewImg').src = r.dataUrl || r.thumbnailDataUrl;
    document.getElementById('uploadPreviewSection').style.display = 'flex';
    document.getElementById('dropzone').style.display = 'none';

    this.openModal('modalAddReceipt');
  }

  // "No receipt": the same form, but saving does not need a photo. A simple
  // "No receipt" page image is made at save time so the PDF, thumbnails and
  // exports work exactly like any other receipt.
  openNoReceiptForm() {
    this.openAddModal();
    this.stagedReceiptData = { type: 'image', noReceipt: true, fileName: 'No receipt', mimeType: 'image/png' };
    document.getElementById('modalReceiptTitle').textContent = 'Add expense without a receipt';
    document.getElementById('dropzone').style.display = 'none';
    document.getElementById('uploadPreviewSection').style.display = 'none';
  }

  _makeNoReceiptImage({ date, amount, merchant, category }) {
    const canvas = document.createElement('canvas');
    canvas.width = 850;
    canvas.height = 1100;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth = 4;
    ctx.setLineDash([18, 12]);
    ctx.strokeRect(60, 60, canvas.width - 120, canvas.height - 120);
    ctx.setLineDash([]);
    ctx.fillStyle = '#0f172a';
    ctx.textAlign = 'center';
    ctx.font = 'bold 64px sans-serif';
    ctx.fillText('No receipt', canvas.width / 2, 380);
    ctx.font = '40px sans-serif';
    ctx.fillStyle = '#334155';
    const lines = [merchant, date ? this._prettyDate(date) : '', category, `$${(amount || 0).toFixed(2)}`];
    lines.filter(Boolean).forEach((line, i) => ctx.fillText(line, canvas.width / 2, 500 + i * 70));
    const dataUrl = canvas.toDataURL('image/png');
    const thumb = document.createElement('canvas');
    thumb.width = 170;
    thumb.height = 220;
    thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height);
    return { dataUrl, thumbnailDataUrl: thumb.toDataURL('image/png') };
  }

  // ---------- Phone home (quick capture) ----------
  // Phones (narrow or touch screen) open here every time; laptops never do.
  isPhone() {
    return !!(window.matchMedia && window.matchMedia(PHONE_QUERY).matches);
  }

  setupPhoneHome() {
    const root = document.documentElement;
    const mq = window.matchMedia ? window.matchMedia(PHONE_QUERY) : null;
    if (mq && mq.addEventListener) {
      mq.addEventListener('change', () => {
        root.classList.toggle('is-phone', mq.matches);
        if (!mq.matches) root.classList.remove('show-home');
        this.applyPhoneLayout();
      });
    }
    // index.html already added these before the first paint; keep them in sync.
    root.classList.toggle('is-phone', this.isPhone());
    if (this.isPhone()) this.showPhoneHome();

    const cam = document.getElementById('phCameraInput');
    const gallery = document.getElementById('phGalleryInput');
    const pdf = document.getElementById('phPdfInput');
    document.getElementById('phSnap').addEventListener('click', () => cam.click());
    // "Upload photo or PDF" asks which: the photo gallery or a PDF from Files.
    // Each picker is opened right inside the tap so the browser allows it.
    document.getElementById('phUpload').addEventListener('click', () => this.openModal('modalUploadChoice'));
    document.getElementById('phPickGallery').addEventListener('click', () => {
      gallery.click();
      this.closeModal('modalUploadChoice');
    });
    document.getElementById('phPickPdf').addEventListener('click', () => {
      pdf.click();
      this.closeModal('modalUploadChoice');
    });
    // Photos and PDFs both go through the same add form (PDFs use the PDF path)
    [cam, gallery, pdf].forEach(input => {
      input.addEventListener('change', async () => {
        const file = input.files && input.files[0];
        input.value = '';
        if (!file) return;
        this.openAddModal();
        await this.handleFileUpload(file);
      });
    });
    document.getElementById('phNoReceipt').addEventListener('click', () => this.openNoReceiptForm());
    document.getElementById('phSettings').addEventListener('click', () => this.showFullApp('tab-settings'));
    document.getElementById('navHome').addEventListener('click', () => this.showPhoneHome());
    this.setupPhoneTabs();
    this.setupPhoneReceipts();
    this.setupPhoneLedger();
    this.setupPhonePdf();
  }

  // ---- Phone versions of Receipts, Ledger, PDF and Settings ----
  // These are extra phone-only blocks (.m-only). They call the same code as
  // the laptop controls, so saving, exports and the PDF work exactly the same.
  setupPhoneTabs() {
    const themeToggle = document.getElementById('mThemeToggle');
    themeToggle.checked = document.documentElement.getAttribute('data-theme') === 'dark';
    themeToggle.addEventListener('change', () => {
      const next = themeToggle.checked ? 'dark' : 'light';
      this.applyTheme(next);
      localStorage.setItem('expensesnap_theme', next);
    });
    document.querySelectorAll('.js-demo-receipts').forEach(btn =>
      btn.addEventListener('click', () => this.loadSampleReceipts()));

    // Range chip rows (Ledger and PDF): the first chip opens the range sheet,
    // the month chips are one-tap shortcuts.
    document.addEventListener('click', (e) => {
      const chip = e.target.closest('.js-range-chips [data-preset], .js-range-chips [data-month]');
      if (!chip) return;
      // Run the laptop card's own buttons, so the phone filters exactly the same way
      const card = document.getElementById('dateRangeCard');
      if (chip.dataset.preset) {
        const btn = card.querySelector(`[data-preset="${chip.dataset.preset}"]`);
        if (btn) btn.click();
        // Custom needs From/To dates, which live in the range sheet
        if (chip.dataset.preset === 'custom') this.openRangeSheet();
      } else if (chip.dataset.month) {
        const btn = card.querySelector(`[data-month="${chip.dataset.month}"]`);
        if (btn) btn.click();
        else { this.dateRange = { preset: 'month', month: chip.dataset.month }; this._onRangeChanged(); }
      }
    });
    this.applyPhoneLayout();
  }

  // Moves shared pieces between the laptop and phone layouts when the
  // phone rule starts or stops matching.
  applyPhoneLayout() {
    const phone = document.documentElement.classList.contains('is-phone');
    const preview = document.getElementById('pdfPreviewPanel');
    const phoneSlot = document.getElementById('mPdfPreviewSlot');
    const deskSlot = document.getElementById('pdfPreviewHome');
    if (preview && phoneSlot && deskSlot) {
      const target = phone ? phoneSlot : deskSlot;
      if (preview.parentElement !== target) target.appendChild(preview);
    }
    if (!phone) {
      // Put the range card back into the open laptop tab
      const slot = document.querySelector(`[data-range-slot="${this.activeTab}"]`);
      const rangeCard = document.getElementById('dateRangeCard');
      if (slot && rangeCard && rangeCard.parentElement !== slot) slot.appendChild(rangeCard);
    }
  }

  openRangeSheet() {
    const rangeCard = document.getElementById('dateRangeCard');
    const slot = document.getElementById('rangeSheetSlot');
    if (rangeCard && slot && rangeCard.parentElement !== slot) slot.appendChild(rangeCard);
    this.openModal('modalRange');
  }

  _rangeChipLabel() {
    const { preset, month } = this.dateRange;
    const names = { this_month: 'This month', last_month: 'Last month', last_90: 'Last 90 days' };
    if (names[preset]) return names[preset];
    if (preset === 'month' && month) return this._monthName(month, 'short');
    return this._computeRange().label;
  }

  // Presets are visible right on the tab (no sheet needed): This month,
  // Last month, Last 90 days, Custom; then the months that have receipts.
  renderPhoneRangeChips() {
    const rows = document.querySelectorAll('.js-range-chips');
    if (!rows.length) return;
    const range = this._computeRange();
    const n = this._receiptsInRange(range).length;
    const counts = new Map();
    this.allReceipts.forEach(r => {
      if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        const ym = r.date.slice(0, 7);
        counts.set(ym, (counts.get(ym) || 0) + 1);
      }
    });
    const { preset, month } = this.dateRange;
    const presets = [['this_month', 'This month'], ['last_month', 'Last month'], ['last_90', 'Last 90 days'], ['custom', 'Custom']];
    const presetHtml = presets.map(([key, label]) => {
      const on = preset === key;
      const count = on ? `<span class="n">${n}</span>` : '';
      const icon = key === 'custom' ? '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>' : '';
      const aria = key === 'custom' ? ' aria-haspopup="dialog"' : '';
      return `<button type="button" class="mt-chip" data-preset="${key}" aria-pressed="${on}"${aria}>${icon}<span>${label}</span>${count}</button>`;
    }).join('');
    const months = [...counts.keys()].sort().reverse().slice(0, 3);
    const monthHtml = months.map(ym => {
      const on = preset === 'month' && month === ym;
      return `<button type="button" class="mt-chip" data-month="${ym}" aria-pressed="${on}"><span>${this._escape(this._monthName(ym, 'short'))}</span><span class="n">${counts.get(ym)}</span></button>`;
    }).join('');
    const customLine = preset === 'custom'
      ? `<div class="mt-range-line">${this._escape(range.label)} · <button type="button" class="mt-link" data-preset="custom">Change dates</button></div>`
      : '';
    rows.forEach(row => {
      row.innerHTML =
        `<div class="mt-chips" role="group" aria-label="Date range">${presetHtml}</div>` +
        (monthHtml ? `<div class="mt-chips mt-chips-months" role="group" aria-label="Months with receipts">${monthHtml}</div>` : '') +
        customLine;
    });
  }


  showPhoneHome() {
    document.documentElement.classList.add('show-home');
    // Bottom bar: Home is the active tab while home is showing
    document.querySelectorAll('.mobile-nav-bar .mobile-nav-item').forEach(btn => {
      btn.classList.toggle('active', btn.id === 'navHome');
    });
    this.renderPhoneHome();
    window.scrollTo(0, 0);
  }

  showFullApp(tabId = 'tab-receipts') {
    document.documentElement.classList.remove('show-home');
    const home = document.getElementById('navHome');
    if (home) home.classList.remove('active');
    this.switchTab(tabId);
    window.scrollTo(0, 0);
  }

  renderPhoneHome() {
    const label = document.getElementById('phMonthLabel');
    if (!label) return;
    const receipts = this.currentReceipts || [];
    const now = new Date();
    const monthPrefix = this._localISO(now).slice(0, 7); // YYYY-MM, local time
    const inMonth = receipts.filter(r => String(r.date || '').slice(0, 7) === monthPrefix);
    const total = inMonth.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const monthName = now.toLocaleDateString('en-US', { month: 'long' });
    label.textContent = `${monthName} so far · ${inMonth.length} ${inMonth.length === 1 ? 'receipt' : 'receipts'}`;
    document.getElementById('phMonthTotal').textContent = this._money(total);

    const list = document.getElementById('phRecentList');
    const empty = document.getElementById('phRecentEmpty');
    list.innerHTML = '';
    empty.hidden = receipts.length > 0;
    receipts.slice(0, 3).forEach(r => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'ph-row';
      const when = r.date ? this._prettyDate(r.date, false) : '';
      const cat = window.expenseLabels.displayCategory(r.category);
      row.innerHTML = `<span class="ph-row-text"><b>${this._escape(r.merchant || 'Receipt')}</b>` +
        `<small>${this._escape([when, cat].filter(Boolean).join(' · '))}</small></span>` +
        `<span class="ph-money">${this._money(parseFloat(r.amount) || 0)}</span>`;
      row.addEventListener('click', () => this.openEditReceipt(r));
      list.appendChild(row);
    });
  }

  _money(n) {
    return '$' + (parseFloat(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  async handleFileUpload(file) {
    try {
      this.showToast('Processing file...', 'info');
      const processed = await window.receiptManager.processFile(file);
      this.stagedReceiptData = processed;

      // Populate modal form fields with inferred smart defaults
      document.getElementById('inputDate').value = processed.date;
      document.getElementById('inputMerchant').value = processed.merchant;
      document.getElementById('inputCategory').value = processed.category;
      document.getElementById('inputNotes').value = processed.notes;

      // Show preview
      const previewImg = document.getElementById('uploadPreviewImg');
      previewImg.src = processed.dataUrl || processed.thumbnailDataUrl;
      document.getElementById('uploadPreviewSection').style.display = 'flex';
      document.getElementById('dropzone').style.display = 'none';

      this.showToast('Receipt loaded! Fill details and save.', 'success');
    } catch (err) {
      console.error(err);
      this.showToast('Error processing file: ' + err.message, 'error');
    }
  }

  async handleStoreUpdate(event, data) {
    await this.refreshAll();
  }

  async refreshAll() {
    // Receipts are one list, newest first. Report folders still exist in the
    // database (nothing is deleted) but are no longer used to group receipts.
    this.currentReport = await window.store.getActiveReport();
    this.allReceipts = await window.store.getAllReceipts();
    const nameEl = document.getElementById('pdfSubmitterName');
    if (nameEl && !nameEl.value && this.currentReport && this.currentReport.submitterName) {
      nameEl.value = this.currentReport.submitterName;
    }
    this.currentReceipts = [...this.allReceipts].sort((a, b) =>
      String(b.date || '').localeCompare(String(a.date || '')) || (b.createdAt || 0) - (a.createdAt || 0));

    // 3. Calculate Totals
    let total = 0;
    this.currentReceipts.forEach(r => {
      total += parseFloat(r.amount) || 0;
    });

    const totalFormatted = `$${total.toFixed(2)}`;
    document.getElementById('headerTotal').textContent = totalFormatted;
    document.getElementById('badgeReceiptCount').textContent = this.currentReceipts.length;
    const heroTotal = document.getElementById('heroTotal');
    const heroCount = document.getElementById('heroCount');
    const heroLabel = document.getElementById('heroCountLabel');
    if (heroTotal) heroTotal.textContent = totalFormatted;
    if (heroCount) heroCount.textContent = this.currentReceipts.length;
    if (heroLabel) heroLabel.textContent = this.currentReceipts.length === 1 ? 'receipt' : 'receipts';

    // 4. Render Receipts Grid
    this.renderReceiptsGrid();
    this.renderPhoneReceipts();

    // 5. Render Spreadsheet Ledger Table
    this.renderLedgerTable();

    // 6. Date range picker (month shortcuts, count and total) + preview
    this.renderDateRange();
    if (this.activeTab === 'tab-pdf') this.schedulePdfPreviewRefresh(false);

    // 7. Phone home screen (month total and recent receipts)
    this.renderPhoneHome();
  }

  renderReceiptsGrid() {
    const grid = document.getElementById('receiptsGrid');
    const emptyState = document.getElementById('emptyReceipts');

    if (this.currentReceipts.length === 0) {
      grid.style.display = 'none';
      emptyState.style.display = 'block';
      return;
    }

    grid.style.display = 'grid';
    emptyState.style.display = 'none';
    grid.innerHTML = '';

    this.currentReceipts.forEach((r, idx) => {
      const card = document.createElement('div');
      const catSlug = this._categorySlug(r.category);
      card.className = `receipt-card cat-${catSlug}`;

      const typeBadgeClass = r.type === 'pdf' ? 'type-pdf' : 'type-img';
      const typeLabel = r.type === 'pdf' ? 'PDF' : 'IMAGE';

      card.innerHTML = `
        <div class="receipt-card-header">
          <span class="receipt-num">ITEM #${idx + 1}</span>
          <span class="category-badge cat-${catSlug}">${this._escape(window.expenseLabels.displayCategory(r.category))}</span>
        </div>
        <div class="receipt-thumb-wrapper" title="Click to inspect receipt">
          <span class="receipt-type-badge ${typeBadgeClass}">${typeLabel}</span>
          <img class="receipt-thumb" src="${r.thumbnailDataUrl || r.dataUrl}" alt="${r.merchant}">
        </div>
        <div class="receipt-card-body">
          <div class="receipt-merchant">${this._escape(r.merchant)}</div>
          <div class="receipt-meta">
            <span>📅 ${r.date || 'No Date'}</span>
            <span class="receipt-amount">$${(parseFloat(r.amount) || 0).toFixed(2)}</span>
          </div>
        </div>
        <div class="receipt-card-footer">
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm btn-icon btn-quick-rotate" title="Rotate 90°">🔄</button>
          </div>
          <div class="card-actions">
            <button class="btn btn-secondary btn-sm btn-edit">Edit</button>
            <button class="btn btn-danger btn-sm btn-delete">✕</button>
          </div>
        </div>
      `;

      // Zoom viewer
      card.querySelector('.receipt-thumb-wrapper').addEventListener('click', () => {
        document.getElementById('zoomTitle').textContent = `${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`;
        document.getElementById('zoomImg').src = r.dataUrl || r.thumbnailDataUrl;
        this.openModal('modalZoom');
      });

      // Quick Rotate
      card.querySelector('.btn-quick-rotate').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.rotateReceipt(r);
      });

      // Edit Details
      card.querySelector('.btn-edit').addEventListener('click', (e) => {
        e.stopPropagation();
        this.openEditReceipt(r, `Edit Receipt #${idx + 1}`);
      });

      // Delete
      card.querySelector('.btn-delete').addEventListener('click', async (e) => {
        e.stopPropagation();
        await this.deleteReceiptWithConfirm(r);
      });

      grid.appendChild(card);
    });
  }

  // Rotate a receipt photo 90° (used by the laptop grid and the phone detail sheet)
  async rotateReceipt(r) {
    const currentRot = (r.rotation || 0) + 90;
    const opt = await window.receiptManager.optimizeImage(r.dataUrl, 90, r.enhanceContrast);
    const updated = await window.store.updateReceipt(r.id, {
      rotation: currentRot % 360,
      dataUrl: opt.dataUrl,
      thumbnailDataUrl: opt.thumbnailUrl
    });
    if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
    this.showToast('Receipt rotated 90°', 'info');
    return updated;
  }

  async deleteReceiptWithConfirm(r) {
    if (!confirm(`Delete receipt from ${r.merchant}?`)) return false;
    await window.store.deleteReceipt(r.id);
    window.cloudSyncManager.broadcastReceiptDeleted(r.id);
    this.showToast('Receipt removed', 'info');
    return true;
  }

  _openZoom(r) {
    document.getElementById('zoomTitle').textContent = `${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`;
    document.getElementById('zoomImg').src = r.dataUrl || r.thumbnailDataUrl;
    this.openModal('modalZoom');
  }

  _shortDate(iso) {
    return /^\d{4}-\d{2}-\d{2}$/.test(iso || '') ? this._prettyDate(iso, false) : 'No date';
  }

  // ---- Phone Receipts: search, category chips, list grouped by month ----
  setupPhoneReceipts() {
    this.phoneRecFilter = { q: '', cat: '' };
    const search = document.getElementById('mRecSearch');
    search.addEventListener('input', () => {
      this.phoneRecFilter.q = search.value;
      this.renderPhoneReceipts();
    });
    document.getElementById('mRecChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      this.phoneRecFilter.cat = chip.dataset.cat;
      this.renderPhoneReceipts();
    });
    document.getElementById('mRecClear').addEventListener('click', () => {
      search.value = '';
      this.phoneRecFilter = { q: '', cat: '' };
      this.renderPhoneReceipts();
    });
    document.getElementById('mRecAdd').addEventListener('click', () => this.openAddModal());
    document.getElementById('mRecEmptyAdd').addEventListener('click', () => this.openAddModal());
    document.getElementById('mRecList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const r = this.allReceipts.find(x => String(x.id) === row.dataset.id);
      if (r) this.openReceiptDetail(r);
    });

    // Detail sheet actions
    document.getElementById('mDetPhoto').addEventListener('click', () => {
      const r = this._detailReceipt();
      if (r) this._openZoom(r);
    });
    document.getElementById('mDetEdit').addEventListener('click', () => {
      const r = this._detailReceipt();
      if (!r) return;
      this.closeModal('modalReceiptDetail');
      this.openEditReceipt(r, 'Edit Receipt');
    });
    document.getElementById('mDetRotate').addEventListener('click', async (e) => {
      const r = this._detailReceipt();
      if (!r) return;
      const btn = e.currentTarget;
      btn.disabled = true;
      try {
        const updated = await this.rotateReceipt(r);
        if (updated) this._fillReceiptDetail(updated);
      } finally {
        btn.disabled = false;
      }
    });
    document.getElementById('mDetDelete').addEventListener('click', async () => {
      const r = this._detailReceipt();
      if (r && await this.deleteReceiptWithConfirm(r)) this.closeModal('modalReceiptDetail');
    });
  }

  _detailReceipt() {
    return this.allReceipts.find(x => x.id === this.detailReceiptId) || null;
  }

  openReceiptDetail(r) {
    this.detailReceiptId = r.id;
    this._fillReceiptDetail(r);
    this.openModal('modalReceiptDetail');
  }

  _fillReceiptDetail(r) {
    const labels = window.expenseLabels;
    document.getElementById('mDetImg').src = r.thumbnailDataUrl || r.dataUrl || '';
    document.getElementById('mDetImg').alt = `Receipt from ${r.merchant || 'unknown merchant'}`;
    document.getElementById('mDetMerchant').textContent = r.merchant || 'Receipt';
    document.getElementById('mDetAmount').textContent = this._money(r.amount);
    let when = 'No date';
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) {
      const [y, m, d] = r.date.split('-').map(Number);
      when = new Date(y, m - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }
    const bits = [labels.displayCategory(r.category)];
    if (r.paymentMethod) bits.push(labels.displayPayment ? labels.displayPayment(r.paymentMethod) : r.paymentMethod);
    if (r.type === 'pdf') bits.push('PDF');
    document.getElementById('mDetMeta').innerHTML = `${this._escape(when)}<br>${this._escape(bits.join(' · '))}`;
    document.getElementById('mDetNotes').textContent = r.notes || '';
  }

  renderPhoneReceipts() {
    const list = document.getElementById('mRecList');
    if (!list) return;
    const labels = window.expenseLabels;
    const all = this.currentReceipts || [];
    const total = all.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    document.getElementById('mRecSub').innerHTML = all.length
      ? `${all.length} ${all.length === 1 ? 'receipt' : 'receipts'} · <span class="mt-money">${this._money(total)}</span>`
      : 'Nothing saved yet';

    const { q, cat } = this.phoneRecFilter || { q: '', cat: '' };
    document.querySelectorAll('#mRecChips [data-cat]').forEach(chip =>
      chip.setAttribute('aria-pressed', String(chip.dataset.cat === cat)));

    const needle = q.trim().toLowerCase();
    const shown = all.filter(r => {
      if (cat && labels.displayCategory(r.category) !== cat) return false;
      if (!needle) return true;
      return [r.merchant, r.notes, labels.displayCategory(r.category), (parseFloat(r.amount) || 0).toFixed(2)]
        .some(v => String(v || '').toLowerCase().includes(needle));
    });

    document.getElementById('mRecTools').hidden = all.length === 0;
    document.getElementById('mRecEmpty').hidden = all.length !== 0;
    document.getElementById('mRecNoMatch').hidden = !(all.length && !shown.length);

    // Group by month, newest first (the list is already newest first)
    const groups = [];
    shown.forEach(r => {
      const key = /^\d{4}-\d{2}/.test(r.date || '') ? r.date.slice(0, 7) : '';
      let g = groups.find(x => x.key === key);
      if (!g) groups.push(g = { key, items: [] });
      g.items.push(r);
    });
    list.innerHTML = groups.map(g => {
      const sum = g.items.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
      const rows = g.items.map(r => {
        const meta = [this._shortDate(r.date), labels.displayCategory(r.category)];
        if (r.notes) meta.push(r.notes);
        else if (r.type === 'pdf') meta.push('PDF');
        return `<button type="button" class="mt-row" data-id="${this._escape(String(r.id))}" aria-label="${this._escape(`${r.merchant}, ${this._money(r.amount)}, ${this._shortDate(r.date)}`)}">` +
          `<img class="mt-thumb" src="${r.thumbnailDataUrl || r.dataUrl || ''}" alt="" loading="lazy">` +
          `<span class="mt-row-t"><b>${this._escape(r.merchant || 'Receipt')}</b><small>${this._escape(meta.join(' · '))}</small></span>` +
          `<span class="mt-money">${this._money(r.amount)}</span></button>`;
      }).join('');
      return `<div class="mt-group-h"><span>${this._escape(g.key ? this._monthName(g.key) : 'No date')}</span><span>${g.items.length} · ${this._money(sum)}</span></div><div class="mt-list">${rows}</div>`;
    }).join('');

    // Keep an open detail sheet in step with edits made elsewhere (e.g. sync)
    if (this.detailReceiptId && document.getElementById('modalReceiptDetail').classList.contains('open')) {
      const r = this._detailReceipt();
      if (r) this._fillReceiptDetail(r);
      else this.closeModal('modalReceiptDetail');
    }
  }

  // ---- Phone Ledger: totals card, category breakdown, short rows ----
  setupPhoneLedger() {
    document.getElementById('mLedExport').addEventListener('click', () => {
      const range = this._computeRange();
      const rows = this._receiptsInRange(range);
      const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
      document.getElementById('mExpTitle').textContent = `Export ${rows.length} ${rows.length === 1 ? 'receipt' : 'receipts'}`;
      document.getElementById('mExpSub').textContent = `${range.label} · ${this._money(total)}`;
      document.getElementById('mExpXlsxName').textContent = `${this._exportMeta(range).fileBase}.xlsx`;
      this.openModal('modalExport');
    });
    // The sheet runs the same export code as the laptop buttons
    [['mExpCopy', 'btnCopyExcel'], ['mExpXlsx', 'btnExportXlsx'], ['mExpCsv', 'btnExportCsv']].forEach(([phoneId, deskId]) => {
      document.getElementById(phoneId).addEventListener('click', () => {
        this.closeModal('modalExport');
        document.getElementById(deskId).click();
      });
    });
    document.getElementById('mLedList').addEventListener('click', (e) => {
      const row = e.target.closest('[data-id]');
      if (!row) return;
      const r = this.allReceipts.find(x => String(x.id) === row.dataset.id);
      if (r) this.openEditReceipt(r, 'Edit Receipt');
    });
  }

  renderPhoneLedger(range, rows) {
    const list = document.getElementById('mLedList');
    if (!list) return;
    const labels = window.expenseLabels;
    const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    document.getElementById('mLedLabel').textContent = `${range.label} · ${rows.length} ${rows.length === 1 ? 'receipt' : 'receipts'}`;
    document.getElementById('mLedTotal').textContent = this._money(total);
    document.getElementById('mLedExport').disabled = rows.length === 0;

    const byCat = new Map();
    rows.forEach(r => {
      const c = labels.displayCategory(r.category);
      byCat.set(c, (byCat.get(c) || 0) + (parseFloat(r.amount) || 0));
    });
    const cats = [...byCat.entries()].sort((a, b) => b[1] - a[1]);
    const max = cats.length ? cats[0][1] : 0;
    document.getElementById('mLedBars').innerHTML = cats.map(([c, amt]) => {
      const pct = max > 0 ? Math.max(2, Math.round((amt / max) * 100)) : 0;
      return `<span>${this._escape(c)}</span><span class="bar" aria-hidden="true"><i style="width:${pct}%"></i></span><span class="amt">${this._money(amt)}</span>`;
    }).join('');

    const empty = document.getElementById('mLedEmpty');
    document.getElementById('mLedRowsWrap').hidden = rows.length === 0;
    empty.hidden = rows.length !== 0;
    if (!rows.length) {
      empty.innerHTML = this.allReceipts.length === 0
        ? '<b>No receipts yet</b><span>Add receipts and they show up here as a spreadsheet.</span>'
        : `<b>Nothing in ${this._escape(range.label)}</b><span>Pick another range above.</span>`;
    }

    // Newest first on the phone; exports stay oldest first
    list.innerHTML = [...rows].reverse().map(r => {
      let m = '', d = '';
      if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) {
        const [y, mo, da] = r.date.split('-').map(Number);
        m = new Date(y, mo - 1, da).toLocaleDateString('en-US', { month: 'short' });
        d = String(da);
      }
      const meta = [labels.displayCategory(r.category), labels.displayPayment(r.paymentMethod)];
      if (r.notes) meta.push(r.notes);
      return `<button type="button" class="mt-row" data-id="${this._escape(String(r.id))}" aria-label="${this._escape(`Edit ${r.merchant}, ${this._money(r.amount)}`)}">` +
        `<span class="mt-date" aria-hidden="true"><span class="m" style="display:block">${m}</span><span class="d" style="display:block">${d || '–'}</span></span>` +
        `<span class="mt-row-t"><b>${this._escape(r.merchant || 'Receipt')}</b><small>${this._escape(meta.join(' · '))}</small></span>` +
        `<span class="mt-money">${this._money(r.amount)}</span></button>`;
    }).join('');
  }

  renderLedgerTable() {
    const tbody = document.getElementById('ledgerTableBody');
    tbody.innerHTML = '';

    // Same date range as the PDF tab, oldest first
    const range = this._computeRange();
    const rows = this._receiptsInRange(range);
    this.renderPhoneLedger(range, rows);
    const total = rows.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    document.getElementById('ledgerCount').textContent = rows.length;
    document.getElementById('ledgerTotal').textContent = `$${total.toFixed(2)}`;
    ['btnCopyExcel', 'btnExportXlsx', 'btnExportCsv'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) btn.disabled = rows.length === 0;
    });

    if (rows.length === 0) {
      const msg = this.allReceipts.length === 0
        ? 'No receipts added yet. Add receipts to automatically generate your spreadsheet.'
        : `No receipts dated ${this._escape(range.label)}. Pick another range above.`;
      tbody.innerHTML = `
        <tr>
          <td colspan="9" class="ledger-empty" style="text-align: center; color: var(--text-muted); padding: 30px;">
            ${msg}
          </td>
        </tr>
      `;
      return;
    }

    rows.forEach((r, idx) => {
      const tr = document.createElement('tr');
      const catSlug = this._categorySlug(r.category);
      tr.className = `cat-${catSlug}`;
      tr.innerHTML = `
        <td style="font-weight: 700; color: var(--primary); text-align: center;">${idx + 1}</td>
        <td>
          <img class="table-thumb" src="${r.thumbnailDataUrl || r.dataUrl}" alt="Thumb" title="Click to view">
        </td>
        <td>
          <input type="date" class="table-input" value="${r.date || ''}" data-field="date">
        </td>
        <td>
          <input type="text" class="table-input" value="${this._escape(r.merchant)}" data-field="merchant">
        </td>
        <td>
          <select class="table-input cat-select cat-${catSlug}" data-field="category">
            ${this._optionsHtml(window.expenseLabels.CATEGORIES, r.category, window.expenseLabels.canonicalCategory)}
          </select>
        </td>
        <td>
          <select class="table-input" data-field="paymentMethod">
            ${this._optionsHtml(window.expenseLabels.PAYMENTS, r.paymentMethod, window.expenseLabels.canonicalPayment)}
          </select>
        </td>
        <td>
          <input type="number" step="0.01" class="table-input table-amount" value="${(parseFloat(r.amount) || 0).toFixed(2)}" data-field="amount">
        </td>
        <td>
          <input type="text" class="table-input" value="${this._escape(r.notes || '')}" data-field="notes" placeholder="Notes...">
        </td>
        <td>
          <button class="btn btn-danger btn-sm btn-icon btn-table-del" title="Delete">✕</button>
        </td>
      `;

      // Zoom click
      tr.querySelector('.table-thumb').addEventListener('click', () => {
        document.getElementById('zoomTitle').textContent = `${r.merchant} - $${(parseFloat(r.amount) || 0).toFixed(2)}`;
        document.getElementById('zoomImg').src = r.dataUrl || r.thumbnailDataUrl;
        this.openModal('modalZoom');
      });

      // Inline auto-save for table edits
      tr.querySelectorAll('.table-input').forEach(input => {
        input.addEventListener('change', async (e) => {
          const field = e.target.getAttribute('data-field');
          let val = e.target.value;
          if (field === 'amount') val = parseFloat(val) || 0;

          const updated = await window.store.updateReceipt(r.id, { [field]: val });
          if (updated) window.cloudSyncManager.broadcastReceiptUpdated(updated);
          this.showToast('Ledger updated', 'info');
        });
      });

      // Delete from table
      tr.querySelector('.btn-table-del').addEventListener('click', async () => {
        if (confirm(`Remove receipt from ${r.merchant}?`)) {
          await window.store.deleteReceipt(r.id);
          window.cloudSyncManager.broadcastReceiptDeleted(r.id);
        }
      });

      tbody.appendChild(tr);
    });
  }

  _revokePreviewObjectUrl() {
    if (this.previewObjectUrl) {
      URL.revokeObjectURL(this.previewObjectUrl);
      this.previewObjectUrl = null;
    }
  }

  _setPreviewUpdating(on) {
    const panel = document.getElementById('pdfPreviewPanel');
    if (panel) panel.classList.toggle('is-updating', !!on);
  }

  schedulePdfPreviewRefresh(immediate = false) {
    clearTimeout(this.previewDebounceTimer);
    this.previewDebounceTimer = null;
    if (immediate) {
      this.refreshPdfPreview();
      return;
    }
    // Debounce typing in name/department so we don't rebuild the PDF on every keystroke
    this.previewDebounceTimer = setTimeout(() => {
      this.previewDebounceTimer = null;
      this.refreshPdfPreview();
    }, 450);
  }

  async compileAndDownloadPdf() {
    const range = this._computeRange();
    const receipts = this._receiptsInRange(range);
    if (receipts.length === 0) {
      this.showToast(`No receipts dated ${range.label}. Pick another range.`, 'error');
      return;
    }

    try {
      this.showToast('Assembling receipts into unified PDF...', 'info');
      const addCover = document.getElementById('chkAddCover').checked;
      const submitterName = document.getElementById('pdfSubmitterName').value.trim();
      const department = document.getElementById('pdfDepartment').value.trim();

      const blob = await window.pdfCompiler.compileReportPdf(
        this._reportMetaForRange(range, submitterName, department),
        receipts,
        {
          layout: this.selectedLayout,
          addCover: addCover
        }
      );

      // Trigger download, e.g. Expense_Report_2026-10-01_to_2026-10-31.pdf
      const fileName = `Expense_Report_${range.from || 'start'}_to_${range.to || this._localISO(new Date())}.pdf`;

      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = fileName;
      link.click();
      URL.revokeObjectURL(link.href);

      this.showToast('Single compiled PDF downloaded successfully!', 'success');
    } catch (err) {
      console.error(err);
      this.showToast('Compilation error: ' + err.message, 'error');
    }
  }

  async refreshPdfPreview() {
    const requestId = ++this.previewRequestId;
    this._setPreviewUpdating(true);

    try {
      const range = this._computeRange();
      const receipts = this._receiptsInRange(range);
      if (receipts.length === 0) {
        if (requestId !== this.previewRequestId) return;
        this._revokePreviewObjectUrl();
        this.previewPdfDoc = null;
        this.previewTotalPages = 1;
        this.previewCurrentPage = 1;
        const canvas = document.getElementById('pdfPreviewCanvas');
        if (canvas) {
          const ctx = canvas.getContext('2d');
          ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        const indicator = document.getElementById('previewPageIndicator');
        if (indicator) indicator.textContent = 'No receipts in this date range';
        document.getElementById('btnPrevPage').disabled = true;
        document.getElementById('btnNextPage').disabled = true;
        this._syncPhonePager();
        return;
      }

      const addCover = document.getElementById('chkAddCover').checked;
      const submitterName = document.getElementById('pdfSubmitterName').value.trim();
      const department = document.getElementById('pdfDepartment').value.trim();

      const blob = await window.pdfCompiler.compileReportPdf(
        this._reportMetaForRange(range, submitterName, department),
        receipts,
        {
          layout: this.selectedLayout,
          addCover: addCover
        }
      );

      // Latest-wins: ignore this result if a newer refresh has started
      if (requestId !== this.previewRequestId) return;

      // Preview is drawn onto a canvas from an ArrayBuffer, so there is
      // usually no object URL. Revoke any leftover URL just in case a
      // previous path created one.
      this._revokePreviewObjectUrl();

      const arrayBuffer = await blob.arrayBuffer();
      if (requestId !== this.previewRequestId) return;

      this.previewPdfDoc = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;
      if (requestId !== this.previewRequestId) return;

      this.previewTotalPages = this.previewPdfDoc.numPages;
      this.previewCurrentPage = 1;

      await this.renderPreviewPage(1, requestId);
    } catch (err) {
      if (requestId === this.previewRequestId) {
        console.error('Preview error:', err);
      }
    } finally {
      if (requestId === this.previewRequestId) {
        this._setPreviewUpdating(false);
      }
    }
  }

  // Width available for the PDF page inside the grey preview box
  _previewAvailableWidth() {
    const panel = document.getElementById('pdfPreviewPanel');
    if (!panel || panel.clientWidth === 0) return 600;
    const cs = getComputedStyle(panel);
    const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
    return Math.max(120, panel.clientWidth - pad);
  }

  // Re-fit the preview when the screen size or orientation changes (debounced)
  _watchPreviewSize() {
    const panel = document.getElementById('pdfPreviewPanel');
    if (!panel) return;
    const refit = () => {
      clearTimeout(this.previewResizeTimer);
      this.previewResizeTimer = setTimeout(() => {
        if (!this.previewPdfDoc || this.activeTab !== 'tab-pdf') return;
        if (Math.abs(this._previewAvailableWidth() - (this.previewRenderedWidth || 0)) < 2) return;
        this.renderPreviewPage(this.previewCurrentPage);
      }, 200);
    };
    if ('ResizeObserver' in window) {
      new ResizeObserver(refit).observe(panel);
    }
    window.addEventListener('resize', refit);
    window.addEventListener('orientationchange', refit);
  }

  async renderPreviewPage(pageNum, requestId = this.previewRequestId) {
    if (!this.previewPdfDoc) return;
    if (requestId !== this.previewRequestId) return;

    const page = await this.previewPdfDoc.getPage(pageNum);
    if (requestId !== this.previewRequestId) return;

    const canvas = document.getElementById('pdfPreviewCanvas');
    const ctx = canvas.getContext('2d');

    // Fit the whole page to the width of the preview box (never wider than
    // 1.2x the PDF's own size), keeping its shape. Draw at the screen's pixel
    // density so text stays sharp, then show it at the fitted CSS size.
    const base = page.getViewport({ scale: 1 });
    const fitScale = Math.min(1.2, this._previewAvailableWidth() / base.width);
    const cssWidth = Math.floor(base.width * fitScale);
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const viewport = page.getViewport({ scale: fitScale * dpr });
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = 'auto'; // follows the width, keeping the page's shape
    this.previewRenderedWidth = this._previewAvailableWidth();

    await page.render({
      canvasContext: ctx,
      viewport: viewport
    }).promise;

    if (requestId !== this.previewRequestId) return;

    document.getElementById('previewPageIndicator').textContent = `Page ${pageNum} of ${this.previewTotalPages}`;
    document.getElementById('btnPrevPage').disabled = pageNum <= 1;
    document.getElementById('btnNextPage').disabled = pageNum >= this.previewTotalPages;
    this._syncPhonePager();
  }

  async loadSampleReceipts() {
    this.showToast('Generating demo receipts...', 'info');

    // Sample 1: Uber Rideshare Receipt (Digital style)
    const uberCanvas = document.createElement('canvas');
    uberCanvas.width = 600;
    uberCanvas.height = 800;
    const uCtx = uberCanvas.getContext('2d');
    uCtx.fillStyle = '#000000';
    uCtx.fillRect(0, 0, 600, 100);
    uCtx.fillStyle = '#ffffff';
    uCtx.font = 'bold 36px sans-serif';
    uCtx.fillText('Uber', 40, 65);
    uCtx.fillStyle = '#ffffff';
    uCtx.fillRect(0, 100, 600, 700);
    uCtx.fillStyle = '#1e293b';
    uCtx.font = 'bold 26px sans-serif';
    uCtx.fillText('Trip Receipt: Airport to Hotel', 40, 160);
    uCtx.font = '18px sans-serif';
    uCtx.fillStyle = '#64748b';
    uCtx.fillText('Date: 2026-11-10 18:42 EST', 40, 200);
    uCtx.fillText('Driver: Michael S. (Toyota Camry)', 40, 230);
    uCtx.strokeStyle = '#e2e8f0';
    uCtx.lineWidth = 2;
    uCtx.strokeRect(40, 270, 520, 260);
    uCtx.fillStyle = '#0f172a';
    uCtx.font = '20px sans-serif';
    uCtx.fillText('Trip Fare', 60, 320);
    uCtx.fillText('$28.50', 460, 320);
    uCtx.fillText('Tolls & Surcharges', 60, 370);
    uCtx.fillText('$4.25', 460, 370);
    uCtx.fillText('Tip', 60, 420);
    uCtx.fillText('$5.00', 460, 420);
    uCtx.font = 'bold 24px sans-serif';
    uCtx.fillText('Total Charged', 60, 490);
    uCtx.fillStyle = '#047857';
    uCtx.fillText('$37.75', 450, 490);
    const uberUrl = uberCanvas.toDataURL('image/jpeg', 0.9);

    // Sample 2: Restaurant Dinner Receipt (Paper thermal style)
    const restCanvas = document.createElement('canvas');
    restCanvas.width = 500;
    restCanvas.height = 700;
    const rCtx = restCanvas.getContext('2d');
    rCtx.fillStyle = '#faf8f5'; // Off-white receipt paper
    rCtx.fillRect(0, 0, 500, 700);
    rCtx.fillStyle = '#262626';
    rCtx.font = 'bold 26px monospace';
    rCtx.textAlign = 'center';
    rCtx.fillText('THE CAPITAL GRILLE', 250, 60);
    rCtx.font = '16px monospace';
    rCtx.fillText('1338 Chestnut St, Philadelphia PA', 250, 90);
    rCtx.fillText('Server: Sarah H. | Table: 14', 250, 120);
    rCtx.fillText('--------------------------------', 250, 150);
    rCtx.textAlign = 'left';
    rCtx.fillText('2  Bone-in Ribeye         124.00', 50, 190);
    rCtx.fillText('1  Lobster Mac & Cheese    22.00', 50, 220);
    rCtx.fillText('2  Sparkling Water         14.00', 50, 250);
    rCtx.fillText('1  Espresso                 6.00', 50, 280);
    rCtx.textAlign = 'center';
    rCtx.fillText('--------------------------------', 250, 320);
    rCtx.textAlign = 'left';
    rCtx.fillText('SUBTOTAL:                 166.00', 50, 360);
    rCtx.fillText('TAX (8%):                  13.28', 50, 390);
    rCtx.fillText('TIP (20%):                 33.20', 50, 420);
    rCtx.font = 'bold 20px monospace';
    rCtx.fillText('TOTAL:                   $212.48', 50, 470);
    rCtx.font = '14px monospace';
    rCtx.fillText('AUTH CODE: 849204 | VISA ****4921', 50, 520);
    rCtx.textAlign = 'center';
    rCtx.fillText('Thank You for Dining With Us!', 250, 580);
    const restUrl = restCanvas.toDataURL('image/jpeg', 0.9);

    // Sample 3: Starbucks Coffee & Breakfast
    const starCanvas = document.createElement('canvas');
    starCanvas.width = 440;
    starCanvas.height = 560;
    const sCtx = starCanvas.getContext('2d');
    sCtx.fillStyle = '#ffffff';
    sCtx.fillRect(0, 0, 440, 560);
    sCtx.fillStyle = '#006241'; // Starbucks green
    sCtx.fillRect(0, 0, 440, 70);
    sCtx.fillStyle = '#ffffff';
    sCtx.font = 'bold 28px sans-serif';
    sCtx.textAlign = 'center';
    sCtx.fillText('STARBUCKS', 220, 48);
    sCtx.fillStyle = '#1e293b';
    sCtx.textAlign = 'left';
    sCtx.font = '16px monospace';
    sCtx.fillText('Store #14892 - Terminal B', 40, 110);
    sCtx.fillText('Date: 2026-11-11  07:34 AM', 40, 135);
    sCtx.fillText('================================', 40, 160);
    sCtx.fillText('1 Grande Caffe Latte       $5.65', 40, 200);
    sCtx.fillText('1 Bacon Gouda Sandwich     $5.95', 40, 235);
    sCtx.fillText('================================', 40, 275);
    sCtx.fillText('Subtotal:                 $11.60', 40, 310);
    sCtx.fillText('Tax:                       $0.93', 40, 340);
    sCtx.font = 'bold 20px monospace';
    sCtx.fillText('TOTAL:                    $12.53', 40, 385);
    const starUrl = starCanvas.toDataURL('image/jpeg', 0.9);

    // Add samples to store
    await window.store.addReceipt({
      type: 'image',
      fileName: 'Uber_Airport_Trip.jpg',
      dataUrl: uberUrl,
      thumbnailDataUrl: uberUrl,
      date: '2026-11-10',
      merchant: 'Uber',
      category: 'Transportation',
      paymentMethod: 'Corporate Card',
      amount: 37.75,
      notes: 'Rideshare from Airport to Client Hotel'
    });

    await window.store.addReceipt({
      type: 'image',
      fileName: 'Capital_Grille_Dinner.jpg',
      dataUrl: restUrl,
      thumbnailDataUrl: restUrl,
      date: '2026-11-10',
      merchant: 'The Capital Grille',
      category: 'Meals',
      paymentMethod: 'Corporate Card',
      amount: 212.48,
      notes: 'Client Dinner with Acme Corp VP'
    });

    await window.store.addReceipt({
      type: 'image',
      fileName: 'Starbucks_Airport.jpg',
      dataUrl: starUrl,
      thumbnailDataUrl: starUrl,
      date: '2026-11-11',
      merchant: 'Starbucks',
      category: 'Meals',
      paymentMethod: 'Corporate Card',
      amount: 12.53,
      notes: 'Breakfast on departure'
    });

    this.showToast('Demo receipts added! Check the Ledger and PDF tab.', 'success');
  }

  showToast(message, type = 'info') {
    const container = document.getElementById('toastContainer');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3800);
  }

  // ---- Date range for reports -------------------------------------------
  // All dates are plain local calendar dates in YYYY-MM-DD form (the same
  // form receipts are saved in), so comparisons never shift by a day the way
  // UTC timestamps can.

  _localISO(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  _prettyDate(iso, withYear = true) {
    const [y, m, d] = iso.split('-').map(Number);
    const opts = withYear ? { month: 'short', day: 'numeric', year: 'numeric' } : { month: 'short', day: 'numeric' };
    return new Date(y, m - 1, d).toLocaleDateString('en-US', opts);
  }

  _monthName(ym, style = 'long') {
    const [y, m] = ym.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: style, year: 'numeric' });
  }

  _rangeLabel(from, to) {
    if (!from && !to) return 'any date';
    if (!from) return `on or before ${this._prettyDate(to)}`;
    if (!to) return `on or after ${this._prettyDate(from)}`;
    if (from === to) return this._prettyDate(from);
    const sameYear = from.slice(0, 4) === to.slice(0, 4);
    return `${this._prettyDate(from, !sameYear)} – ${this._prettyDate(to)}`;
  }

  _computeRange() {
    const today = new Date();
    const y = today.getFullYear();
    const m = today.getMonth();
    const iso = d => this._localISO(d);
    const { preset, month } = this.dateRange;
    let from = null, to = null, label;

    if (preset === 'last_month') {
      from = iso(new Date(y, m - 1, 1));
      to = iso(new Date(y, m, 0));
      label = this._monthName(from.slice(0, 7));
    } else if (preset === 'last_90') {
      from = iso(new Date(y, m, today.getDate() - 89)); // 90 days including today
      to = iso(today);
    } else if (preset === 'month' && month) {
      const [my, mm] = month.split('-').map(Number);
      from = `${month}-01`;
      to = iso(new Date(my, mm, 0)); // day 0 of next month = last day of this month
      label = this._monthName(month);
    } else if (preset === 'custom') {
      from = document.getElementById('rangeFrom').value || null;
      to = document.getElementById('rangeTo').value || null;
      if (from && to && from > to) [from, to] = [to, from];
    } else {
      from = iso(new Date(y, m, 1));
      to = iso(new Date(y, m + 1, 0));
      label = this._monthName(from.slice(0, 7));
    }
    return { from, to, label: label || this._rangeLabel(from, to) };
  }

  _chronological(list) {
    return [...list].sort((a, b) =>
      String(a.date || '').localeCompare(String(b.date || '')) || (a.createdAt || 0) - (b.createdAt || 0));
  }

  // Receipts whose date falls inside the range (both ends included), oldest first
  _receiptsInRange(range) {
    return this._chronological(this.allReceipts.filter(r => {
      if (!r.date) return false;
      if (range.from && r.date < range.from) return false;
      if (range.to && r.date > range.to) return false;
      return true;
    }));
  }

  _reportMetaForRange(range, submitterName, department) {
    return {
      ...(this.currentReport || {}),
      title: `Expense Report – ${range.label}`,
      periodLabel: range.from && range.to ? this._rangeLabel(range.from, range.to) : range.label,
      submitterName,
      department
    };
  }

  _exportMeta(range) {
    const from = range.from || 'start';
    const to = range.to || this._localISO(new Date());
    return {
      title: `Expense Ledger – ${range.label}`,
      periodLabel: range.from && range.to ? this._rangeLabel(range.from, range.to) : range.label,
      fileBase: `Expense_Ledger_${from}_to_${to}`,
      submitterName: (document.getElementById('pdfSubmitterName').value || '').trim(),
      department: (document.getElementById('pdfDepartment').value || '').trim()
    };
  }

  _bindDateRange() {
    const card = document.getElementById('dateRangeCard');
    if (!card) return;
    card.addEventListener('click', (e) => {
      const chip = e.target.closest('[data-preset], [data-month]');
      if (!chip) return;
      if (chip.dataset.month) {
        this.dateRange = { preset: 'month', month: chip.dataset.month };
      } else {
        this.dateRange = { preset: chip.dataset.preset, month: null };
        if (chip.dataset.preset === 'custom') {
          const fromEl = document.getElementById('rangeFrom');
          const toEl = document.getElementById('rangeTo');
          // Start the custom range from the current choice so it's easy to adjust
          if (!fromEl.value && !toEl.value) {
            const today = new Date();
            fromEl.value = this._localISO(new Date(today.getFullYear(), today.getMonth(), 1));
            toEl.value = this._localISO(today);
          }
        }
      }
      this._onRangeChanged();
    });
    ['rangeFrom', 'rangeTo'].forEach(id => {
      document.getElementById(id).addEventListener('change', () => this._onRangeChanged());
    });
  }

  // One range drives the summary, the Ledger and the PDF preview
  _onRangeChanged() {
    this.renderDateRange();
    this.renderLedgerTable();
    if (this.activeTab === 'tab-pdf') this.schedulePdfPreviewRefresh(true);
  }

  renderDateRange() {
    const card = document.getElementById('dateRangeCard');
    if (!card) return;
    const { preset, month } = this.dateRange;

    card.querySelectorAll('[data-preset]').forEach(btn => {
      btn.setAttribute('aria-pressed', String(btn.dataset.preset === preset));
    });

    // Month shortcuts: only months that actually have receipts, newest first
    const counts = new Map();
    this.allReceipts.forEach(r => {
      if (r.date && /^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        const ym = r.date.slice(0, 7);
        counts.set(ym, (counts.get(ym) || 0) + 1);
      }
    });
    const months = [...counts.keys()].sort().reverse();
    const monthsWrap = document.getElementById('rangeMonthsWrap');
    const monthsEl = document.getElementById('rangeMonths');
    monthsWrap.hidden = months.length === 0;
    monthsEl.innerHTML = months.map(ym => {
      const pressed = preset === 'month' && month === ym;
      return `<button type="button" class="range-chip range-chip-month" data-month="${ym}" aria-pressed="${pressed}">${this._escape(this._monthName(ym, 'short'))} <span class="range-chip-count">${counts.get(ym)}</span></button>`;
    }).join('');

    document.getElementById('rangeCustom').hidden = preset !== 'custom';

    // Count + total for the chosen range
    const range = this._computeRange();
    const inRange = this._receiptsInRange(range);
    const total = inRange.reduce((sum, r) => sum + (parseFloat(r.amount) || 0), 0);
    const summary = document.getElementById('rangeSummary');
    const compileBtn = document.getElementById('btnCompilePdf');
    if (inRange.length === 0) {
      summary.className = 'range-summary is-empty';
      summary.innerHTML = `No receipts dated <strong>${this._escape(range.label)}</strong>.` +
        (months.length ? ' Pick a month above or another range.' : ' Add receipts on the Receipts tab first.');
      compileBtn.disabled = true;
    } else {
      summary.className = 'range-summary';
      summary.innerHTML = `<span class="range-summary-count">${inRange.length} ${inRange.length === 1 ? 'receipt' : 'receipts'}</span>` +
        `<span class="range-summary-total">$${total.toFixed(2)}</span>` +
        `<span class="range-summary-label">${this._escape(range.label)}</span>`;
      compileBtn.disabled = false;
    }
    this.renderPhoneRangeChips();
    this.renderPhonePdf();
  }

  // ---- Phone PDF: range chip, layout tiles, details sheet, Create PDF ----
  setupPhonePdf() {
    document.getElementById('mPdfTiles').addEventListener('click', (e) => {
      const tile = e.target.closest('[data-layout]');
      if (!tile) return;
      const radio = document.querySelector(`input[name="pdfLayout"][value="${tile.dataset.layout}"]`);
      if (radio && !radio.checked) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
      }
      this.renderPhonePdf();
    });
    const name = document.getElementById('mPdfName');
    const dept = document.getElementById('mPdfDept');
    const cover = document.getElementById('mPdfCover');
    document.getElementById('mPdfDetails').addEventListener('click', () => {
      name.value = document.getElementById('pdfSubmitterName').value;
      dept.value = document.getElementById('pdfDepartment').value;
      cover.checked = document.getElementById('chkAddCover').checked;
      this.openModal('modalPdfDetails');
    });
    // Copy into the laptop fields, so saving and the preview work the same
    [[name, 'pdfSubmitterName'], [dept, 'pdfDepartment']].forEach(([el, id]) => {
      el.addEventListener('input', () => {
        const target = document.getElementById(id);
        target.value = el.value;
        target.dispatchEvent(new Event('input', { bubbles: true }));
        target.dispatchEvent(new Event('change', { bubbles: true }));
        this.renderPhonePdf();
      });
    });
    cover.addEventListener('change', () => {
      const target = document.getElementById('chkAddCover');
      target.checked = cover.checked;
      target.dispatchEvent(new Event('change', { bubbles: true }));
      this.renderPhonePdf();
    });
    document.getElementById('mPdfCreate').addEventListener('click', () => document.getElementById('btnCompilePdf').click());
    document.getElementById('mPdfPrev').addEventListener('click', () => document.getElementById('btnPrevPage').click());
    document.getElementById('mPdfNext').addEventListener('click', () => document.getElementById('btnNextPage').click());
  }

  renderPhonePdf() {
    const createBtn = document.getElementById('mPdfCreate');
    if (!createBtn) return;
    const range = this._computeRange();
    const rows = this._receiptsInRange(range);
    const total = rows.reduce((s, r) => s + (parseFloat(r.amount) || 0), 0);
    createBtn.disabled = rows.length === 0;
    document.getElementById('mPdfCreateLabel').textContent = rows.length ? `Create PDF · ${this._money(total)}` : 'Create PDF';
    const layout = this.selectedLayout || 'full';
    document.querySelectorAll('#mPdfTiles [data-layout]').forEach(t =>
      t.setAttribute('aria-checked', String(t.dataset.layout === layout)));
    const who = (document.getElementById('pdfSubmitterName').value || '').trim();
    const dept = (document.getElementById('pdfDepartment').value || '').trim();
    const coverOn = document.getElementById('chkAddCover').checked;
    document.getElementById('mPdfWho').textContent = who || dept ? [who, dept].filter(Boolean).join(' · ') : 'Add your name';
    document.getElementById('mPdfWhoSub').textContent = `Name, department, cover sheet ${coverOn ? 'on' : 'off'}`;
  }

  // Mirror the laptop preview pager onto the phone pager
  _syncPhonePager() {
    const ind = document.getElementById('mPdfPageInd');
    if (!ind) return;
    ind.textContent = document.getElementById('previewPageIndicator').textContent;
    document.getElementById('mPdfPrev').disabled = document.getElementById('btnPrevPage').disabled;
    document.getElementById('mPdfNext').disabled = document.getElementById('btnNextPage').disabled;
    const n = this.previewPdfDoc ? this.previewTotalPages : 0;
    document.getElementById('mPdfPages').textContent = n ? `${n} ${n === 1 ? 'page' : 'pages'}` : '';
  }

  _categorySlug(category) {
    return window.expenseLabels.categorySlug(category);
  }

  _fillLabeledSelect(selectId, options, current, canonicalize) {
    const selectEl = document.getElementById(selectId);
    if (!selectEl) return;
    const canon = canonicalize(current);
    const raw = (current || '').trim();
    selectEl.innerHTML = '';

    const addOption = (value, selected) => {
      const opt = document.createElement('option');
      opt.value = value;
      opt.textContent = value;
      if (selected) opt.selected = true;
      selectEl.appendChild(opt);
    };

    if (raw && !canon && !options.includes(raw)) {
      addOption(raw, true);
    }
    options.forEach(opt => addOption(opt, canon ? canon === opt : raw === opt));
  }

  _optionsHtml(options, current, canonicalize) {
    const canon = canonicalize(current);
    const raw = (current || '').trim();
    const parts = [];
    if (raw && !canon && !options.includes(raw)) {
      parts.push(`<option value="${this._escape(raw)}" selected>${this._escape(raw)}</option>`);
    }
    options.forEach(opt => {
      const selected = (canon ? canon === opt : raw === opt) ? ' selected' : '';
      parts.push(`<option value="${this._escape(opt)}"${selected}>${this._escape(opt)}</option>`);
    });
    return parts.join('');
  }

  _escape(str) {
    if (!str) return '';
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}

// Bootstrap Application on DOM Ready
window.addEventListener('DOMContentLoaded', () => {
  window.expenseApp = new ExpenseApp();
  window.expenseApp.init();
});
