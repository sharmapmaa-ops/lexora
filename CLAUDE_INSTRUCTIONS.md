# Claude ke liye instructions (naye chat me bhi follow karni hain)

Agar tumhe (Claude) ye poora project zip ke through mila hai — chahe naye chat
me ho, chahe purani session continue ho rahi ho — is file ko sabse pehle padho
aur in rules ko follow karo. Ye rules pichli sessions me hui galtiyon se seekh
kar banayi gayi hain, taaki wahi galtiyan dobara na ho.

---

## 1. "Claude" Debug Panel (Admin Panel → Claude tab)

`js/app.js` me `window.ClaudeDebug` naam ka ek reusable API hai (Admin panel ke
"🤖 Claude" tab ke andar render hota hai). Iska use **SIRF TABHI** karna hai
jab **user explicitly bole** ke "isko Claude me daal do" / "result Claude
panel me chahiye" / iske jaisa kuch bhi.

**Default behavior (jab tak user explicitly na kahe):** Seedha, direct
implement karke do — jaisa normal kaam hota hai. EK best solution chuno, code
me likho, deliver karo. Extra overhead nahi.

**Sirf jab user bole "Claude me do":** Us SPECIFIC topic ke liye
`ClaudeDebug.clear()` karke purana hatao, phir `ClaudeDebug.addTopic(label,
options, applyFn)` se har possible solution ek dropdown me do, taaki user
khud live switch karke test kar sake bina redeploy-retry cycle ke. Jab user
bata de ki kaunsa solution sahi hai, sirf usi ko permanent code me convert
karo aur baaki options + ClaudeDebug wala temporary code hata do.

```js
ClaudeDebug.clear();
ClaudeDebug.addTopic('Translation: Image position wrong', [
    { name: 'Solution A: inline anchor', value: 'a' },
    { name: 'Solution B: page-relative', value: 'b' },
], function (chosenValue) { /* apply chosenValue live, no reload */ });
```

---

## 2. Zip deliver karte waqt

- **Har baar** batao ki kaunsi files update hui hain, aur unki project ke
  andar exact location (path) kya hai. Ye chhupana nahi hai.
- `index.html` me local CSS/JS files ke links pe `?v=YYYYMMDDx` version-query
  hai (cache-busting ke liye) — **jab bhi** `css/*.css` ya `js/*.js` me koi
  change karo, is version string ko bump karo (agla letter/number), warna
  browser purani cached file dikha sakta hai chahe naya code deploy ho chuka
  ho. Ye ek real, confirmed bug tha jo pehle "0% change" wale symptom ki
  wajah bana tha.
- Agar user ne bola hai ki jaldi wale/aasan fixes pehle karo aur zip
  frequently bhejo — to poora response ek hi bade batch me mat karo, chhote
  checkpoints me deliver karo.
- **Zip me SIRF wahi files/folders honi chahiye jo genuinely update hui
  hain** — poora project baar-baar zip karke bhejna band. Iske liye project
  root me ek **git repo already initialized hai** (`git init` already ho
  chuka hai, baseline-commit bhi ban chuka hai) — isi ko use karo:
  1. Har response ke START me (koi bhi file-edit karne se pehle) confirm
     karo ki working-tree clean hai: `git status --porcelain` (khaali hona
     chahiye - agar khaali nahi hai, pichli baar ka commit-step miss hua
     tha, pehle commit karo taaki fresh baseline mile).
  2. Normal tarike se files edit karo (jaisa ab tak karte aaye ho).
  3. Zip banane se pehle: `git diff --name-only HEAD` (ya naye/untracked
     files ke liye `git status --porcelain` bhi check karo) se sirf CHANGED
     files ki list nikaalo.
  4. Usi list ki files ko (unki original folder-structure preserve karte
     hue) ek chhoti, temporary directory me copy karke wahi zip karo — poore
     `lexora-main` folder ko nahi.
  5. Zip deliver karne ke baad, **turant commit karo**
     (`git add -A && git commit -m "..."`) taaki agli baar ka diff sirf
     AGLE changes dikhaye, purane wapas na aayein.
  - Agar koi NAYI file banayi ho (jaise koi naya `.py`/`.js` module), wo
    `git status --porcelain` me untracked (`??`) dikhegi — usko bhi zip me
    shaamil karna hai, sirf modified (`M`) wali nahi.

