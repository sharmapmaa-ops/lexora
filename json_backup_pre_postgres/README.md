# Ye folder kya hai

Ye 19 files pehle `json/` folder me thi. App ab in sabko **Postgres se** padhta/likhta hai
(agar `DATABASE_URL` set hai) - isliye `json/` folder se hata kar yahan rakh di gayi hain
taaki project "database se connect" ho jaye jaisa maanga gaya tha, lekin data delete na ho.

## Is folder ko permanently delete karne se pehle:

1. `DATABASE_URL` set karke app deploy/run karo.
2. Admin Panel -> PostgreSQL tab -> **Run migration** click karo.
3. Usi tab me confirm karo:
   - `users` table me utni hi rows hain jitni `users.json` me thi.
   - `transactions` me `payment-history.json` jitni rows.
   - `notifications` me `notifications.json` jitni rows.
   - `app_documents` me in resources ki rows: `plan-history`, `api-keys`,
     `payment-methods`, `contact-submissions`, `lease-files`,
     `translation-files`, `lease-activity-log`, `translation-activity-log`,
     `plans`.
   - `app_settings` me 7 rows: `menu-config`, `services-api`, `card-layout`,
     `messages`, `agents`, `company`, `rules`.
4. Sab confirm hone ke baad hi ye poora folder delete karo (ya git se hata do).

## Jo files ismein NAHI hain (jaan-bujh kar `json/` me chhodi gayi hain):

- `sessions.json` - login sessions/tokens, baar-baar likhi jaati hai, ephemeral
  hai, isliye DB me move nahi ki.
- `extraction_prompt.txt` - lease AI ka prompt text hai, JSON data nahi -
  DB-backed resources ka hissa nahi.

## Agar Postgres na ho (DATABASE_URL set na ho):

Server abhi bhi in files ko **fallback** ki tarah dhoondhta hai (`json/<name>.json`).
Jab tak ye folder yahin hai aur `json/` me wapas copy nahi ki gayi, DB ke bina app
kaam nahi karega - isliye production me DATABASE_URL zaroor set rakhna.
