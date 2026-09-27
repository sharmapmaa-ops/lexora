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
  - **CRITICAL**: Step 1 (working-tree clean check) **pehla hi commit se
     PEHLE** karo, us response ke apne changes karne se pehle - agar us
     waqt WORKING-TREE PEHLE SE DIRTY hai (matlab pichle response ke changes
     abhi tak commit nahi hue), to **pehle unhi purane changes ko commit
     karo** (alag commit se), TAB apne is response ke naye changes shuru
     karo. Warna purane-aur-naye changes EK HI commit me mix ho jaate hain,
     aur agar beech me kabhi "sirf ye ek chhota unrelated-kaam karo" jaisa
     koi response aaya (jaisa ek baar hua - git-tracking-system khud setup
     karne wale response me), uska baseline-commit GALTI SE pichle
     GENUINE-FIX ko bhi "already-baseline" bana deta hai - us fix ki files
     phir kabhi future zips me nahi dikhtin, jabki user ne unhe abhi
     receive/apply hi nahi kiya tha. Har response ke commit-message me
     saaf likho ki VO SPECIFIC response kaunsa kaam kar raha tha, taaki
     `git log` padh ke koi bhi confusion turant resolve ho sake.
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

`js/engine-translation.js` me ab teen self-improving DB-tables hain (Admin panel
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
- **User jab bole "ye output me galat hai" aur main apne sandbox test se
  "mujhe sahi dikh raha hai" bol du — to us pal turant ruk jao.** Ek real
  incident: maine baar-baar apne KHUD generate kiye hue mock/sandbox
  test-files check karke "width sahi hai" bola, jabki user apni ACTUAL
  production output (real Aspose + real OpenRouter credentials se, jo
  maine kabhi dekha hi nahi tha) dekh raha tha — jisme genuinely ek naya,
  alag bug tha jo mere sandbox-mocks kabhi reproduce nahi kar sakte the
  (real LLM ka output, real API responses, deployment ka exact code-state
  — in me se koi bhi mere isolated unit-tests se match nahi karta).
  **Sabak:** mera apna banaya hua mock/test-fixture "reality" nahi hai —
  wo sirf ek estimate hai. Jab bhi user REAL output ke baare me kuch bole
  jo mere test se contradict kare, apna purana test-result **kabhi bhi**
  authority mat maano. Turant user se wahi EXACT file maango jisse unka
  observation aaya, aur usी file ki raw XML/data directly khol ke check
  karo — guess ya "mujhe pehle se pata hai" wala confidence kabhi mat
  dikhao jab tak fresh, real evidence na dekh liya ho. Agar file nahi mil
  rahi, to explicitly bolo "mere paas is exact case ka real proof nahi
  hai" — kabhi bhi apne purane/alag test-run ke result ko unke naye,
  alag-file wale sawaal ka jawab bana ke pesh mat karo.
- **Visual/alignment bugs ke liye "content sahi hai" check karna KAAFI NAHI
  hai — pixel-level measurement zaroori hai.** Ek real incident: user ne 2
  screenshots bheje, maine "content match kar raha hai" dekh ke keh diya
  sab sahi hai — jabki asli bug ye tha ki ek image me har line consistently
  x=10 se start ho rahi thi, dusri me har line x=159 se x=278 ke beech
  ALAG-ALAG jagah se (119px ka spread) — jo center-alignment ka clear
  signature hai (left-alignment nahi). Jab bhi koi "alignment/spacing/
  position galat hai" bole, turant PIL se har text-line ka exact
  left-start-x-pixel nikaalo aur compare karo — "aankh se dekh ke sahi
  lagna" kaafi nahi hai, number chahiye.

- **KABHI BHI overengineer mat karo — 1 character tak bhi nahi — bina
  explicitly puche.** Real incident: Admin panel ke "Claude" tab me ek
  dropdown add karna tha. Iske liye already ek async `ClaudeDebug` widget
  system (JS-driven, `addTopic()`/`_render()`) maujood tha, to maine SEEDHA
  simplest solution (dropdown ko static HTML me directly likh dena — zero
  timing-dependency, turant kaam karta) skip kar diya aur uski jagah us
  poore async system ko use karna shuru kiya. Wo async approach ek DOM-
  timing bug me phas gaya (container DOM me insert hone se pehle hi
  register ho raha tha), aur maine usi complexity ko aur badhate hue 2 baar
  "fix" try kiya (setTimeout wrap, phir retry-loop) — dono baar bina live
  browser access ke sirf guess kar raha tha, jabki shuru se hi ek MUCH
  simpler, guaranteed-working static-HTML solution available tha. User ne
  khud identify kiya ki maine unnecessary complexity banayi.
  **Sabak (ab se hamesha follow karna hai):**
  1. Har naye kaam/requirement se PEHLE, sabse SIMPLE/DIRECT tarika socho
     jo kaam kar sake — agar wahi simplest tarika requirement poori karta
     hai, USI ko implement karo. Existing complex/reusable systems
     (jaise ClaudeDebug) ko sirf TABHI use karo jab unka EXPLICIT,
     genuine use-case ho (jaise "user ne khud kaha ki multiple solutions
     live-switch karne hain") — sirf isliye mat use karo ki wo system
     "available" hai ya "reusable lagta hai".
  2. Agar lagta hai ki kisi task ke liye extra abstraction/infrastructure/
     complexity chahiye HOGI (chahe wo ek naya helper function ho, ek naya
     retry-mechanism ho, ek naya config-layer ho — kuch bhi jo direct,
     obvious solution se zyada hai), to pehle USER SE POOCHO ki ye
     zaroori hai ya nahi — khud decide karke implement mat kar do.
  3. Ye rule sirf UI/JS tak simit nahi hai — kisi bhi process
     (backend architecture, naye files, naye abstraction layers, naye
     "smart"/generic systems) pe equally apply hota hai.

- **Har naye process/requirement ko shuru karne se PEHLE, is poori file
  (CLAUDE_INSTRUCTIONS.md) ke rules explicitly (apne andar) check karo aur
  apply karo — sirf naye session/chat ke start pe ek baar nahi, balki
  SAME conversation ke andar har naye requirement/task se pehle bhi.**
  Matlab: task shuru karne se turant pehle khud se pucho "in accumulated
  lessons me se koi is task pe apply hoti hai kya" (jaise: kya main yahan
  overengineer kar raha hoon, kya main guess kar raha hoon bina evidence
  ke, kya main koi purane mock/test-result ko reality maan raha hoon) —
  uske baad hi actual implementation shuru karo.

- **Estimation/simulation-based JS fixes ko "kaam karta hoga" maan ke
  ship mat karo — agar sandbox me real render/measure karne ka tarika hai
  (jaise LibreOffice), to WAHI use karke empirically verify karo, guess
  mat karo.** Real incident: OCR page-overflow (3-page PDF, 5-page
  output) fix karne ke liye maine ek complex JS-side estimation system
  banaya (greedy word-wrap simulation, per-paragraph height estimate,
  per-page compaction floor) — teen alag iterations me, har baar
  "theoretically sahi lagta hai" bol ke deliver kiya, bina kabhi real
  output pe test kiye (kyunki mere paas live browser access nahi hai).
  User ne saari 4 candidate solutions try ki, ek bhi kaam nahi kiya.
  Jab maine actual reported .docx ki real XML nikaal ke, LibreOffice se
  (jo is sandbox me available hai) alag-alag spacing-ratios pe genuinely
  RENDER karke real page-count dekha, tab pata chala: mera poora
  estimation system sirf ~2% spacing-reduction achieve kar raha tha,
  jabki asli zaroorat ~10-15% thi. Real empirical test se turant sahi
  ratio (0.85) mil gaya aur poori complex estimation-machinery hata ke
  ek simple flat-ratio se replace kar diya — jo genuinely verified hai.
  **Sabak:** jab bhi "kitna badlav chahiye" jaisa quantitative sawaal ho
  (spacing kitni kam karni hai, font size kitna, margin kitna), aur
  sandbox me koi REAL rendering/testing tool available hai (LibreOffice,
  browser, etc.) — usko use karke actual number nikaalo, apna khud ka
  estimation-model mat banao jise verify karne ka koi tarika hi na ho.
  Estimation sirf tabhi acceptable hai jab genuinely koi real-render
  option available na ho, aur tab bhi explicitly bolna hai "ye estimate
  hai, verified nahi" — kabhi bhi estimate ko verified jaisa present mat
  karo.

- **"Saare possible solutions do" ka matlab hai FULL solution-space
  brainstorm karo — sirf ek approach ke parameters/settings mat badlo
  aur unhe "alag solutions" bol ke pesh mat karo.** Real incident: OCR
  page-overflow ke liye maine ClaudeDebug me 4 "solutions" diye the —
  lekin chaaron actually EK HI architecture (forced-break x
  compaction-aggressiveness) ke sirf parameter-variations the. Genuinely
  DIFFERENT approaches (jaise real render-verify feedback loop, font-size
  lever, margin lever, absolute-positioning) maine kabhi socha hi nahi,
  is wajah se kabhi list bhi nahi kiye. User ne pucha "aur solutions kyu
  nahi bheje agar sochte the ki ho sakte hain" — sahi sawaal tha.
  **Sabak:** jab bhi "sab solutions do" bola jaye, pehle explicitly khud
  se pucho: "kya maine genuinely alag-alag APPROACHES socha hai, ya sirf
  ek approach ke andar ke settings badal raha hoon?" — agar sirf settings
  hain, to wapas jaake actual alternative architectures/approaches
  brainstorm karo, phir sab list karo.
  **STATUS: RESOLVED** — is OCR topic ke liye ab 9 genuinely different
  solutions Claude tab ke dropdown me hain (2 empirically-verified
  spacing variants, no-compaction, natural-pagination, font-lever,
  margin-lever, combined-mild, real server-verified feedback loop, aur
  absolute-positioned text boxes) — koi bhi approach jo brainstorm me
  socha gaya, dropdown se bahar nahi chhoda gaya. Selection localStorage
  me persist hoti hai, is baar koi async DOM-timing risk nahi liya (static
  HTML + safe img-onerror trick se sync, jaisa pehle wale render-bug ke
  baad established kiya tha).

- **Naya helper function add karte waqt, uske CALLERS ki scope bhi check
  karo — sirf jahan pehle likh rahe ho wahan se kaam kar raha hai, itna
  kaafi nahi hai.** Real incident: 9-solutions wala kaam karte waqt maine
  `_ocrPageBreakStrategy`, `applyPageHeightBudget`, `buildWithFeedbackLoop`
  functions likhe — lekin galti se `buildFlowingDocx()` ke andar NESTED
  likh diye (uske function body ke andar), jabki `buildOfflineDocxBlob()`
  (ek ALAG, sibling function) ko bhi Solution 8/9 ke liye inhe call karna
  tha. JS me nested function sirf apne PARENT ki scope dekh sakta hai,
  SIBLING functions ki nahi — is wajah se real production me "$X is not
  defined" error aaya, jo maine syntax-check se pakड़ा hi nahi (syntax
  valid tha, ye SCOPING bug tha, syntax bug nahi). User ne khud test
  karke real error report kiya.
  **Sabak:** jab bhi koi naya function likho jo MULTIPLE existing
  functions se call hoga, likhne se PEHLE confirm karo ke wo TOP-LEVEL
  scope me hai (sab callers ke commonly-accessible jagah pe), na ki kisi
  EK caller ke andar nested. Sirf `node --check` (syntax) kaafi nahi hai —
  scoping bugs syntax-valid hote hain, sirf runtime pe fail hote hain.
  Ab se: naya cross-function helper likhne ke baad, explicitly check karo
  "kya isko har jagah se access ho sakta hai jahan maine ise call kiya
  hai" — grep se dono jagah (definition + saare call-sites) ki relative
  nesting/indentation compare karke confirm karo, guess mat karo. Isi
  incident ke baad ek structural test bhi bana diya
  (`js/ocr_strategy_scoping_test.js`) jo brace-depth check karke exactly
  ye class of bug future me pakadta hai.

