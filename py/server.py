#!/usr/bin/env python3
"""
Lexora Development Server  v3.0
Usage:
  python3 py/server.py          # port 8080
  python3 py/server.py 3000     # custom port
"""

import http.server, socketserver, os, sys, json, datetime, base64, smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from urllib.parse import urlparse

PORT     = int(os.environ.get("PORT", sys.argv[1] if len(sys.argv) > 1 else 8080))
ROOT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_DIR   = os.path.join(ROOT_DIR, "db")
USER_DIR = os.path.join(ROOT_DIR, "user_directory")

USERS_FILE = os.path.join(DB_DIR, "users.json")
SMTP_FILE  = os.path.join(DB_DIR, "smtp_config.json")
PAY_FILE   = os.path.join(DB_DIR, "payment_methods.json")
TXN_FILE   = os.path.join(DB_DIR, "transaction_history.json")


# ── Email helper ─────────────────────────────────────────────────────────────
def load_smtp():
    try:
        with open(SMTP_FILE, "r") as f:
            return json.load(f)
    except Exception:
        return {}


def send_email(to_list, subject, body_html, body_text=""):
    cfg = load_smtp()
    if not cfg.get("host") or not cfg.get("username") or not cfg.get("password"):
        raise ValueError("SMTP not configured in smtp_config.json")
    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"]    = cfg.get("sender_email", cfg["username"])
    msg["To"]      = ", ".join(to_list) if isinstance(to_list, list) else to_list
    if body_text:
        msg.attach(MIMEText(body_text, "plain"))
    msg.attach(MIMEText(body_html, "html"))
    port = int(cfg.get("port", 587))
    recipients = to_list if isinstance(to_list, list) else [to_list]
    # Port 465 = SSL directly, Port 587/25 = STARTTLS
    if port == 465:
        import ssl as _ssl
        ctx = _ssl.create_default_context()
        with smtplib.SMTP_SSL(cfg["host"], port, context=ctx, timeout=15) as server:
            server.login(cfg["username"], cfg["password"])
            server.sendmail(cfg.get("sender_email", cfg["username"]), recipients, msg.as_string())
    else:
        with smtplib.SMTP(cfg["host"], port, timeout=15) as server:
            if cfg.get("use_tls", True):
                server.starttls()
            server.login(cfg["username"], cfg["password"])
            server.sendmail(cfg.get("sender_email", cfg["username"]), recipients, msg.as_string())


