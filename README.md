# 🧾 ExpenseSnap - Cross-Platform Receipt Compiler & Expense Tracker

A lightweight, modern web and mobile application designed to run seamlessly across your **iOS work phone**, **personal Android phone**, and **Windows laptop**.

Built specifically for the workflow where you:
1. Capture photos of paper receipts on your phone or upload digital PDF receipts (such as Uber ride receipts downloaded from the website).
2. Need **all receipts compiled into one single PDF document** for your employer.
3. Need to fill out a company-provided **Excel spreadsheet** with corresponding dates, merchants, and amounts.

---

## 🚀 Quick Start on Your Windows Laptop

1. Double-click **`start.bat`** (or open a terminal and run `python server.py`).
2. Open your browser on Windows to:
   ```
   http://localhost:8080
   ```
3. To open on your **iOS Work Phone** or **Android Phone**:
   - Make sure your phone is connected to the same Wi-Fi network as your laptop.
   - Look at the terminal output from `server.py` for your Wi-Fi address (e.g. `http://192.168.1.XX:8080`).
   - Open that link in **Safari** (iOS) or **Chrome** (Android).
   - Tap **Share ➔ Add to Home Screen** on your phone to install it like a native mobile app!

---

## ✨ Features & Capabilities

### 1. Universal Receipt Ingestion
- **Camera Capture**: Directly activates your phone's rear camera with autofocus for crisp paper receipts.
- **Image Formats**: Supports JPG, PNG, and iPhone HEIC photos.
- **Digital PDFs (Uber, Airlines, Hotels)**: Upload native `.pdf` files. Vector text and crisp formatting are preserved when compiling into the final combined PDF.
- **Thermal Receipt Enhancer**: 1-click contrast booster that sharpens faint or faded thermal paper slips (gas stations, dinners).
- **Quick Rotation**: 90° rotation buttons to fix receipts snapped sideways.

### 2. Single Unified PDF Compilation
- **Layout Choices**:
  - **Full Page per Receipt**: Dedicated high-resolution page per receipt with an itemized header. Digital PDFs (like Uber receipts) are embedded with 100% original vector clarity.
  - **2 Receipts per Page**: Stacked top-and-bottom cards with metadata badges to save paper.
  - **Compact Grid (4 per Page)**: 2x2 grid ideal for small slips (parking, coffee, tolls).
- **Executive Summary Cover Sheet**:
  - Automatically prepends page 1 with an itemized summary table listing:
    - Item Number (#1, #2, #3...) matching receipt order.
    - Date, Merchant, Category, Payment Method, and Amount.
    - Submitter Name, Department, and Grand Total.

### 3. Company Spreadsheet Companion
- **1-Click "Copy Table for Excel"**:
  - Formats your ledger rows as Tab-Separated Values (TSV) on your clipboard.
  - Switch to your company-provided Excel template, click cell **A1** (or the first row), and press **`Ctrl+V`**. All values align cleanly into columns without altering template formulas or formatting.
- **Direct Excel Export (`.xlsx`)**: Generates a pre-formatted Excel workbook with column widths and currency formatting.
- **CSV Export**: Standard CSV for accounting software.

### 4. Cross-Device Sync & Portability
- **Local & Offline-First (IndexedDB)**: Works immediately out of the box with zero cloud setup needed.
- **Multi-Device Room Pairing (off by default)**: Turn on Sync in Settings, then use the 6-character room code to link your phone and laptop. Sync goes through a free public relay (broker.hivemq.com) and is not encrypted yet, so nothing connects until you turn it on.
- **Full Data Backup**: 1-click JSON backup and restore to save or move your expense reports anytime.

---

### 5. Accounts (sign in with email)
- Signed out (default): receipts stay only on this device, like before.
- Signed in: each person has a private account. Receipts, photos, and PDFs are saved in Cloud Firestore under `users/{uid}/` and appear on every phone or laptop signed in to that account, even if the other device was off.
- Works offline: changes wait on the device and upload when you're back online.
- Photos and PDFs are stored in Firestore in ~700 KB pieces, so no Cloud Storage bucket (and no Blaze plan) is needed. Max ~9 MB per receipt file.
- Security rules (`firestore.rules`) let each account read and write only its own data.
- One-time setup in the Firebase console (Firestore database, Email/Password sign-in, web app config pasted into `js/cloud-account.js`), then `firebase deploy --only firestore,hosting --project expensesnap-jp`. Until the config is pasted in, the Account section stays hidden.
- Local testing: `npx firebase-tools emulators:start --only auth,firestore --project demo-expensesnap`, then open the app on `http://127.0.0.1:<port>/?emulator`.

## 📁 Project Structure

```
Expense App/
├── index.html                 # Main application interface (responsive PWA)
├── manifest.json              # PWA manifest for home screen installation
├── sw.js                      # Offline caching service worker
├── server.py                  # Local development & Wi-Fi sharing server
├── start.bat                  # 1-click launcher for Windows
├── firebase.json              # Firebase Hosting configuration (optional cloud hosting)
├── css/
│   └── app.css                # Mobile-first styling & touch-optimized design
├── js/
│   ├── app.js                 # Main UI controller & event orchestrator
│   ├── store.js               # IndexedDB local storage & state management
│   ├── receipt-manager.js     # Image enhancement, rotation & PDF.js parser
│   ├── pdf-compiler.js        # pdf-lib engine for compiling unified PDF
│   ├── spreadsheet-helper.js  # Excel clipboard formatting & .xlsx generator
│   └── firebase-config.js     # Cloud sync & device pairing manager
├── icons/
│   └── icon.svg               # App icon (receipt + camera badge)
└── vendor/
    ├── pdf-lib.min.js         # Client-side PDF generation
    ├── pdf.min.js             # Client-side PDF rendering
    ├── pdf.worker.min.js      # Web worker for PDF parsing
    └── xlsx.full.min.js       # Excel workbook generation
```