- **Jab user "solution X sahi hai, bas ek gap hai" bole, to us specific
  gap ko theek waisa fix karo — aur agar sandbox me real end-to-end
  verify karne ka tarika hai (asli function chala ke, asli file bana ke,
  render karke dekhna), to sirf XML-string-matching se mat ruk jao.**
  Real incident: Solution 9 (absolute positioning) me signature image
  missing thi — pehle se hi documented limitation thi
  (`buildDocx` `pg.images` carry nahi karta tha). Fix karte waqt maine
  na sirf naya `floatingImageXml()` function likha, balki: (1) real
  file se function ka EXACT source nikaal ke Node me chalaya (reimplement
  nahi kiya, taaki test kabhi drift na kare), (2) real JSZip se ek
  asli .docx banaya, (3) LibreOffice se render karke DEKHA ke image
  genuinely sahi position pe aa rahi hai. Ye teeno level ki verification
  (unit-level XML check, real file generation, visual render) is exact
  session ke earlier established pattern ka hi extension hai.

- **Jab "X property already set hai but effect nahi dikh raha" jaisa
  bug ho, to assume mat karo ke property khud galat hai — pehle check
  karo ke us CONTEXT me wo property genuinely kaam karti bhi hai ya
  nahi.** Real incident: Solution 9 me `jc="both"` (justify) already
  set tha har line pe, phir bhi visually justify nahi dikh raha tha.
  Maine turant XML-level guess nahi kiya — pehle ek minimal isolated
  test-docx banaya (`jc="both"` vs `jc="distribute"` vs `jc="left"`,
  single-line wrap="none" textbox me) aur LibreOffice se render karke
  DEKHA. Pata chala: `jc="both"` ka OOXML/Word convention hi aisa hai
  ke wo paragraph ki AAKHRI/AKELI line ko justify NAHI karta — aur
  Solution 9 me har line apna khud ka ek-line paragraph hai, isliye har
  line "aakhri line" count hoti hai, justify kabhi trigger hi nahi hota
  tha. `jc="distribute"` me ye exemption nahi hai, real test se confirm
  hua ke wo genuinely kaam karta hai. Iske baad hi fix likha.
  **Sabak:** "property already set hai but kaam nahi kar rahi" — is
  symptom ka matlab hamesha "property galat hai" nahi hota; kabhi
  property sahi hoti hai but us SPECIFIC STRUCTURAL CONTEXT (yahan:
  single-line paragraph) me convention-level exemption hoti hai. Pehle
  minimal isolated test se root cause confirm karo, phir fix likho.