# ── Request Handler ──────────────────────────────────────────────────────────
class LexoraHandler(http.server.SimpleHTTPRequestHandler):

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT_DIR, **kwargs)

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin",  "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    # ── GET ──────────────────────────────────────────────────────────────
    def do_GET(self):
        p = urlparse(self.path).path

        if p == "/":
            self.send_response(302)
            self.send_header("Location", "/index.html")
            self.end_headers()
            return

        routes = {
            "/api/health": lambda: {"status": "ok",
                                    "time": datetime.datetime.utcnow().isoformat(),
                                    "server": "Lexora Dev Server v3.0"},
            "/api/users":  lambda: self._read(USERS_FILE),
            "/api/smtp":   lambda: self._read(SMTP_FILE),
        }
        if p in routes:
            self._json(routes[p]())
            return

        if p == "/api/files/list":
            try:
                SKIP = {'.git','__pycache__','node_modules','.devcontainer',
                        '.env','venv','.venv','.DS_Store','lexora_production.zip'}

                def scan_dir(directory, rel_prefix, depth=0, max_depth=6):
                    results = []
                    try:
                        for entry in sorted(os.scandir(directory),
                                            key=lambda e: (not e.is_dir(), e.name.lower())):
                            if entry.name in SKIP or entry.name.startswith('.'):
                                continue
                            rel = (rel_prefix + '/' + entry.name) if rel_prefix else entry.name
                            mt  = datetime.datetime.fromtimestamp(
                                    entry.stat().st_mtime).strftime('%Y-%m-%d %H:%M')
                            if entry.is_dir():
                                results.append({"name": entry.name, "path": rel,
                                                "type": "folder", "ext": "",
                                                "size": "—", "modified": mt})
                                if depth < max_depth:
                                    results.extend(scan_dir(entry.path, rel,
                                                            depth + 1, max_depth))
                            else:
                                sz  = entry.stat().st_size
                                ext = entry.name.rsplit('.',1)[-1].lower() if '.' in entry.name else ''
                                sz_str = (str(round(sz/1024,1))+' KB') if sz>=1024 else (str(sz)+' B')
                                results.append({"name": entry.name, "path": rel,
                                                "type": "file", "ext": ext,
                                                "size": sz_str, "modified": mt})
                    except PermissionError:
                        pass
                    return results

                files = scan_dir(ROOT_DIR, '')
                self._json({"success": True, "files": files, "count": len(files)})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        super().do_GET()

    # ── POST ─────────────────────────────────────────────────────────────
    def do_POST(self):
        p    = urlparse(self.path).path
        body = self._body()

        # /api/users/save
        if p == "/api/users/save":
            try:
                inc       = json.loads(body)
                new_users = inc.get("users", [])
                for u in new_users:
                    u.pop("profile_photo_data", None)
                existing = self._read(USERS_FILE)
                if "error" in existing:
                    existing = {"version": 2, "schema": "lexora_users",
                                "resetCodes": [], "users": []}
                existing["users"]      = new_users
                existing["totalUsers"] = len(new_users)
                existing["updatedAt"]  = datetime.datetime.utcnow().isoformat()
                self._write(USERS_FILE, existing)
                self._log(f"💾  users.json saved ({len(new_users)} user(s))")
                self._json({"success": True, "count": len(new_users)})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/smtp/save
        if p == "/api/smtp/save":
            try:
                self._write(SMTP_FILE, json.loads(body))
                self._log("💾  smtp_config.json saved")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/users/photo/save
        if p == "/api/users/photo/save":
            try:
                data      = json.loads(body)
                user_id   = data.get("userId", "unknown")
                photo_b64 = data.get("photoData", "")
                ext       = data.get("extension", "jpg").lower().lstrip(".")
                if "," in photo_b64:
                    photo_b64 = photo_b64.split(",", 1)[1]
                img_bytes = base64.b64decode(photo_b64)
                save_dir  = os.path.join(USER_DIR, user_id, "profile_photo")
                os.makedirs(save_dir, exist_ok=True)
                filename  = f"photo.{ext}"
                full_path = os.path.join(save_dir, filename)
                with open(full_path, "wb") as f:
                    f.write(img_bytes)
                rel_path = f"user_directory/{user_id}/profile_photo/{filename}"
                self._log(f"🖼️  Photo saved: {rel_path} ({len(img_bytes)//1024}KB)")
                self._json({"success": True, "path": rel_path})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/payments/save
        if p == "/api/payments/save":
            try:
                data    = json.loads(body)
                uid     = data.get("userId", "")
                methods = data.get("methods", [])
                existing = self._read(PAY_FILE)
                if "error" in existing:
                    existing = {"version": 1, "schema": "lexora_payment_methods",
                                "user_payments": {}}
                if "user_payments" not in existing:
                    existing["user_payments"] = {}
                if uid not in existing["user_payments"]:
                    existing["user_payments"][uid] = {"balance": 0, "methods": []}
                existing["user_payments"][uid]["methods"] = methods
                existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
                self._write(PAY_FILE, existing)
                self._log(f"💳  payment_methods.json saved ({uid})")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/transactions/save
        if p == "/api/transactions/save":
            try:
                data    = json.loads(body)
                uid     = data.get("userId", "")
                txns    = data.get("transactions", [])
                summary = data.get("summary", {})
                existing = self._read(TXN_FILE)
                if "error" in existing:
                    existing = {"version": 2, "schema": "lexora_transactions",
                                "user_transactions": {}}
                if "user_transactions" not in existing:
                    existing["user_transactions"] = {}
                existing["user_transactions"][uid] = {
                    "transactions": txns,
                    "summary": summary
                }
                existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
                self._write(TXN_FILE, existing)
                self._log(f"📊  transaction_history.json saved ({uid}, {len(txns)} txns)")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/contact/send
        if p == "/api/contact/send":
            try:
                data         = json.loads(body)
                subject      = data.get("subject", "(No Subject)")
                message      = data.get("message", "")
                sender_email = data.get("senderEmail", "")
                receiver     = load_smtp().get("receiver_email", "")
                if not receiver:
                    self._json({"success": False,
                                "error": "No receiver_email set in Email Settings."})
                    return
                admin_html = (
                    f"<h3>New Contact Message</h3>"
                    f"<p><b>From:</b> {sender_email}</p>"
                    f"<p><b>Subject:</b> {subject}</p><hr>"
                    f"<p>{message.replace(chr(10), '<br>')}</p>"
                )
                send_email(receiver, f"[Lexora] {subject}", admin_html)
                if sender_email:
                    thanks_html = (
                        f"<h3>Thank you for contacting Lexora!</h3>"
                        f"<p>We received your message and will get back to you shortly.</p>"
                        f"<hr><p><b>Your message:</b><br>"
                        f"{message.replace(chr(10), '<br>')}</p>"
                        f"<p style='color:#64748b;font-size:0.85em;'>— Lexora AI Solutions</p>"
                    )
                    send_email(sender_email, "We received your message — Lexora", thanks_html)
                self._log(f"📧  Contact email sent → {receiver}")
                self._json({"success": True})
            except Exception as e:
                self._log(f"⚠️  Contact email failed: {e}")
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/email/test
        if p == "/api/email/test":
            try:
                data = json.loads(body)
                to   = data.get("to", "")
                if not to:
                    self._json({"success": False, "error": "No recipient."})
                    return
                html_body = (
                    "<h3>Lexora — Test Email</h3>"
                    "<p>Your SMTP configuration is working correctly!</p>"
                    "<p style='color:#64748b;'>Sent from Lexora Dev Server v3.0</p>"
                )
                send_email(to, "Lexora — SMTP Test", html_body)
                self._log(f"📧  Test email sent → {to}")
                self._json({"success": True})
            except Exception as e:
                self._log(f"⚠️  Test email failed: {e}")
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/plans/save
        if p == "/api/plans/save":
            try:
                data  = json.loads(body)
                plans = data.get("plans", [])
                plans_file = os.path.join(DB_DIR, "plans.json")
                existing   = self._read(plans_file)
                if "error" in existing:
                    existing = {"version":1,"schema":"lexora_plans","plans":[]}
                existing["plans"]     = plans
                existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
                self._write(plans_file, existing)
                self._log(f"📋  plans.json saved ({len(plans)} plans)")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/files/read
        if p == "/api/files/read":
            try:
                data     = json.loads(body)
                rel_path = data.get("path", "").replace("..","")
                full     = os.path.join(ROOT_DIR, rel_path)
                if not os.path.isfile(full):
                    self._json({"success": False, "error": "File not found."})
                    return
                with open(full, "r", encoding="utf-8", errors="replace") as f:
                    content = f.read()  # Full file read
                self._json({"success": True, "content": content})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/files/delete — supports files AND folders
        if p == "/api/files/delete":
            try:
                import shutil
                data     = json.loads(body)
                rel_path = data.get("path", "").replace("..","").lstrip("/")
                PROTECTED = {"db/users.json","db/smtp_config.json","db/api_config.json",
                             "py/server.py","index.html","db","py","js","css"}
                if not rel_path or rel_path in PROTECTED:
                    self._json({"success": False, "error": "This path is protected."})
                    return
                full = os.path.join(ROOT_DIR, rel_path)
                if os.path.isfile(full):
                    os.remove(full)
                    self._log(f"🗑️  Deleted file: {rel_path}")
                    self._json({"success": True})
                elif os.path.isdir(full):
                    shutil.rmtree(full)
                    self._log(f"🗑️  Deleted folder: {rel_path}")
                    self._json({"success": True})
                else:
                    self._json({"success": False, "error": f"Not found: {rel_path}"})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/company/save
        if p == "/api/company/save":
            try:
                data = json.loads(body)
                company_file = os.path.join(DB_DIR, "company.json")
                existing = self._read(company_file)
                if "error" in existing:
                    existing = {"version":1,"schema":"lexora_company","company":{},"scheduled_changes":[]}
                existing["company"] = data.get("company", existing.get("company", {}))
                existing["scheduled_changes"] = data.get("scheduled_changes", [])
                existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
                self._write(company_file, existing)
                self._log("🏢  company.json saved")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/register/request — Save to temp_accounts.json + send verification email
        if p == "/api/register/request":
            try:
                import random, string
                data = json.loads(body)
                temp_file = os.path.join(DB_DIR, "temp_accounts.json")
                existing  = self._read(temp_file)
                if "error" in existing: existing = {"version":1,"schema":"lexora_temp_accounts","pending":[]}
                code    = ''.join(random.choices(string.digits, k=6))
                expiry  = (datetime.datetime.utcnow() + datetime.timedelta(minutes=15)).isoformat()
                pending = {**data, "verification_code": code, "code_expires": expiry,
                           "requestedAt": datetime.datetime.utcnow().isoformat()}
                existing.setdefault("pending", []).append(pending)
                self._write(temp_file, existing)
                # Try send email
                try:
                    html_body = f"<h3>Verify Your Lexora Account</h3><p>Code: <b>{code}</b></p><p>Expires in 15 minutes.</p>"
                    send_email(data.get("email",""), "Lexora — Verify Your Account", html_body)
                    self._json({"success": True, "emailSent": True})
                except Exception:
                    self._json({"success": True, "emailSent": False, "code": code})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/register/approve — Move from temp to users.json
        if p == "/api/register/approve":
            try:
                data = json.loads(body)
                pidx = data.get("pendingIndex", -1)
                temp_file  = os.path.join(DB_DIR, "temp_accounts.json")
                temp_data  = self._read(temp_file)
                pending    = temp_data.get("pending", [])
                if pidx < 0 or pidx >= len(pending):
                    self._json({"success": False, "error": "Invalid index"}); return
                p_acc = pending.pop(pidx)
                self._write(temp_file, {**temp_data, "pending": pending})
                users_data = self._read(USERS_FILE)
                new_user = {
                    "id": "usr_" + str(int(datetime.datetime.utcnow().timestamp())),
                    "firstName": p_acc.get("firstName",""), "lastName": p_acc.get("lastName",""),
                    "gender": p_acc.get("gender",""), "dob": p_acc.get("dob",""),
                    "mobile": p_acc.get("mobile",""), "email": p_acc.get("email",""),
                    "passwordHash": p_acc.get("passwordHash",""), "role": "user",
                    "account_type": "user", "plan": "Basic", "balance": 0.0,
                    "apikey": "", "lock": "no", "status": "active", "session_status": "offline",
                    "verification_code": "", "profile_photo": "", "profile_photo_data": "",
                    "input_folder": "", "output_folder": "", "createdAt": datetime.datetime.utcnow().isoformat(),
                    "lastLogin": None, "active": True,
                    "system_setup": {"theme":"light","language":"en","timezone":"UTC","email_notifications":True}
                }
                users_data.setdefault("users", []).append(new_user)
                users_data["totalUsers"] = len(users_data["users"])
                self._write(USERS_FILE, users_data)
                self._log(f"✅  Account approved: {new_user['email']}")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/register/reject — Remove from temp_accounts.json
        if p == "/api/register/reject":
            try:
                data = json.loads(body)
                pidx = data.get("pendingIndex", -1)
                temp_file = os.path.join(DB_DIR, "temp_accounts.json")
                temp_data = self._read(temp_file)
                pending   = temp_data.get("pending", [])
                if 0 <= pidx < len(pending):
                    pending.pop(pidx)
                    self._write(temp_file, {**temp_data, "pending": pending})
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/files/write — Edit/save a file content
        if p == "/api/files/write":
            try:
                data     = json.loads(body)
                rel_path = data.get("path","").replace("..","")
                new_content = data.get("content","")
                PROTECTED = {"db/users.json","db/api_config.json","py/server.py"}
                if rel_path in PROTECTED:
                    self._json({"success":False,"error":"File is protected."}); return
                full = os.path.join(ROOT_DIR, rel_path)
                if not os.path.isfile(full):
                    self._json({"success":False,"error":"File not found."}); return
                with open(full, "w", encoding="utf-8") as f:
                    f.write(new_content)
                self._log(f"💾  File saved: {rel_path}")
                self._json({"success":True})
            except Exception as e:
                self._json({"success":False,"error":str(e)},400)
            return


        # /api/auth/sendcode — Send verification code email for login
        if p == "/api/auth/sendcode":
            try:
                data       = json.loads(body)
                to_email   = data.get("email", "")
                code       = data.get("code", "")
                expiry     = data.get("expiryMins", 4)
                html_body  = f"""<h3>Lexora Login Verification</h3>
<p>Your verification code is: <b style='font-size:1.4rem;letter-spacing:4px;'>{code}</b></p>
<p>This code expires in <b>{expiry} minutes</b>.</p>
<p style='color:#64748b;font-size:0.85em;'>If you did not request this, ignore this email.</p>"""
                send_email(to_email, "Lexora — Login Verification Code", html_body)
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/templates/save — Save templates.json
        if p == "/api/templates/save":
            try:
                data       = json.loads(body)
                tmpl_file  = os.path.join(DB_DIR, "templates.json")
                existing   = self._read(tmpl_file)
                if "error" in existing: existing = {"version":1,"schema":"lexora_templates","templates":[]}
                existing["templates"] = data.get("templates", [])
                existing["updatedAt"] = datetime.datetime.utcnow().isoformat()
                self._write(tmpl_file, existing)
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return

        # /api/templates/upload — Upload a template file + update templates.json
        if p == "/api/templates/upload":
            try:
                data       = json.loads(body)
                template   = data.get("template", {})
                file_data  = data.get("fileData", "")
                file_name  = data.get("fileName", "file")
                folder_path = template.get("folder_path", "Template")
                save_dir   = os.path.join(ROOT_DIR, folder_path)
                os.makedirs(save_dir, exist_ok=True)
                full_path  = os.path.join(save_dir, file_name)
                with open(full_path, "wb") as f:
                    f.write(base64.b64decode(file_data))
                # Update templates.json
                tmpl_file  = os.path.join(DB_DIR, "templates.json")
                existing   = self._read(tmpl_file)
                if "error" in existing: existing = {"version":1,"schema":"lexora_templates","templates":[]}
                templates  = existing.get("templates", [])
                template["id"] = max([t.get("id",0) for t in templates], default=0) + 1
                templates.append(template)
                existing["templates"] = templates
                self._write(tmpl_file, existing)
                self._log(f"📄  Template uploaded: {folder_path}/{file_name}")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/files/download — Serve a file for download
        if p.startswith("/api/files/download"):
            from urllib.parse import parse_qs, unquote
            qs       = urlparse(self.path).query
            params   = parse_qs(qs)
            raw_path = params.get('path', [''])[0]
            rel_path = unquote(raw_path).replace('..', '').lstrip('/')
            full     = os.path.join(ROOT_DIR, rel_path)
            if not os.path.isfile(full):
                self.send_response(404)
                self.send_header('Content-Type', 'text/plain')
                self.end_headers()
                self.wfile.write(f"File not found: {rel_path}".encode())
                return
            with open(full, 'rb') as f:
                data = f.read()
            fname = os.path.basename(full)
            self.send_response(200)
            self.send_header('Content-Type', 'application/octet-stream')
            self.send_header('Content-Disposition', f'attachment; filename="{fname}"')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return

        # /api/files/upload — Upload binary file via base64
        if p == "/api/files/upload":
            try:
                data     = json.loads(body)
                rel_path = data.get("path","").replace("..","")
                file_b64 = data.get("fileData","")
                full     = os.path.join(ROOT_DIR, rel_path)
                os.makedirs(os.path.dirname(full), exist_ok=True)
                with open(full, "wb") as f:
                    f.write(base64.b64decode(file_b64))
                self._log(f"📤  Uploaded: {rel_path}")
                self._json({"success":True})
            except Exception as e:
                self._json({"success":False,"error":str(e)},400)
            return

        # /api/register/approve-direct — Moves user from temp to users.json by email
        if p == "/api/register/approve-direct":
            try:
                data      = json.loads(body)
                email     = data.get("email","")
                temp_file = os.path.join(DB_DIR,"temp_accounts.json")
                temp_data = self._read(temp_file)
                pending   = temp_data.get("pending",[])
                acc       = next((x for x in pending if x.get("email")==email), None)
                if acc:
                    pending = [x for x in pending if x.get("email")!=email]
                    self._write(temp_file,{**temp_data,"pending":pending})
                    users_data = self._read(USERS_FILE)
                    users_data.setdefault("users",[]).append(acc)
                    self._write(USERS_FILE,users_data)
                self._json({"success":True})
            except Exception as e:
                self._json({"success":False,"error":str(e)},400)
            return


        # /api/files/mkdir — Create a directory
        if p == "/api/files/mkdir":
            try:
                data     = json.loads(body)
                rel_path = data.get("path","").replace("..","")
                full     = os.path.join(ROOT_DIR, rel_path)
                os.makedirs(full, exist_ok=True)
                self._log(f"📁  Folder created: {rel_path}")
                self._json({"success": True})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/templates/scan — Scan Template/ folder and return structure
        if p == "/api/templates/scan":
            try:
                base = os.path.join(ROOT_DIR, "Template", "Lease Abstraction")
                result = {"folders": []}
                if os.path.isdir(base):
                    for folder in sorted(os.listdir(base)):
                        fpath = os.path.join(base, folder)
                        if not os.path.isdir(fpath): continue
                        files = []
                        for fname in sorted(os.listdir(fpath)):
                            ffull = os.path.join(fpath, fname)
                            if os.path.isfile(ffull):
                                name_no_ext = os.path.splitext(fname)[0]
                                rel_path = "Template/Lease Abstraction/" + folder + "/" + fname
                                files.append({
                                    "filename": fname,
                                    "name": name_no_ext,
                                    "path": rel_path,
                                    "folder": folder,
                                    "ext": os.path.splitext(fname)[1].lower()
                                })
                        result["folders"].append({ "name": folder, "files": files })
                self._json({"success": True, "data": result})
            except Exception as e:
                self._json({"success": False, "error": str(e)}, 400)
            return


        # /api/extract — Proxy to OpenRouter (Claude extraction)
        if p == "/api/extract":
            try:
                import urllib.request as ureq
                data       = json.loads(body)
                messages   = data.get('messages', [])
                system_msg = data.get('system', '')
                max_tokens = data.get('max_tokens', 16000)
                task       = data.get('task', 'extraction')
                model      = data.get('model', 'anthropic/claude-sonnet-4-5')

                # Model routing (same as old project)
                MODEL_MAP = {
                    'extraction': 'anthropic/claude-sonnet-4-5',
                    'critique':   'anthropic/claude-opus-4.7',
                    'validation': 'openai/gpt-4o-mini',
                    'quick':      'openai/gpt-4o-mini',
                }
                if not data.get('model'):
                    model = MODEL_MAP.get(task, MODEL_MAP['extraction'])

                # Load API key from db/api_config.json
                cfg_file   = os.path.join(DB_DIR, 'api_config.json')
                cfg        = self._read(cfg_file)
                providers  = cfg.get('providers', [])
                or_key     = next((p['api_key'] for p in providers if p.get('id') == 'openrouter'), '')

                if not or_key:
                    self._json({"error": "OpenRouter API key not configured in db/api_config.json"}, 400)
                    return

                # Trim system prompt if too large (max 25000 chars — covers full 20KB extraction_prompt.txt)
                if system_msg and len(system_msg) > 25000:
                    system_msg = system_msg[:25000]

                # Trim user message if too large (max 35000 chars ~9000 tokens)
                for msg in messages:
                    if isinstance(msg.get('content'), str) and len(msg['content']) > 35000:
                        msg['content'] = msg['content'][:35000] + '\n[...TRUNCATED FOR TOKEN LIMIT...]'

                or_messages = []
                if system_msg:
                    or_messages.append({"role": "system", "content": system_msg})
                or_messages.extend(messages)

                import urllib.request as _ul, urllib.error as _ule
                _body = json.dumps({"model":model,"max_tokens":max_tokens,"temperature":0,"messages":or_messages}).encode()
                _req  = _ul.Request("https://openrouter.ai/api/v1/chat/completions", data=_body, method="POST",
                    headers={"Content-Type":"application/json","Authorization":"Bearer "+or_key,
                             "HTTP-Referer":"https://lexora.ai","X-Title":"Lexora Lease Abstraction AI"})
                try:
                    with _ul.urlopen(_req, timeout=120) as _r:
                        result = json.loads(_r.read().decode())
                except _ule.HTTPError as _e:
                    err_body = _e.read().decode(errors='replace')[:500]
                    self._log(f"OpenRouter HTTP error {_e.code}: {err_body[:200]}")
                    try:
                        err_json = json.loads(err_body)
                        err_msg  = err_json.get('error', {}).get('message', err_body[:200]) if isinstance(err_json.get('error'), dict) else str(err_json.get('error', err_body[:200]))
                    except Exception:
                        err_msg = err_body[:300]
                    self._json({"error": f"OpenRouter error {_e.code}: {err_msg}"}, _e.code); return
                except Exception as _e:
                    self._log(f"Extract API exception: {_e}")
                    self._json({"error": str(_e)}, 500); return

                text   = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                usage  = result.get('usage', {})
                self._json({
                    "content": [{"type": "text", "text": text}],
                    "usage": {
                        "input_tokens":  usage.get('prompt_tokens', 0),
                        "output_tokens": usage.get('completion_tokens', 0)
                    },
                    "_meta": {"model": model, "task": task}
                })
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        # /api/extract-text — Server-side PDF text extraction via pdfplumber
        if p == "/api/extract-text":
            try:
                data      = json.loads(body)
                file_b64  = data.get('fileData', '')
                import base64 as b64
                pdf_bytes = b64.b64decode(file_b64)

                try:
                    import pdfplumber
                    import io
                    pages_text = []
                    with pdfplumber.open(io.BytesIO(pdf_bytes)) as pdf:
                        for page in pdf.pages:
                            t = page.extract_text() or ''
                            pages_text.append(t)
                    text   = '\n\n'.join(pages_text)
                    method = 'pdfplumber'
                    self._log(f"📄  pdfplumber extracted {len(text)} chars from {len(pages_text)} pages")
                except ImportError:
                    self._json({"error": "pdfplumber not installed. Run: pip install pdfplumber --break-system-packages"}, 503)
                    return

                self._json({"success": True, "text": text, "pages": len(pages_text), "method": method, "chars": len(text)})
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return

        # /api/critique — Critic Agent (Claude Opus 4.7 via OpenRouter)
        if p == "/api/critique":
            try:
                data       = json.loads(body)
                flags      = data.get('flags', [])
                lease_text = data.get('lease_text', '')
                extraction = data.get('extraction', {})
                if not flags:
                    self._json({"operations": [], "unresolved": [], "summary": {"reason": "no_flags"}})
                    return

                cfg_file  = os.path.join(DB_DIR, 'api_config.json')
                cfg       = self._read(cfg_file)
                providers = cfg.get('providers', [])
                or_key    = next((pr['api_key'] for pr in providers if pr.get('id') == 'openrouter'), '')
                if not or_key:
                    self._json({"error": "OpenRouter API key not configured"}, 400)
                    return

                # Truncate lease text
                if len(lease_text) > 80000:
                    lease_text = lease_text[:60000] + " [TRUNCATED] " + lease_text[-20000:]

                system_prompt = (
                    "You are a senior commercial real estate lease abstractor and critic. "
                    "Review the extraction and fix any flagged issues. "
                    "Return JSON with: {operations:[{op,path,value,flagId,confidence,rationale}], unresolved:[{flagId,reason}]}. "
                    "Only emit operations with confidence >= 0.70. JSON ONLY. No markdown fences."
                )
                user_msg = (
                    "FLAGS (" + str(len(flags)) + "):\n" + json.dumps(flags[:20], indent=1) +
                    "\n\nEXTRACTION:\n" + json.dumps(extraction, indent=1)[:4000] +
                    "\n\nLEASE TEXT (" + str(len(lease_text)) + " chars):\n" + lease_text
                )

                import urllib.request as _ul2, urllib.error as _ule2
                _body2 = json.dumps({"model":"anthropic/claude-opus-4.7","max_tokens":16000,"temperature":0,
                    "messages":[{"role":"system","content":system_prompt},{"role":"user","content":user_msg}]}).encode()
                _req2 = _ul2.Request("https://openrouter.ai/api/v1/chat/completions", data=_body2, method="POST",
                    headers={"Content-Type":"application/json","Authorization":"Bearer "+or_key,"X-Title":"Lexora Critic Agent"})
                try:
                    with _ul2.urlopen(_req2, timeout=120) as _r2:
                        result = json.loads(_r2.read().decode())
                except Exception as _e2:
                    self._json({"error": str(_e2)}, 500); return

                text    = result.get('choices', [{}])[0].get('message', {}).get('content', '')
                import re as re_mod
                m       = re_mod.search(r'\{[\s\S]*\}', text)
                parsed  = json.loads(m.group(0)) if m else {}
                self._json({
                    "operations": parsed.get('operations', []),
                    "unresolved": parsed.get('unresolved', []),
                    "summary":    {"flagsProcessed": len(flags)}
                })
            except Exception as e:
                self._json({"error": str(e)}, 500)
            return



        self.send_response(404)
        self.end_headers()

    # ── Helpers ──────────────────────────────────────────────────────────
    def _body(self):
        return self.rfile.read(int(self.headers.get("Content-Length", 0)))

    def _read(self, path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
        except FileNotFoundError:
            return {"error": f"Not found: {path}"}
        except json.JSONDecodeError as e:
            return {"error": str(e)}

    def _write(self, path, data):
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)

    def _json(self, data, status=200):
        body = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type",   "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _log(self, msg):
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {msg}")

    def log_message(self, fmt, *args):
        print(f"[{datetime.datetime.now().strftime('%H:%M:%S')}] {fmt % args}")