## 3. 5 "report-style" tables (Payment History, Today's Transactions,
   Notification, Support, PostgreSQL admin) ke liye

Inke liye ek **unified CSS system** already banaya hua hai
(`css/design-system.css` ke end me, `.rt-table`/`.rt-wrap-top`/
`.rt-wrap-bottom`/`.rt-wrap-full` classes, sab `!important` ke saath).
**Naya, alag CSS mat banao in tables ke liye** — agar look/feel me kuch
change karna hai to yehi shared block edit karo, taaki sab 5 tables
automatically sync rahein. Alag-alag jagah patch lagana hi is poori
back-and-forth ka original root cause tha.

Column **widths** har table ke content ke hisaab se alag hoti hain, isliye
wo CSS me nahi, JS me hain:
- Split header/body tables (do alag `<table>` — Payment History, Today's
  Transactions, Notification): `autofitSplitTableColumns()`
- Single-table cards (Support, PostgreSQL): `autofitSingleTableColumns()`

Dono functions **CSS Grid** (`display:grid` + shared `grid-template-columns`
har row pe) use karte hain — ye live-tested/confirmed-working approach hai.
Isse pehle `table-layout:fixed` + colgroup + per-row-width — teeno try kiye
gaye the aur unreliable nikle the. **Grid wapas table-layout wale kisi
approach se replace mat karo bina explicitly confirm kiye.**

## 4. "Translation Health" (self-improving translation pipeline)

`translation-offline.js` me ab teen self-improving DB-tables hain (Admin panel
me automatically dikhti hain, generic PostgreSQL viewer ke through):

- **Translation Rules** (`translation-rules`) — har translation ke prompt me
  inject hoti hain. **Naye rows `active: No` ke saath save hoti hain** (reviewer
  khud detect karke suggest karta hai) — koi bhi row LIVE tabhi hoti hai jab
  koi human use `Yes` kare.
- **Translation Domains** (`translation-domains`) — naye domain (jo 13
  hardcoded me se match nahi karte) automatically generate + save hote hain,
  aur **turant live** ho jaate hain (kam risk, sirf usi domain ko affect
  karta hai).
- **Translation Code Issues** (`translation-code-issues`) — reviewer ko agar
  koi systematic/structural pattern (translation-quality nahi, pipeline-bug
  jaisa) mile, wo yahan flag hota hai (`status: New`). **Kabhi bhi koi code
  khud change/deploy nahi hota** — sirf detect+flag, decide+fix hamesha
  human ke haath me.

**User jab bhi bole "translation check karo"**, Admin Panel → **"🌍
Translation Health"** tab dekho (`loadTranslationHealthPanel()`,
`js/app.js`) — teeno tables ek hi jagah, jo bhi human-attention chahiye
(pending rules, New-status issues) highlighted milega. Har pending rule ke
liye apni ACCEPT/REJECT/MODIFY recommendation dena, apni general
software-engineering aur domain-judgement se — user isi advice ke aadhar
par decide karega.

## 5. General rules (is poori session se seekhe gaye)

- **Guess mat karo.** Agar kisi bug ka exact root cause pata nahi hai, ya to
  actual code trace karo (grep, view, cross-reference) jab tak concrete
  proof na mil jaye, ya user se ek chhota, specific clarifying sawaal pucho
  (jaise "browser dev-tools me computed width kya dikha rahi hai") — random
  fix try karke "ho gaya" mat bolo.
- **Bina puche extra kaam mat karo.** Agar user ne specific cheez maangi hai,
  sirf wahi karo. Agar koi ADJACENT issue dikhe jo unrelated hai, pehle
  mention karo/pucho, seedha fix mat kar do (ek baar aisa hua tha aur user
  ne explicitly revert karwaya tha).
- **Har fix ke baad syntax check karo** (`node --check` for .js, brace-count
  Python one-liner for .css) — pura zip banane se pehle.
- Is project me "dead code" (purani, kisi aur naye rule se overridden ho
  chuki declarations) baar-baar milti rahi hai — jab bhi koi CSS/JS change
  karo jo kisi EXISTING selector se conflict kar sakta hai, pehle check karo
  ki koi aur jagah wahi selector/property already exist to nahi karta.
