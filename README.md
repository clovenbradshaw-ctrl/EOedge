# EO Local

On-device chat AI built on the nine-operator EO algebra. Every user turn compiles to a nested operator expression, executes against a local event log, and answers from structure when it can. The model runs only when it must.

## Running locally

ES modules, OPFS, and the module worker all need HTTP:

```bash
python3 -m http.server 8080
# then open  http://localhost:8080
```

## What you get

A chat interface. Type a question, a statement, or drop a document. Every response has a receipt showing the operator expression that produced it, the number of events scanned, and the tokens used (usually zero).

**Queries are Horizon scans on the packed event log.**
"What did Maria do last week?" compiles to `SEG(SEG(anchor:Maria, time:last_week))`. The tree walks the store via typed-array scans, returns matching events, renders a summary. Zero tokens. Sub-millisecond on 100k events.

**Statements run through the classification pipeline.**
"Maria closed James's referral this morning" compiles to `INS(clause:"…")`. The intake pipeline splits, classifies, anchors, and appends events to the log. The reply is a receipt: `Logged · EVA(Binding, Lens) on James's referral`.

**Document drops are batch classification.**
Drop a `.txt`, `.md`, or `.csv` into the chat. The intake pipeline classifies every clause and appends events. The reply summarises what was added and by what operator distribution.

**Synthesis uses the model, on structured input.**
"Summarize the pattern across Maria's cases this month" compiles to `SYN(SEG(anchor:Maria, time:this_month))`. The inner SEG pulls the event set via structural scan. Only the synthesis step calls the model, and the model sees classified events — not raw prose.

**NUL is a first-class answer.**
Chitchat, parse failures, empty results, absent data — all surface as explicit NUL responses with a reason. The system refuses to hallucinate when the honest answer is "nothing to report".

**Inspector drawer for structure.**
Tap the grid icon in the header to open the inspector. Tabs: Intake, Faces (three 3×3 lattices), Stream (append-only Given-Log), Multi-value (targets with several DEF values — projected when a DEF rule applies), REC (fold-surfaced proposals). Everything that happens in chat is visible here.

## What works without an API key

The entire chat interface. Queries, statements, document upload, heuristic classification, rule-based adjudication. The model is only invoked when:

1. The heuristic classifier can't confidently classify a clause during intake.
2. The chat's SEG/CON/SYN/EVA dispatch reaches a synthesis step with no rule match.

Add an Anthropic API key in the Inspector's Intake tab for those paths. Everything else works with zero network traffic.

## Embedding-based classification

First run, EO Local downloads `all-MiniLM-L6-v2` (~24 MB) via transformers.js, then bakes 27 centroids from the exemplars in [clovenbradshaw-ctrl/eo-lexical-analysis-2.0](https://github.com/clovenbradshaw-ctrl/eo-lexical-analysis-2.0) — the empirical work that shows the 27 cells separating in embedding space. Centroids are cached in localStorage after the first bake, so subsequent loads are instant.

While the model is loading, the chat works with heuristic-only classification. The status bar above the message list shows load progress. If the fetch fails (offline, firewall), the chat continues with heuristic-only and notes the degradation.

## Architecture

```
User types "what did Maria do last week"
    │
    ▼
chat-compile.js
    │  speech-act detection → "query"
    │  slot extraction → anchors=["Maria"], time=last_week
    │  tree = SEG(SEG(anchor:Maria, time:last_week))
    ▼
chat-execute.js
    │  walk tree bottom-up
    │  SEG → buildFilterFromTree → store.getEvents({ target, from, to })
    │  result = 7 events, 2ms, 0 tokens
    ▼
chat-render.js
    │  "7 events last week — 5 EVA, 1 CON, 1 DEF.
    │   · Mon 9:14 · EVA · Maria ▸ closed ▸ James's referral
    │   …"
    │  receipt = SEG(…) · 7 scanned · 0 tokens
    ▼
User sees chat reply with collapsible receipt
```

Every operator in the tree dispatches to existing runtime modules:
- `SEG` → `store.getEvents`
- `CON` → graph edge lookup
- `SYN` → event aggregation + optional model synthesis
- `DEF` → append DEF event + upsert anchor
- `EVA` → `rules.tryRules`, then fall back to user adjudication inline
- `REC` → surface proposal
- `INS` → `intake.ingest` pipeline
- `NUL` → propagate absence with reason

## File layout

```
eo-local/
├── index.html              — shell + chat container + inspector drawer
├── style.css               — warm paper aesthetic, chat + drawer styles
├── manifest.json           — PWA
├── sw.js                   — offline app shell
├── README.md
└── js/
    ├── app.js              — boots store, chat, inspector, fold
    ├── chat.js             — chat surface + composer + file drops
    ├── chat-compile.js     — prose → operator tree
    ├── chat-execute.js     — tree → result, walks operators against store
    ├── chat-render.js      — result → chat prose + receipt
    ├── upload.js           — drop zone + file text extraction
    ├── embeddings.js       — transformers.js + 27-cell centroid bake
    ├── ui.js               — inspector drawer content (six panels)
    ├── intake.js           — NUL gate → heuristic → model → append pipeline
    ├── horizon.js          — structural projections over the store
    ├── fold.js             — fold proposals (DEF rule installs / REC frame changes)
    ├── heuristic.js        — zero-token pattern classifier
    ├── model.js            — three-question model adapter
    ├── rules.js            — deterministic DEF-value resolver
    ├── seeds.js            — pre-classified seed events
    ├── anchor.js           — cyrb hash + UUIDv7
    ├── ops.js              — operator / site / resolution tables
    ├── store.js            — RPC facade over the storage worker
    └── store-worker.js     — OPFS owner, packed events, periodic flush
```

## Known limits

- Document upload handles plain text, markdown, CSV, and JSON. PDF support would be ~40 lines with pdf.js but isn't in v1.
- The main-thread buffer holds the packed events (~32 MB per million). Past ~10M events the snapshot-checkpoint pattern from EODB becomes necessary; the storage worker has room in the file header to add it.
- The fold scheduler runs on the main thread with `setTimeout`. A real Web Worker is v2.
- First run downloads the embedding model (~24 MB) and bakes centroids (~30–60 seconds). Subsequent runs use the cached centroids instantly. For production this should be pre-baked and committed so users get instant load.

## Clearing state

"Clear log" in the Inspector's Intake tab wipes the OPFS database — events, anchors, edges, frames, rules, metrics. localStorage (API key and centroids) is retained. To also clear centroids, open devtools → Application → Local Storage → remove the `eo-local-centroids-v1` key.

## Browser requirements

OPFS with SyncAccessHandle, module Workers, ES modules, IndexedDB for fallback scenarios. Chrome 102+, Safari 15.2+, Firefox 111+. Service worker registration is best-effort — the app still works online if the SW fails to install.