# ── Main ─────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    os.chdir(ROOT_DIR)
    os.makedirs(USER_DIR, exist_ok=True)

    # ── Auto-generate api_config.json from env vars (Render / production) ──
    api_cfg_path = os.path.join(DB_DIR, "api_config.json")
    if not os.path.exists(api_cfg_path):
        _or_key  = os.environ.get("OPENROUTER_API_KEY", "")
        _oai_key = os.environ.get("OPENAI_API_KEY", "")
        with open(api_cfg_path, "w") as _f:
            json.dump({"providers": [
                {"id": "openrouter", "api_key": _or_key},
                {"id": "openai",     "api_key": _oai_key}
            ]}, _f, indent=2)
        print(f"  ✅  api_config.json generated from environment variables")

    with socketserver.TCPServer(("", PORT), LexoraHandler) as httpd:
        httpd.allow_reuse_address = True
        print("=" * 58)
        print("  ⚖️   Lexora Dev Server  v3.0")
        print("=" * 58)
        print(f"  Root   :  {ROOT_DIR}")
        print(f"  App    :  http://localhost:{PORT}/index.html")
        print(f"  Health :  http://localhost:{PORT}/api/health")
        print(f"  Saves  :  POST /api/users/save")
        print(f"            POST /api/smtp/save")
        print(f"            POST /api/users/photo/save")
        print(f"            POST /api/payments/save")
        print(f"            POST /api/transactions/save")
        print(f"            POST /api/contact/send")
        print("  Ctrl+C to stop")
        print("=" * 58)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  Server stopped.")
