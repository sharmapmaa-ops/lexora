# ⚖️ Lexora — Lease Abstraction AI Tool

> RAG · Structured Extraction · Review UI  
> RAG-grounded Claude extraction with source citations.

---

## 📁 Project Structure

```
/
├── .devcontainer/
│   └── devcontainer.json        # GitHub Codespace config
├── css/
│   ├── style.css                # Main app styles
│   └── auth.css                 # Login / auth page styles
├── db/
│   ├── users.json               # User accounts (localStorage-seeded)
│   ├── rules.json               # Lease extraction rules
│   ├── smtp_config.json         # SMTP email settings
│   └── transaction_history.json # Transaction data
├── js/
│   ├── app.js                   # Main application logic
│   └── auth.js                  # Authentication (login · register · reset)
├── py/
│   └── server.py                # Python HTTP dev server
├── login.html                   # 🔑 Entry point — login / register / forgot password
├── index.html                   # 🏠 Main application (requires auth)
└── README.md
```

---

## 🚀 Quick Start

### Option 1 — GitHub Codespace (recommended)

1. Open this repo in GitHub Codespaces
2. The server auto-starts on port **8080**
3. A preview opens automatically at `login.html`

### Option 2 — Local (Python)

```bash
# From project root:
python3 py/server.py
# → http://localhost:8080/login.html
```

### Option 3 — Direct browser

Open `login.html` directly in Chrome / Edge / Firefox (no server needed for basic use).

---

## 🔐 Default Login Credentials

| Email                   | Password | Role  |
|-------------------------|----------|-------|
| `himmat4f1@gmail.com`   | `123456` | Admin |

> **Note:** Credentials are stored in `localStorage`. To reset, clear browser storage or delete the `lexora_users` key.

---

## 🔑 Auth Features

| Feature          | Description                                              |
|------------------|----------------------------------------------------------|
| **Login**        | Email + password with session stored in `localStorage`   |
| **Forgot Pwd**   | Two-step flow: enter email → get code → set new password |
| **Create Account** | Full registration form with validation                 |
| **Session guard** | `index.html` redirects to `login.html` if not logged in |
| **Logout**       | Clears session and returns to `login.html`               |

---

## 🗄️ Database (JSON Files)

All data is stored in JSON files under `db/`. The auth system also uses `localStorage` as a client-side database (seeded from `db/users.json` on first visit).

| File                      | Purpose                              |
|---------------------------|--------------------------------------|
| `db/users.json`           | User accounts seed data              |
| `db/rules.json`           | Lease extraction rule definitions    |
| `db/smtp_config.json`     | SMTP server configuration            |
| `db/transaction_history.json` | Payment transaction records      |

---

## 🐍 Python Server API

The dev server (`py/server.py`) exposes simple read endpoints:

| Endpoint          | Method | Description              |
|-------------------|--------|--------------------------|
| `/api/health`     | GET    | Server health check      |
| `/api/users`      | GET    | Read users.json          |
| `/api/smtp`       | GET    | Read smtp_config.json    |
| `/api/smtp/save`  | POST   | Save SMTP config (JSON body) |

---

## 📦 Tech Stack

- **Frontend:** Vanilla HTML5, CSS3, JavaScript (ES6+)
- **Icons:** Font Awesome 6
- **Auth:** `localStorage` session + client-side hashing
- **Database:** JSON flat-files + `localStorage`
- **Server:** Python 3 `http.server` (zero dependencies)
- **Hosting:** GitHub Codespace / any static host

---

## 🔧 Codespace Port Forwarding

The `.devcontainer/devcontainer.json` auto-forwards port **8080**. When Codespace starts, the browser preview opens `login.html` automatically.

If you need a different port:
```bash
python3 py/server.py 3000
```

---

## 📝 License

© 2026 Lexora AI Solutions. All rights reserved.