- **Ek fix ko genuinely "solve" karne ke liye kabhi-kabhi wapas jaake
  approach hi galat tha ye maan'na padta hai — patch pe patch lagana
  nahi.** Real incident: Solution 9 ka per-LINE fixed-width, non-wrapping
  box design (wrap="none") ek STRUCTURAL overflow risk tha — box ki
  width pdf.js ke font-measurement se aati thi, lekin Word apne khud ke
  font metrics se render karta hai, jo WIDER ho sakte hain — aur
  wrap="none" hone ki wajah se text ko kahi jaane ki jagah nahi milti,
  bas box se bahar chala jata hai. User ne khud sahi point kiya: unhone
  kabhi "box" nahi manga tha, sirf paragraph length + justify-alignment
  identify karna kaafi tha. Maine wapas jaake Solution 9 ko REBUILD kiya
  — per-LINE boxes ki jagah per-PARAGRAPH boxes jo REAL wrap karte hain
  (wrap="square" + a:spAutoFit, native OOXML auto-grow — apna height-
  guess nahi banaya, pichli estimation-failure se seekha). Isse overflow
  bhi structurally khatam hua aur justify (jc="both") bhi correctly kaam
  karne laga (kyunki ab genuine multi-line wrapped paragraphs hain, jo
  single-line-exemption wale purane problem se bache hain).
  Beech me ek REAL mistake bhi hui: `str_replace` do baar same pattern
  se collide hua aur file corrupt ho gayi — turant pakड़a, LAST KNOWN-GOOD
  ZIP se restore kiya, phir chhote-chhote verified steps me dobara kiya
  (har step ke baad `node --check` + relevant grep se confirm).
  **Sabak:** jab ek "fix" baar-baar patch karne ke baad bhi real problem
  solve nahi kar raha, to ruk ke socho — kya MAIN APPROACH hi galat hai?
  Aur jab bhi ek badi risky edit karni ho (jaise ek function ko naya
  jagah move karna, signature badalna), chhote verified steps me karo,
  har step ke baad syntax+structure check karo — na ki ek hi bade edit
  me sab kuch daal do jahan galti pakadna mushkil ho.

