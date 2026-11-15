/**
 * ExpenseSnap - Spreadsheet Companion & Excel Exporter
 * Facilitates 1-click clipboard paste into company templates and generates .xlsx / .csv files.
 */

class SpreadsheetHelper {
  constructor() {
    this.XLSX = window.XLSX;
  }

  /**
   * Generates Tab-Separated Values (TSV) and copies to clipboard for direct paste into Excel.
   * @param {Array} receipts Ordered receipts array
   * @param {Boolean} includeHeaders Whether to include column headers
   */
  async copyTableForExcel(receipts, includeHeaders = true) {
    if (!receipts || receipts.length === 0) {
      throw new Error('No receipts to copy.');
    }

    const rows = [];
    if (includeHeaders) {
      rows.push(['#', 'Date', 'Merchant / Vendor', 'Category', 'Payment Method', 'Amount', 'Notes'].join('\t'));
    }

    receipts.forEach((r, idx) => {
      const lineNum = idx + 1;
      const date = r.date || '';
      const merchant = (r.merchant || '').replace(/[\t\n\r]/g, ' ');
      const category = this._displayCategory(r).replace(/[\t\n\r]/g, ' ');
      const paymentMethod = this._displayPayment(r).replace(/[\t\n\r]/g, ' ');
      const amount = (parseFloat(r.amount) || 0).toFixed(2);
      const notes = (r.notes || '').replace(/[\t\n\r]/g, ' ');

      rows.push([lineNum, date, merchant, category, paymentMethod, amount, notes].join('\t'));
    });

    const tsvData = rows.join('\r\n');

    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(tsvData);
      return { count: receipts.length, characters: tsvData.length };
    } else {
      // Fallback for older browsers
      const textarea = document.createElement('textarea');
      textarea.value = tsvData;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      return { count: receipts.length, characters: tsvData.length };
    }
  }

  /**
   * Export receipts as a Microsoft Excel (.xlsx) file
   */
  exportToExcel(report, receipts) {
    if (!window.XLSX) {
      throw new Error('XLSX library not loaded.');
    }
    const XLSX = window.XLSX;

    const data = [
      ['Expense Report:', report.title || 'Expenses'],
      ['Submitter:', report.submitterName || ''],
      ['Department:', report.department || ''],
      ['Export Date:', new Date().toISOString().split('T')[0]],
      [], // Blank row
      ['Item #', 'Date', 'Merchant / Vendor', 'Category', 'Payment Method', 'Amount ($)', 'Notes']
    ];

    let grandTotal = 0;
    receipts.forEach((r, idx) => {
      const amt = parseFloat(r.amount) || 0;
      grandTotal += amt;
      data.push([
        idx + 1,
        r.date || '',
        r.merchant || '',
        this._displayCategory(r),
        this._displayPayment(r),
        amt,
        r.notes || ''
      ]);
    });

    // Add Total Row
    data.push([]);
    data.push(['', '', '', '', 'TOTAL:', grandTotal, '']);

    const ws = XLSX.utils.aoa_to_sheet(data);

    // Set column widths
    ws['!cols'] = [
      { wch: 8 },  // Item #
      { wch: 14 }, // Date
      { wch: 26 }, // Merchant
      { wch: 22 }, // Category
      { wch: 18 }, // Payment Method
      { wch: 14 }, // Amount
      { wch: 32 }  // Notes
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Expense Details');

    const cleanTitle = (report.title || 'Expense_Report').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${cleanTitle}_${new Date().toISOString().split('T')[0]}.xlsx`;

    XLSX.writeFile(wb, fileName);
  }

  /**
   * Export receipts as a CSV file
   */
  exportToCsv(report, receipts) {
    const headers = ['Item #', 'Date', 'Merchant', 'Category', 'Payment Method', 'Amount', 'Notes'];
    const rows = [headers];

    receipts.forEach((r, idx) => {
      rows.push([
        idx + 1,
        `"${(r.date || '').replace(/"/g, '""')}"`,
        `"${(r.merchant || '').replace(/"/g, '""')}"`,
        `"${this._displayCategory(r).replace(/"/g, '""')}"`,
        `"${this._displayPayment(r).replace(/"/g, '""')}"`,
        (parseFloat(r.amount) || 0).toFixed(2),
        `"${(r.notes || '').replace(/"/g, '""')}"`
      ]);
    });

    const csvContent = rows.map(row => row.join(',')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const cleanTitle = (report.title || 'Expense_Report').replace(/[^a-zA-Z0-9_-]/g, '_');
    const fileName = `${cleanTitle}.csv`;

    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = fileName;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  _displayCategory(receipt) {
    if (window.expenseLabels && window.expenseLabels.displayCategory) {
      return window.expenseLabels.displayCategory(receipt.category);
    }
    return receipt.category || '';
  }

  _displayPayment(receipt) {
    if (window.expenseLabels && window.expenseLabels.displayPayment) {
      return window.expenseLabels.displayPayment(receipt.paymentMethod);
    }
    return receipt.paymentMethod || '';
  }
}

window.spreadsheetHelper = new SpreadsheetHelper();
