# Delivering Output to a Client's Own Storage (SharePoint / ShareFile / Dropbox)

Some clients will want Lexora to drop the finished file (translated DOCX,
OCR output, extracted data, BAI2 file) directly into *their* storage
instead of only offering it as a browser download. Here's how to add
that without disrupting the current flow for everyone else.

## Current behaviour (for context)

Every paid service builds its output as a Blob **in the browser** and
either triggers a direct download or (for Lease Abstraction/older
Translation paths) saves it under `Users/<userId>/...` on the server.
Nothing is currently pushed anywhere external.

## Recommended approach: per-user "delivery destination" setting

Add an optional **Output Delivery** setting (Profile, or a new
per-service Setup option) with choices:

- **Download only** (today's default - no change for anyone who doesn't opt in)
- **Microsoft SharePoint**
- **Citrix ShareFile**
- **Dropbox**
- (extensible to Google Drive, Box, etc. later - same pattern)

When a client picks one of these, they authorize Lexora via OAuth once;
after that, every completed file for that service is uploaded to their
chosen folder automatically, in addition to (or instead of) the browser
download.

## Why OAuth, not a shared API key

Each of these is the client's own account/tenant - Lexora should act
*as* the client, not hold one shared set of credentials for everyone.
That means standard OAuth2 authorization-code flow per provider:

| Provider | Auth type | Docs |
|---|---|---|
| SharePoint / OneDrive | Microsoft identity platform (Azure AD app registration), Microsoft Graph API | `https://learn.microsoft.com/en-us/graph/api/driveitem-put-content` |
| ShareFile | Citrix ShareFile OAuth2 | `https://api.sharefile.com` REST API |
| Dropbox | Dropbox OAuth2 | Dropbox API v2, `files/upload` endpoint |

## What needs to be built

1. **Backend: connector registration.** For each provider, register an
   OAuth app (Azure AD app for SharePoint/OneDrive, a Dropbox App Console
   app, a ShareFile API client) and store the client ID/secret as env
   vars - same pattern already used for Razorpay/Twilio/SMTP.

2. **Backend: OAuth callback + token storage.** A new
   `/api/integrations/<provider>/connect` (redirect to provider's consent
   screen) and `/api/integrations/<provider>/callback` (exchange code for
   access + refresh token). Store the tokens **per user**, encrypted at
   rest if possible (see SECURITY_REVIEW.md item 5), in a new
   `integrations` table: `user_id, provider, access_token, refresh_token,
   expires_at, folder_path/drive_id`.

3. **Backend: token refresh.** All three providers issue short-lived
   access tokens with a refresh token. A small helper
   (`_get_valid_token(user_id, provider)`) that refreshes automatically
   when expired, mirroring the pattern already used for OTP
   expiry checks (`is_expired()` in `auth_store.py`).

4. **Backend: upload endpoint.** A generic
   `_upload_to_external_storage(user_id, provider, filename, file_bytes)`
   that dispatches to the right provider's upload API. Call this right
   after a file finishes processing successfully - the same point where
   `notifyProcessCompletion` already fires, so it naturally only runs
   once per completed file (fits directly into the per-file billing fix
   just made).

5. **Frontend: connect/disconnect UI.** A card in Profile (or a new
   "Integrations" page) listing the three providers with Connect/
   Disconnect buttons - same visual pattern already used for the mobile
   Verify flow (a button that starts an OAuth popup/redirect, then polls
   or listens for completion).

6. **Frontend: per-service delivery choice.** In each service's Setup
   card, an optional dropdown ("Deliver output to: Download only /
   SharePoint / ShareFile / Dropbox") if the user has connected at least
   one provider. Defaults to Download only so nothing changes for anyone
   who hasn't set this up.

## Effort/complexity estimate

- SharePoint (Microsoft Graph) and Dropbox both have official Python
  SDKs (`msgraph-sdk`, `dropbox`) and are the most straightforward to
  integrate quickly.
- ShareFile's API is older/more idiosyncratic (SOAP-flavored REST,
  provider-specific auth quirks) - budget more time for it, or offer it
  as a phase 2 if a client specifically needs it.
- None of this requires changing how files are *generated* - only where
  the finished bytes get sent, so it's additive and low-risk to the
  existing pipelines.

## Suggested rollout order

1. Dropbox first (simplest OAuth + upload API, good for validating the
   whole pattern end-to-end).
2. SharePoint/OneDrive second (most commonly requested by enterprise
   clients).
3. ShareFile last, only if/when a client specifically asks for it.