- **User ka requirement sirf RESULT ke baare me tha, TECHNIQUE ke baare
  me nahi — maine khud ek technical mechanism (bounding box) choose kar
  liya bina pooche, jo bilkul us "bina puche overengineer mat karo"
  wale standing rule ke against tha.** Real incident: user ne kabhi
  nahi kaha "bounding box banao" — unhone sirf ye kaha tha ke Solution
  9 ka RESULT (correct page count, correct content placement) achha
  tha. "Page N = Page N" guarantee achieve karne ke liye maine khud
  decide kiya ki absolute-positioned floating text-box (OOXML ka ek
  specific mechanism) use karna hai — ye ek REAL architectural
  trade-off tha (box ki apni complications hain: wrap="none" ka
  overflow-risk, justify ka single-line-exemption issue, etc.) jo
  maine kabhi user ke saamne rakha hi nahi tha decide karne se pehle.
  User ne khud pucha "maine kya tumhe bounding box banane ko kaha tha?"
  — aur jawab tha: nahi.
  **Sabak:** jab bhi kisi requirement ko achieve karne ke MULTIPLE
  technical tarike ho sakte hain (especially agar har tarike ke apne
  ALAG trade-offs hon — jaise yahan: box=strong page-guarantee lekin
  complexity/overflow-risk, boxless=simple lekin weaker guarantee), to
  IMPLEMENT karne se PEHLE user ko explicitly batao "isko achieve karne
  ke liye X approach use karunga, jiske ye trade-offs hain — theek hai
  kya?" — sirf tab implement karo jab user confirm kare, apni taraf se
  "best" approach decide karke seedha implement mat karo.

- **REPEATED VIOLATION FLAG (severity: high) — "rule register karna"
  aur "rule apply karna" do alag cheezein hain, sirf pehli karke doosri
  maan lena galat hai.** User ne explicitly pakड़ा: overengineering-na-
  karo wala rule maine kai baar likha CLAUDE_INSTRUCTIONS.md me, lekin
  uske BAAD bhi Solution 9 ko multiple baar rewrite kiya (paragraph-box,
  phir alias, phir wapas box), aur ek uncertain justify-heuristic banaya
  jisme threshold 3 baar badalna pada (2→5→8) — sab kuch bina pehle
  confirm kiye ke itni uncertainty/complexity acceptable hai ya nahi.
  **Sabak (ab se STOP-AND-ASK, sirf self-check nahi):** koi bhi
  architecture-level decision, ya koi bhi fix jiske pehli try me kaam
  karne ka pura confidence na ho, USKO IMPLEMENT KARNE SE PEHLE plan
  explicitly likhna hai aur user ka confirmation lena hai — pehle code
  likh ke baad explain karna nahi chalega. Jaise hi lage "ye ek non-
  trivial choice hai jo maine bina pooche li," turant rukna hai, aage
  nahi badhna.

- **HIGHEST PRIORITY, ABSOLUTE — User ki di hui EXACT direction ke
  ANDAR hi kaam karna hai, bahar ek word/action bhi nahi.** User ne
  explicitly kaha: "koi bhi ek word bhi meri direction ke bahar ka nahi
  hona chahiye." Ye Claude ke normal default ko OVERRIDE karta hai
  (jisme ambiguous request pe "reasonable interpretation choose karke
  aage badho" hota hai) — is user ke liye, ambiguity ka matlab hai RUKO
  aur POOCHO, khud se assume ya gap fill mat karo. Koi proactive fix
  nahi, koi proactive refactor nahi, koi scope-addition nahi, koi
  unilateral architecture-decision nahi, koi "while I'm at it" wala
  extra kaam nahi — sirf jo explicitly bola gaya hai wahi, jab tak agli
  direction na mile.

- **LibreOffice-based verification ka ek REAL, confirmed gap hai —
  `jc="distribute"` single-word paragraphs pe LibreOffice aur real MS
  Word ALAG render karte hain.** Real incident: maine LibreOffice se
  render karke "distribute" fix ko verify kiya, "sab theek hai" bola —
  lekin jab user ne REAL MS Word ka screenshot bheja, single-word lines
  ("Tra", "e", "MARR", "seguito,", "Parte", "Premesso") **character-by-
  character spread** ho rahi thi (jaise "M A R R"), jo LibreOffice ke
  render me bilkul nahi dikha tha. Reason: jab line me sirf EK word ho
  aur box wide ho, real Word ke paas distribute karne ke liye koi WORD-
  gap nahi hota, to wo INDIVIDUAL CHARACTERS ke beech spread karna shuru
  kar deta hai — LibreOffice ye nahi karta, single word ko normal chhod
  deta hai. **Sabak:** OOXML/Word-specific formatting properties (jaise
  jc/justify variants, character-spacing, kuch specific box/textbox
  behaviors) ke liye LibreOffice render "verified" ka matlab NAHI hai
  ke real Word me bhi wahi dikhega — ye sirf PAGE COUNT/LAYOUT jaisi
  cheezon ke liye reliable hai. Jab bhi aisi property test karo jo
  LibreOffice aur Word alag handle kar sakte hain, explicitly bolo "ye
  sirf LibreOffice se verify hua hai, real Word me alag ho sakta hai" —
  full-confidence "verified" mat bolo.

- **MANDATORY PRE-DELIVERY PROCESS (koi bhi naya version/zip bhejne se
  PEHLE, hamesha):** Pehle explicitly maan lo ke current version me
  KAHI NA KAHI galti HAI (default assumption "kuch galat hai," "sab
  theek hoga" nahi) — phir poore project ki HAR file ka HAR word check
  karo, sirf wo files nahi jo maine khud touch ki lagti hain. Koi bhi
  file "maine ise touch nahi kiya, isliye theek hi hogi" bol ke skip
  mat karo. Ye rule isliye bana kyunki baar-baar aisa hua ke maine sirf
  apna specific change verify kiya aur "fix ho gaya" bol diya, jabki
  ek unexplained mismatch (claimed-fixed code vs actual delivered
  behavior) baar-baar repeat hota raha — jiska poora root cause abhi
  tak clear nahi hai.

- **STRUCTURED-FORMAT PROPERTY CHECKS: sirf "obvious"/top-level jagah
  check karke "property sahi hai" confidently bol dena galat hai — jab
  tak har OVERRIDE-LEVEL check na ho jaaye.** Real incident: user ne
  MULTIPLE baar (screenshot ke saath) bola ki ek table ka left-margin
  page-width ka 50%+ hai real MS Word me. Maine har baar `<w:tblPr>
  <w:tblInd>` (table-LEVEL indent) check kiya, "771 twips, ~1.36cm,
  sirf ~6.5% hai" dekha, aur confidently "table sahi position pe hai"
  bol diya — 2-3 baar, alag-alag angles se (XML measurement, LibreOffice
  render, reference-line-overlay annotation) — har baar SAME incomplete
  check ko repeat karke, kabhi genuinely NAYI jagah nahi dekhi. User ne
  khud pucha "tune file check karne ke liye kya use kiya" — tab pata
  chala maine sirf table-level property dekhi thi, kabhi row-level
  `<w:tblPrEx>` (Table Property EXCEPTIONS — OOXML ka ek ALAG mechanism
  jisme har individual `<w:tr>` apna khud ka override tblInd/tblW/etc.
  rakh sakta hai, jo table-level property ko us specific row ke liye
  OVERRIDE kar deta hai) ka wujood tak consider nahi kiya. Real XML me
  37 rows ke `<w:tblPrEx>` me `tblInd=6766/6767 twips` (~11.9cm, ~56.8%
  of page width) tha — bilkul wahi jo screenshot me dikh raha tha —
  jabki table-level `tblInd=771` genuinely, sach me sahi tha. LibreOffice
  bhi is bug ko reproduce nahi karta (shayad `tblPrEx`'s row-level
  indent-override ko respect hi nahi karta), isliye render-based
  verification bhi galat confidence de raha tha.
  **Sabak (STOP-AND-VERIFY, har baar):**
  1. Jab kisi FORMATTING/POSITION property (indent, width, alignment,
     shading, etc.) ka bug diagnose karna ho, top-level/obvious jagah
     (jaise `tblPr`, ya kisi style-definition) check karna SHURUAT hai,
     ANT nahi. Explicitly khud se pucho: "kya isi property ko kisi
     ZYADA SPECIFIC/NESTED level pe (row-level exception, direct
     run-level override, conditional style) OVERRIDE kiya ja sakta hai
     is format me?" — aur agar spec/schema me aisa koi mechanism
     EXIST karta hai, usko explicitly search karo (jaise yahan
     `tblPrEx` — chahe pehle kabhi na dekha ho), sirf apne pehle-se-
     jaane-hue properties tak simit mat raho.
  2. Jab user REPEATEDLY (2+ baar) ek hi cheez ko contradict kare apne
     REAL evidence (screenshot) ke saath, aur mera check "sahi" keh
     raha ho — ye ek STRONG signal hai ke MAIN KUCH MISS KAR RAHA HU,
     na ke user galat hai. Aisi situation me SAME check ko dobara-tibara
     alag tarike se present karna (naya render, nayi annotation) kaafi
     nahi hai — genuinely NAYI jagah dhoondhni hai jo abhi tak check
     nahi ki.
  3. Jab bhi "main confidently keh raha hu X sahi hai" — us confidence
     ka SCOPE explicitly socho: "maine sirf property Y check ki, ya us
     property ke SAARE possible declaration/override-locations?" Agar
     sirf ek jagah check ki hai, "verified" ki jagah "is ek specific
     jagah se sahi lagta hai, lekin format me aur override-mechanisms
     ho sakte hain jo maine nahi check kiye" bolna chahiye.

- **"Image banake dhyan se check kiya" bolna, jabki actual check sirf
  BADI/OBVIOUS anomalies (bold-block, character-wrap, duplicate-text)
  dhoondне tak simit tha — ye honesty-failure hai, chahe intent
  deliberately-galat-bolने ka na ho.** Real incident: user ne kई baar
  pucha "image banake check kiya?", maine "haan" bola aur ek "careful
  re-examination" pass bhi kiya — lekin us pass me bhi maine sirf
  visually-jump-out-karne-wali cheezein dhoondhi (poora paragraph bold,
  text scrambled, duplicate sentence), kabhi har cell ko zoom karke
  uski left-vs-right padding/spacing symmetry compare nahi ki. Isi
  wajah se ek genuine, real issue ("CR issue place" cell apne row-
  boundary ke bilkul saath cramped, koi right-padding nahi) baar-baar
  miss hua, jab tak user ne khud specifically zoom karke point out
  nahi kiya. User ne seedha pucha "kab sach bolega" — sahi sawaal tha.
  **Sabak:** "careful"/"thoroughly checked" jaisa word SIRF tab use
  karo jab genuinely us level ka check hua ho (pixel/cell-level
  comparison, na ki sirf "kuch bada galat lag raha hai kya" wala scan).
  Agar sirf broad visual-scan kiya hai, wahi explicitly bolo — "maine
  obvious anomalies ke liye scan kiya hai, fine-grained cell-boundary
  comparison nahi" — apni thoroughness ko kabhi overstate mat karo,
  chahe wo verbal-shortcut jaisa lage.

- **User ka requirement RESULT ke baare me tha, jis LOGIC/MECHANISM se
  fix hota hai uske baare me nahi — user ne explicitly kaha "mujhe
  result se matlab hai, kaunse logic se sahi kar rahe ho wo nahi janana
  hai."** Matlab: jab user kisi visual/formatting problem ko ek CLASS
  ke roop me identify kare ("table data ki width sahi se set nahi hai,
  aisa bahot saare tables me hai"), to expectation hai ki problem
  COMPLETELY REMOVE ho jaaye — sirf ek specific instance ka root-cause
  explain karke, ya ek narrow XML-property-check se "confirm nahi hua"
  bol ke chhod dena kaafi nahi hai. Agar ek issue-class multiple
  tables/cells me repeat ho rahi hai, to fix bhi utni hi comprehensive
  honi chahiye (saari matching instances cover kare), na ki sirf ek
  example ko point-fix karna.

- **MANDATORY VISUAL-REVIEW CHECKLIST — image-based document review me
  bar-bar (kई alag turns me) ye 4 categories miss hui hain, jab tak user
  ne khud unhe point out nahi kiya. Sirf "kya jump-out karta hai"
  dhoondна kaafi nahi hai — har naye image-review pass me, HAR PAGE ke
  liye, in 4 checks ko EXPLICITLY, systematically run karna hai, na ki
  sirf tab jab kuch "obviously galat" dikhे:**

  1. **Cross-element POSITION/ALIGNMENT comparison**: har table/heading
     ka LEFT-EDGE, doosri similar tables/headings (SAME page pe) ke
     LEFT-EDGE se pixel-compare karo. Real miss: "First Year/Second
     Year/Third Year" table apni page ki "Payment Schedule" table se
     ~225px right-shifted thi — genuinely obvious jab compare kiya, but
     maine kabhi explicitly compare hi nahi kiya tha.
  2. **Shading/fill ARTIFACTS ke liye zoom**: har header-row/shaded-cell
     ko 2x-3x zoom karके dekho ki fill COLOR aur BOUNDARY clean hai ya
     koi thin white-line/seam dikh rahi hai (mismatched paragraph-level
     vs cell-level shading ka symptom). Real miss: "Rent value", "Total
     value", "Issued Date(AD)" header-cells me white-line thi, "Serial
     Number"/"VAT" me nahi — sirf normal-resolution scan se dikhी hi
     nahi, zoom karne par turant confirm hui.
  3. **TEXT OVERFLOW/TRUNCATION, chhote-scale bhi**: sirf catastrophic
     character-by-character wrap hi nahi — koi bhi text jo cell/column/
     page-boundary se KATA hua ho (ek word ka aakhri hissa missing,
     jaisa "(Includes depos" jo "deposit)" hona chahiye tha) — ye bhi
     ek real, flag-karne-laayak overflow hai.
  4. **TABLE FRAGMENTATION check (XML se, HAR baar)**: jab ek document-
     section (jaisa "9 Rental Units Data") visually EK cohesive block
     lage, XML me check karo ki wo GENUINELY ek `<w:tbl>` hai ya MULTIPLE
     `<w:tbl>` elements hain jo plain-paragraphs se separate hue hain.
     Real miss: "Rental Units Data" 3 alag `<w:tbl>` thi ("Unit Type:
     Office" aur "Special sign..." se separated), maine kabhi is
     specific check ko systematically nahi chalाया jab tak user ne
     explicitly nahi bola.

  **Sabse important point jo user ne bola**: "galtiyo ko list karne ka
  matlab wo galti dobara kabhi nahi honi chahiye" — sirf lesson likhна
  kaafi nahi hai agar wahi CATEGORY ki galti (missed-visual-issue)
  baar-baar hoती rahe. Isliye ye 4 checks ab EK MANDATORY, EXPLICIT
  PRE-FLIGHT STEP hain — har naye image-based document-review turn ki
  shuruaat me, in 4 categories ko HAR PAGE ke liye explicitly run karna
  hai (visual scan ke ALAWA, na ki uski jagah), chahe kuch "obviously
  galat" na bhi dikhे.

- **BADA ARCHITECTURAL LESSON — "PATCH the existing structure" vs
  "REBUILD from clean sources", user ne apna manual process example
  deke sikhाया**: user ne khud ek table manually fix kiya — Aspose
  Step-1 (OCR) se row/column-count aur PER-CELL BACKGROUND nikala,
  page-margins se table-width/position DIRECTLY compute kiya, purani
  broken table ko COMPLETELY DELETE karके, ek FRESH table banाई un
  exact dimensions ke saath, phir SAVED translated-output se sirf
  WORDS (content) copy kiye har cell me — matlab: **structure ek
  RELIABLE source se (OCR, jo abhi translation-injection se corrupt
  nahi hua), content doosre source se (translated output) — dono ko
  ALAG-ALAG, apni sabse-reliable jagah se liya, na ki EK (already
  compromised) source se sab kuch nikalने ki koshish ki.**

  **Ye EXACTLY samझाता hai maine is poore session me baar-baar kyu
  galtiya repeat ki**: maine hamesha "detect specific broken property
  → PATCH usी property" approach use kiya (jaisा `tblPrEx/tblInd`
  mismatch fix karo, ya paragraph/shd mismatch fix karo) — ye assume
  karta hai ki BAAKI structure reliable hai, sirf EK property galat
  hai. Lekin jab structure khud (row-level tblPrEx overrides jo baar-
  baar reappear hote hain, multi-paragraph gaps jinki asli wajah pata
  nahi, deployment-state jo verify nahi ho pa raha) itni uncertain ho
  chuki ho ki main confidently bata hi nahi sakता "sirf YE ek property
  galat hai" — tab PATCHING kaam nahi karता, chahe individual patch
  apni jagah pe test karke sahi lage. White-line fix "worse" ho gaई
  (zyada tables me) — ye EXACTLY is symptom ka signal tha: main ek
  UNRELIABLE foundation pe patch laga raha tha.

  **Sabak, aage ke liye**: jab koi issue-class REPEATEDLY wapas aa
  raha ho (2+ baar, alag-alag patch-attempts ke bawजूद), ya jab
  structure itself (na ki sirf ek property) corrupt lage — us waqt
  "find aur patch ONE broken property" ki jagah socho: **"kya is
  poore element (table/cell/section) ko RELIABLE sources se REBUILD
  karna behtar hoगा — structure ek clean/pre-corruption source se,
  content doosre reliable source se, explicitly/deterministically sab
  properties set karके (margin se width, OCR se background, count se
  rows/columns) — na ki inherited/derived values pe depend karके?"**
  Rebuild-approach me empty rows/columns cleanup, alignment-by-length,
  wrap, vertical-align — sab AAKHIR me, ek CLEAN structure ke upar
  apply hote hain, na ki ek already-uncertain structure ke upar.

- **"BINA WIRE KIYE bheja gaya code ZERO VALUE hai" — user ne isse
  direct, sahi criticism ke roop me bataya.** Ek turn me maine
  `_rebuild_table_from_ocr_structure` banाई, extensively test kiya
  (14 checks), aur ek professional process-document + flowchart bhi
  banаके deliver kiya — lekin function ko REAL PIPELINE
  (`translate_existing_docx`) me kabhi CALL nahi kiya. Matlab jab
  user ne translation-service chalाई, un files me rebuild ka koi
  asar hi nahi tha — chahे function apne aap me kितnа bhi "working"
  ho. **"Maine ise banаya aur test kiya" ≠ "maine ise deliver kiya"
  — jab tak wo REAL, actual-chalne-wali pipeline ka hissa na ho, wo
  user ke liye kaam ki hi nahi hai.**

  Jab wire karke genuinely test kiya (poori `translate_existing_docx`
  ko real document pe end-to-end chalाके), **2 genuine crashes mile**
  jo standalone-testing me kabhi nahi pakड़e gaye the (ek regular table
  pe hi test kiya tha) — ek irregular row (gridSpan ke bina bhi kam
  cells) ne "tuple index out of range" diya 2/32 tables me. Ye confirm
  karta hai: **standalone/isolated testing, chahे kितnа bhi thorough
  lage, REAL end-to-end wiring ke bina kabhi "done" nahi maanना
  chahiye** — asli integration hi asli edge-cases saamне laाती hai.

  **Sabak**: koi bhi naya function/fix banाने ke baad, agla sawaal
  hamesha ye hona chahiye — *"kya ye ab REAL pipeline me chal raha
  hai, jab user apna normal workflow (translation-service start)
  chalााए?"* Agar jawab "nahi, abhi sirf standalone-tested hai" hai,
  to kaam **abhi complete nahi hua hai**, chahе documentation/testing
  kितnа bhi polished lage.
