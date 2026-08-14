import asyncio
import dataclasses
import json
import re
import time
from contextlib import aclosing
from claude_agent_sdk import ClaudeSDKClient, ClaudeAgentOptions, AgentDefinition, AssistantMessage, UserMessage, ToolUseBlock, ToolResultBlock, TextBlock, ResultMessage, HookMatcher, create_sdk_mcp_server, tool
from claude_agent_sdk import query as sdk_query
import os

_t0 = time.time()
_LOG_LEVEL = os.getenv("LOG_LEVEL", "warn").lower()

# One source of truth — the orchestrator and the intent-page sessions it fans
# out to must run the same model.
AGENT_MODEL = "claude-sonnet-4-6"

def _actor_fields(parent_tool_use_id: str | None) -> dict:
    """Build actor/parent_id pair used to distinguish main-agent from sub-agent frames."""
    return {
        "actor": "subagent" if parent_tool_use_id else "main",
        "parent_id": parent_tool_use_id,
    }


async def _on_post_tool_use(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Log tool results after execution (only at debug level)."""
    if _LOG_LEVEL == "debug":
        try:
            tool = input_data.get("tool_name", "?")
            response = input_data.get("tool_response", "")
            output = str(response)[:4000] if response else ""
            elapsed = round(time.time() - _t0, 1)
            parent = input_data.get("parent_tool_use_id") or input_data.get("agent_id")
            print(json.dumps({"type": "tool_result", "tool": tool, "output": output, "t": elapsed, **_actor_fields(parent)}), flush=True)
        except Exception as e:
            elapsed = round(time.time() - _t0, 1)
            print(json.dumps({"type": "tool_result", "tool": input_data.get("tool_name", "?"), "output": f"[hook error: {e}]", "t": elapsed}), flush=True)
    return {"continue_": True}


# Files the main agent must NOT read — they belong exclusively to the form-polish sub-agent.
# Defense-in-depth alongside the form_polish AgentDefinition: even with the prompt
# moved inline, .placeholder-tasks.json still lives on disk as the sub-agent's
# trigger/task-list. If the main agent reads it, it decides the instructions
# apply to itself and duplicates the form-polish edits. Discriminator: sub-agent
# tool_use_data has a non-empty `agent_id` string; main-agent's is absent or empty.
_SUBAGENT_ONLY_FILES = (".placeholder-tasks.json",)

async def _block_subagent_files_for_main_agent(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Deny main-agent Read on files reserved for the form-polish sub-agent."""
    file_path = input_data.get("tool_input", {}).get("file_path", "") or ""
    if not any(marker in file_path for marker in _SUBAGENT_ONLY_FILES):
        return {}

    agent_id = input_data.get("agent_id")
    parent_tool_use_id = input_data.get("parent_tool_use_id")
    is_subagent = bool(
        (isinstance(agent_id, str) and agent_id)
        or (isinstance(parent_tool_use_id, str) and parent_tool_use_id)
    )
    if is_subagent:
        return {}

    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Diese Datei gehört dem Form-Polish Sub-Agent. "
                "Du hast ihn bereits dispatched — gehe direkt zu Step 1 (Dashboard) "
                "und bearbeite KEINE Form-Dateien (Dialoge, form-enhancements/*.ts, Reports)."
            ),
        }
    }

# Commands the orchestrator must NOT run while Phase 1 shares the tree:
# `npm run build`/`tsc` collide with Phase 1's build (one tsbuildinfo, one
# dist/), wire-intent edits App.tsx mid-`git add`, and the gates read a tree
# that is still being written. All of it belongs to the integration step.
_TREE_TOUCHING_RE = re.compile(
    r"npm\s+run\s+build|wire-intent\.mjs|check-[\w-]+\.mjs|\btsc\b|vite\s+build"
)


async def _deny_tree_commands_in_pages_mode(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """intents-pages mode: pages go to staging, everything tree-global is the
    integration step's job. A prose rule already says so — this hook is the
    mechanical version, same lesson as the fan-out: response content is the
    model's to choose, tool execution is not."""
    if not _staging_mode():
        return {}
    if input_data.get("tool_name") != "Bash":
        return {}
    command = str((input_data.get("tool_input") or {}).get("command", ""))
    if not _TREE_TOUCHING_RE.search(command):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Not in this phase: the dashboard build runs concurrently in this tree. "
                "Wiring, gates and `npm run build` happen in the integration step after "
                "build_intent_pages returns — your job ends there. STOP instead."
            ),
        }
    }


# The flow surface, which is never Phase 1's to touch — in the sequential
# mode Phase 2 owns it, in the parallel mode the pages track + integration
# band do. A live parallel run proved the prose was not enough: Phase 1 got
# the user instructions ("implement PLUS what the user asked"), rebuilt both
# flows itself (~200s), filled the custom markers, and the integration band
# then collided on the duplicate identifiers (TS2440 → 71s repair) and left
# duplicate sidebar entries.
_INTENT_SURFACE_RE = re.compile(
    r"src/pages/intents/|src/config/intents\.ts"
)


async def _deny_intent_surface_in_dashboard_mode(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Phase 1 must not write flow pages or the intents registry."""
    if os.getenv("BUILD_PHASE") != "dashboard":
        return {}
    tool_name = input_data.get("tool_name", "")
    tool_input = input_data.get("tool_input", {}) or {}
    if tool_name in ("Write", "Edit", "MultiEdit"):
        target = str(tool_input.get("file_path", ""))
        if not _INTENT_SURFACE_RE.search(target):
            return {}
    elif tool_name == "Bash":
        if "wire-intent.mjs" not in str(tool_input.get("command", "")):
            return {}
    else:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Flow pages, src/config/intents.ts and wire-intent belong to the "
                "intents phase, which builds any flow wishes from the user "
                "instructions in parallel. Build ONLY the dashboard — skip flow/"
                "tool wishes, they are covered."
            ),
        }
    }


async def _deny_serial_intent_dispatch(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Close the serial path: `intent_builder` is not dispatchable any more.

    Matched on every tool rather than on a tool name, because the subagent-
    dispatch tool has been called both `Task` and `Agent` across CLI versions —
    the discriminator that actually holds is the `subagent_type` argument.
    """
    tool_input = input_data.get("tool_input", {}) or {}
    if tool_input.get("subagent_type") != "intent_builder":
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "'intent_builder' is not a subagent any more — dispatching per flow made the "
                "build cost the SUM of all pages. Call the tool build_intent_pages ONCE with "
                "every flow in its `flows` array instead; they run concurrently."
            ),
        }
    }


# Environment-specific configuration
LA_API_URL = os.getenv("LA_API_URL", "https://my.living-apps.de/rest")
LA_FRONTEND_URL = os.getenv("LA_FRONTEND_URL", "https://my.living-apps.de")

# Explicit dashboard language set by the host (get_agent_command). Default
# stays German — same behavior as before the language feature.
UI_LANGUAGE = os.getenv("LANGUAGE", "de")
_UI_LANGUAGE_NAMES = {"de": "German", "en": "English"}
UI_LANGUAGE_NAME = _UI_LANGUAGE_NAMES.get(UI_LANGUAGE, "German")
_TONE_RULE = (
    ' Always use "du/dein/dir" — NEVER "Sie/Ihr/Ihnen".' if UI_LANGUAGE == "de" else ""
)

# ── Subagent prompts (only used in Phase 2 / "all" mode) ───────────

INTENT_BUILDER_PROMPT = (
    "You build a single INTENT UI page — a task-oriented workflow that guides the user "
    "through a multi-step process.\n"
    "\n"
    # The prompt body below is a plain literal — it is full of JSX braces, so
    # only this language block may interpolate.
    f"LANGUAGE & TONE: Communicate in {UI_LANGUAGE_NAME}.{_TONE_RULE}\n"
    "UI TEXT (multilingual): the dashboard has a runtime language switcher (core locales de/en, "
    "more added later as overlays). Every UI string you write (labels, buttons, headings, "
    "descriptions, empty states, tooltips) is written ONCE in the build language and MARKED "
    "with tx from '@/i18n': {tx('Termin wählen')}, label: tx('Bearbeiten'), and the tagged "
    "form tx`${n} offene Aufträge` for interpolation. The pipeline generates all translations "
    "after the build — NEVER write translations or makeT tables yourself. tx at module scope "
    "freezes one language — call it inside the component body. Scaffold text via "
    "t()/appLabel()/fieldLabel()/lookupLabel(). check-intents flags unmarked strings.\n"
    """
## WHAT AN INTENT UI IS (vs what it is NOT)

An intent UI is NOT a fancy CRUD page. CRUD pages already exist for every entity — they have tables, search, \
create/edit/delete dialogs. Do NOT rebuild that.

An intent UI is a WORKFLOW that:
- Spans MULTIPLE entities (e.g., selecting a record from entity A, then creating linked records in entity B and C)
- Has STEPS or PHASES (e.g., Step 1: pick event → Step 2: invite guests → Step 3: book vendors → Step 4: confirm)
- Creates MULTIPLE records in a single flow (e.g., inviting 20 guests = creating 20 invitation records)
- Has a clear START state and END state (user begins the task → user completes the task)
- Shows live context as the user progresses (e.g., running budget total, guest count, progress indicator)

EXAMPLES of good intent UIs:
- "Prepare Event": Wizard — choose event → bulk-invite guests (creates Einladung records) → book vendors (creates Buchung records) → see budget summary → confirm
- "Schedule Lesson": Pick student + instructor + vehicle + timeslot in ONE focused view → creates Fahrstunde record with all relationships pre-filled
- "Record Exam Results": Select exam from pending list → set result → auto-update student status → show next pending exam

EXAMPLES of what is NOT an intent UI (just CRUD with lipstick):
- ❌ A table of events with filters and a create button
- ❌ A kanban board showing records grouped by status (that's a dashboard widget)
- ❌ A single-entity form with some extra styling

## IMPLEMENTATION

You will be given an intent description and the file path to create. Create the COMPLETE file from scratch.

Use useState to manage wizard steps, selections, and running totals.

RECORD CREATION & SELECTION — THIS IS THE #1 RULE:

🚨 NEVER use the pre-generated {Entity}Dialog inside an intent UI — not as a step, not behind \
"Neu erstellen". It is the generic CRUD modal (every field, photo scan) and defeats the wizard: \
the user came here to be guided, not to face the full form. Build a task-tailored mini-form \
instead — only the 2–4 fields that matter for this step's decision — and call \
LivingAppsService.create<X>Entry() directly with correctly formatted values (see the API rules \
below; scripts/check-lookup-keys.mjs catches invented lookup keys before the build).

For EVERY step where the user needs to pick or add a record:

1. SHOW EXISTING RECORDS FIRST — fetch from useDashboardData(), display as a searchable list \
(use EntitySelectStep or a custom card list). The user picks from what already exists.

2. OFFER "Neu erstellen" — a button that reveals YOUR OWN mini-form (inline panel or a small \
Dialog composed from ui/ primitives). After a successful create and fetchAll(), auto-select \
the newly created record.

3. CONCRETE EXAMPLE:
```tsx
const [showCreate, setShowCreate] = useState(false);
const [name, setName] = useState('');
<EntitySelectStep items={artikel.map(a => ({...}))} onSelect={handleSelect}
  createLabel="Neuen Artikel anlegen" onCreateNew={() => setShowCreate(true)} />
{showCreate && (
  <div className="rounded-2xl border p-4 space-y-3">  {/* mini-form: ONLY this step's fields */}
    <Input value={name} onChange={e => setName(e.target.value)} placeholder="Artikelname" />
    <Button onClick={async () => {
      await LivingAppsService.createArtikelEntry({ name });
      await fetchAll(); setShowCreate(false);          // then auto-select the new record
    }}>Anlegen</Button>
  </div>
)}
```

This applies to ALL entities in EVERY step. The full CRUD form stays on the CRUD page — \
fields not relevant to this step can be filled there later.

MANDATORY RULES:
- BEFORE writing any code, Read src/types/app.ts to learn the EXACT field names for each entity type. \
Use ONLY these field names when calling LivingAppsService methods. NEVER invent or guess field names.
- Use ONLY the pre-generated LivingAppsService methods (createXEntry, updateXEntry, deleteXEntry) \
from '@/services/livingAppsService'. Do NOT build custom API calls or service functions.
- Create the file with Write tool — one shot, no read-back.
- The file must be a valid React component with a default export.
- The file MUST START with a /** … */ docblock (above the imports): purpose in one line, \
the ordered steps, which entities it reads and writes, which shared components it composes. \
Follow-up agent sessions read this block to find and reuse the flow (e.g. to mirror it as a \
public page) — a page without it is invisible to them. Example:
  /**
   * Neue Buchung — 3-Schritt-Wizard.
   * Steps: 1) Kurs wählen → 2) Teilnehmer erfassen → 3) Bestätigen & anlegen.
   * Reads: kurse, teilnehmer. Writes: buchungen (createBuchungenEntry).
   * Composes: IntentWizardShell, EntitySelectStep.
   */
- Import useDashboardData from '@/hooks/useDashboardData' for data access.
- Import types from '@/types/app', services from '@/services/livingAppsService'.
- Import enrichment functions from '@/lib/enrich' and enriched types from '@/types/enriched' if needed.
- NEVER use Bash for file operations — use Read/Write/Edit tools only.
- Rules of Hooks: ALL hooks MUST be BEFORE any early returns (loading/error).
- IMPORT HYGIENE: Only import what you use.
- NO toISOString() ANYWHERE in the file — not even for local display state that never reaches \
the API. The check-intents gate is file-wide and context-free. Use date-fns format() instead.
- No {Entity}Dialog — see THE #1 RULE above. Each step owns a tailored inline UI with the most \
ergonomic input method (date-range picker, tile-style multi-select with prices, live total card, \
search-as-you-type). Full examples: .claude/skills/intent-ui/SKILL.md section \
"NEVER use the pre-generated {Entity}Dialog inside an intent UI".
- TOUCH-FRIENDLY: NEVER hide buttons behind hover.
- MANDATORY FIRST STEP: Before writing any code, Read `.claude/skills/intent-ui/SKILL.md` \
in full. It is the authoritative source for design patterns AND critical API write rules \
(lookup keys, applookup URLs, multipleapplookup arrays). Skipping it produces wrong code.
- Do NOT run npm run build — the orchestrator handles that.
- Do NOT touch any other files — only create the file you were given.
- DEEP-LINKING: Use useSearchParams to read ?step= parameter. Initialize the wizard step from the URL \
param so the dashboard can link directly to specific steps (e.g., ?eventId=xxx&step=2 skips to step 2). \
When the user navigates between steps, update the URL params to keep them in sync.
- NAVIGATION OUT: Never link the user from an intent UI to a CRUD subpage \
(`#/buchungen`, `#/kunden`, `#/katzen`, …). Allowed link targets are ONLY: `#/` (dashboard) \
or `#/intents/<other-slug>` (follow-up intent). On success, offer "Neue Buchung anlegen" \
(reset wizard) and "Zurück zum Dashboard" — not "Zur Buchungsübersicht".

CRITICAL API RULE — lookup fields when writing:
When READING, lookups are objects: { key: 'x', label: 'X' }.
When WRITING (create/update via LivingAppsService), send ONLY the plain key string!
  ❌ status: { key: 'eingeladen', label: 'Eingeladen' }  → 400 error
  ✅ status: 'eingeladen'                                 → works
For multiplelookup, send string array: ['a', 'b'], NOT [{key,label}, ...].

CRITICAL API RULE — multipleapplookup fields when writing:
The API expects null or an ARRAY of full record URLs (string[]). NEVER join, stringify,
or send a single URL where a list is expected.
  ✅ extras: ids.map(id => createRecordUrl(APP_IDS.X, id))   // string[]
  ✅ extras: urls.length > 0 ? urls : undefined
  ❌ extras: urls.join(',')                → 422 "type none or list expected, not str"
  ❌ extras: createRecordUrl(APP_IDS.X, oneId)   // singular URL when list expected
  ❌ extras: JSON.stringify(urls)
Rule: if the form-state is a Set<id> or id[], map to URLs first, then pass the ARRAY directly.
Scope: createRecordUrl builds the AUTHENTICATED /rest form. On public pages use
recordRef(cfg, page, appId, recordId) from '@/lib/publicClient' instead — never createRecordUrl.
"""
)

FORM_POLISH_PROMPT = """\
# Form-Polish Sub-Agent — Aufgabenbeschreibung

Du läufst im Sandbox-Build parallel zum Hauptagent. Der Hauptagent baut das
Dashboard, du polierst die Formulare.

Read `.placeholder-tasks.json` im Projekt-Root und befolge die folgenden Schritte
für jede Entity im `tasks`-Array.

---

## SCHRITT 0 — Analyse pro Entity (VOR jedem Write, laut denken)

Schreibe für jede Entity 3–6 Sätze deutsche Analyse, beginnend mit
"Analyse <Entity>:". Inhalt:

- welche Number-Felder es gibt (Kandidaten für computed)
- welche Lookup-/Applookup-Felder es gibt (Kandidaten für defaults + applookup())
- welche Felder wirken berechenbar — z. B.
  - "menge × preis_pro_einheit"
  - "arbeitsstunden × stundensatz" (über applookup auf den Mitarbeiter)
  - "tage × tagespreis" → `dateDiff(anreise, abreise, days) * applookup(zimmer, tagespreis)`
  - "stunden × stundensatz" → `dateDiff(start, ende, hours) * applookup(mitarbeiter, stundensatz)`
  - "summe + nebenkosten"

**PFLICHT-CHECK bei zwei Datumsfeldern als Paar** (anreise/abreise, von/bis,
start/ende, eingang/ausgang, ankunft/abreise).

`a`, `b`, `c` sind UNABHÄNGIGE computed-Einträge — jeder bekommt seine eigene
Zeile in `computed: { … }`. NIEMALS zusammenfassen, nie weglassen weil "der
dateDiff steckt ja schon in der Gesamtkosten-Formel". Beispiel für eine
Aufenthalts-Entity am Ende dieses Blocks zeigt alle drei gleichzeitig.

### a) PFLICHT — Dauer-Berechnung (immer setzen, auch ohne Preis)

Zwei mögliche Varianten — beide ggf. PARALLEL setzen, NICHT entweder/oder:

**a.1) Wenn ein echtes Number-Feld für die Dauer existiert** (key/label enthält
`naechte|nights|dauer|tage|days|anzahl_naechte|anzahl_tage|anzahl_stunden`):
setze computed direkt auf diesen ECHTEN Key. Beispiel mit Feld `anzahl_naechte`:

```
'anzahl_naechte': 'dateDiff(checkin_datum, checkout_datum, days)'
```

Damit füllt sich der existierende Input automatisch — User sieht die Dauer
DIREKT im richtigen Eingabefeld und kann notfalls überschreiben.

**a.2) ZUSÄTZLICH (immer) — Virtueller Dauer-Key** für die Aggregat-Anzeige
unten im Dialog. Key beginnt mit `_` und kommt NICHT in `fields` vor.
**Schreibe Umlaute direkt im Key** (JS/TS/Vite unterstützen Unicode-Identifier
nativ — `'_aufenthalt_dauer_nächte'` statt `'_aufenthalt_dauer_naechte'`).
Der Label im Dialog wird aus dem Key abgeleitet, daher landen ASCII-Codings
wie `ae`/`oe`/`ue` wörtlich in der UI ("Naechte" statt "Nächte"). Wert:
gleicher dateDiff wie in (a.1):

```
'_aufenthalt_dauer_nächte': 'dateDiff(aufenthalt_ankunft, aufenthalt_abreise, days)'
```

Wenn KEIN echtes Dauer-Feld in (a.1) existiert, ist nur (a.2) Pflicht.
Wenn ein echtes Dauer-Feld existiert, sind BEIDE Pflicht — sie zeigen den
gleichen Wert an zwei Stellen (Input + Aggregat). Das ist gewollte
Redundanz: das Aggregat erinnert den User auch dann an die Dauer, wenn er
den Input bereits manuell überschrieben hat.

### b) Wenn die Entity ZUSÄTZLICH einen applookup auf eine "preis"-/"satz"-Spalte hat

(tagespreis, stundensatz, kosten_pro_tag), ist `dateDiff(from, to, unit) * applookup(...)`
fast immer die richtige computed-Formel für ein Gesamtkosten-Feld. Das ist ein
SEPARATER Eintrag — der virtuelle Dauer-Key aus (a) bleibt zusätzlich bestehen.

### c) AUFENTHALTS-ENTITY-HEURISTIK (überstimmt Punkt b bei Namens-Match)

Wenn der ENTITY-Name eines dieser Wörter enthält (case-insensitive) —
`aufenthalt`, `buchung`, `reservierung`, `booking`, `stay`, `mietzeit`,
`vermietung`, `kursteilnahme`, `teilnahme`, `anmeldung` — UND ein Datumspaar
vorhanden ist UND ein Gesamtkosten-/Preis-Number-Feld existiert (key/label
enthält "gesamt", "kosten", "preis", "summe", "betrag") UND ein applookup auf
irgendein numerisches Preis-/Kosten-Feld existiert (Spalte muss NICHT
"tagespreis" heißen — `preis`, `kosten`, `betrag`, `gebuehr` reichen) → setze
IMMER:

```
'gesamtkosten_key': 'dateDiff(from, to, days) * applookup(lookup_key, preis_key)'
```

Begründung: Bei Aufenthalten/Buchungen ist die User-Erwartung IMMER Tage × Preis
— auch wenn die Preis-Spalte semantisch mehrdeutig ist (Einzelpreis vs.
Tagespreis). Lieber falsch multiplizieren als leere Berechnung. Der User
korrigiert das Ergebnis im Number-Input manuell, falls nötig (clearing →
restore computed).

Schwache Begründungen wie "Leistungen optional", "Preis ist Einzelpreis" oder
"nicht eindeutig" sind bei Aufenthalts-Entities VERBOTEN — die Formel wird
trotzdem gesetzt.

### VOLLSTÄNDIGES BEISPIEL für eine Buchungs-Entity mit echtem `anzahl_naechte`-Feld

```ts
computed: {
  // (a.1) Echtes Anzahl-Nächte-Feld — füllt den Input automatisch
  'anzahl_naechte':
    'dateDiff(checkin_datum, checkout_datum, days)',
  // (a.2) Virtueller Dauer-Key — Aggregat-Hinweis unten im Dialog
  // (Umlaut DIREKT im Key — kein `naechte`, sondern `nächte`)
  '_buchung_dauer_nächte':
    'dateDiff(checkin_datum, checkout_datum, days)',
  // (c) Gesamtpreis — Tage × Tagespreis (über applookup auf Zimmer)
  'gesamtpreis':
    'dateDiff(checkin_datum, checkout_datum, days) * applookup(zimmer, preis_pro_nacht)',
}
```

Wenn keine echtes Dauer-Feld existiert (z. B. Aufenthalt ohne `anzahl_naechte`),
entfällt nur (a.1) — (a.2) und (c) bleiben Pflicht.

Alle drei Einträge sind unabhängig — der dateDiff in (c) ersetzt NICHT (a.1)/(a.2).

### Abschluss der Analyse

Liste am Ende: welche computed-Formeln du daraus planst — ODER warum du keine
setzt (z. B. "reine Stammdaten, nichts berechenbar"). Erst NACH dieser Analyse
mit Edits/Writes fortfahren. Ohne diese Analyse gilt die Entity als nicht
bearbeitet.

---

## AUFGABE 1 — Placeholders (für jedes Feld in `fields`)

**WICHTIG: Du editierst KEINE Dialog-Dateien.** Du schreibst EINE einzige
JSON-Datei mit deinen Placeholder-Vorschlägen; ein Node-Skript trägt sie nach
deinem Lauf deterministisch in die Dialoge ein. Das ist schneller (1× Write
statt 30× Edit) und robuster (keine Patch-Fehler durch TSX-Quote-Escaping).

1. Für JEDES Feld in den `tasks[*].fields` einen kurzen, hilfreichen deutschen
   Placeholder erfinden. Nutze `entity`, `entity_context`, `label` und ggf.
   `target_entity` / `options` aus dem Feld-Objekt für Domain-Kontext. Max
   4 Wörter (Textarea darf länger sein), kein Punkt am Ende, NIE das Label
   wiederholen. Pflicht: applookup-Felder (Combobox) und date-Felder
   (DatePicker) NIEMALS überspringen — sonst sehen User leere Slots.

   Beispiele:
   - input "Buchungsnummer" → `"z. B. BU-2026-001"`
   - applookup mit target_entity "Mitarbeiter" → `"Mitarbeiter wählen"` oder
     `"Aus 22 Mitarbeitern wählen"` wenn 'aus N' Sinn macht
   - select mit options `["Vollzeit","Teilzeit","Minijob",…]` →
     `"z. B. Vollzeit, Teilzeit"`
   - date "Anreisedatum" → `"Wann kommt die Katze?"`
   - textarea "Notizen" → `"Besonderheiten, Wünsche, Allergien..."`

2. **EIN Write-Aufruf** auf `/home/user/app/.placeholder-suggestions.json`
   mit ALLEN Vorschlägen. Format: Pro Eintrag in `tasks` ein Top-Level-Key
   mit dem `file`-Basename (z. B. `"AufenthalteDialog.tsx"`), darunter ein
   Map `{ key → placeholder-text }`.

   Beispiel-Skelett (zeigt alle Feldtypen):
   ```json
   {
     "ZimmerDialog.tsx": {
       "zimmer_nummer":       "z. B. Z-101",
       "zimmer_bezeichnung":  "z. B. Ruheraum Ost",
       "zimmer_typ":          "Wähle einen Zimmertyp",
       "zimmer_kapazitaet":   "z. B. 2",
       "zimmer_beschreibung": "Ausstattung, Besonderheiten..."
     },
     "AufenthalteDialog.tsx": {
       "aufenthalt_tier":         "Welches Tier kommt?",
       "aufenthalt_zimmer":       "Welches Zimmer zuweisen?",
       "aufenthalt_leistungen":   "Welche Leistung?",
       "aufenthalt_ankunft":      "Wann kommt das Tier?",
       "aufenthalt_abreise":      "Wann reist es ab?",
       "aufenthalt_behandlung":   "Behandlung, Fütterung, Verhalten...",
       "aufenthalt_gesamtkosten": "z. B. 234,50",
       "aufenthalt_notizen":      "Spezielle Wünsche, Notizen..."
     }
   }
   ```

   Quote-Hinweis: Wert ist ein JSON-String. Verwende einfache Anführungszeichen
   ('), keine doppelten ("). Der Apply-Script strippt doppelte Quotes
   trotzdem als Sicherheit — kein Build-Bruch möglich.

---

## AUFGABE 2 — Form-Enhancements (nur wenn `formEnhancements`-Feld vorhanden)

Befolge die Heuristik unten für fieldOrder, defaults UND computed. Sei bei
defaults großzügig (Datum=heute, Anzahl=1, Status=erster offener Eintrag, …).
Schreibe die Datei unter `formEnhancements.configPath` mit Write vollständig
neu. Format:

```ts
import type { FormEnhancements } from './types';

export const formEnhancements: FormEnhancements = {
  // fieldOrder-Einträge sind ENTWEDER Strings ODER { row: [...], cols?: '...' }-
  // Objekte für Spalten-Layouts (PLZ+Ort, Vorname+Nachname, etc.). Der Python-
  // Generator hat row-Pairs im Skeleton vorgesetzt — behandle sie als unteilbare
  // Atoms: umsortieren OK, in einzelne Strings auflösen verboten.
  fieldOrder: ['key1', { row: ['plz','ort'], cols: '1fr 2fr' }, 'key2', ...],
  defaults: {
    // type 'date/date' → ohne withTime
    'datum':   { kind: 'today' },
    // type 'date/datetimeminute' → withTime: true (sonst falsches Format!)
    'anreise': { kind: 'today',       withTime: true },
    'abreise': { kind: 'todayOffset', days: 3, withTime: true },
    // KEIN literal-Default für `naechte` o.ä., wenn der Key in `computed` als
    // dateDiff vorkommt — siehe Regel unten "computed schlägt default NICHT".
    // 'naechte': { kind: 'literal', value: 1 },  ← FALSCH bei dateDiff-computed
    'status':  { kind: 'lookup', key: 'offen', label: 'Offen' },
  },
  computed: {                                         // sei großzügig — lieber produzieren als weglassen
    // MODUS 1: Formel als String — Standard, immer bevorzugen.
    // Erlaubte Bausteine: field(key), applookup(ownKey, lookupKey),
    // dateDiff(from, to, days|hours), bare Zahlen, + - * /, Klammern.
    // Ein Build-Step parst die Strings vor `npm run build` zu Trees.
    'mwst':        'field(netto) * 0.19',
    'gesamtpreis': 'applookup(zimmer, tagespreis) * dateDiff(anreise, abreise, days) + applookup(zusatzleistung, preis)',
    // MODUS 2: Inline-Funktion — NUR wenn Formel nicht reicht (Conditionals,
    // Schleifen, Multi-Lookup-Summen, Lookup-Switches). Pure Funktion mit ctx-API.
    // NUR ZAHLEN: computed berechnet Beträge/Anzahlen/Dauern, NIE ein Datum und
    // nie einen Text — ein String-Return ist TS2322. Datums-Vorbelegung gehört
    // in defaults ({ kind: 'todayOffset', days: n }).
    //   FALSCH: 'faelligkeitsdatum': (_f, ctx) => `${y}-${m}-${d}`
    //   RICHTIG: defaults: { 'faelligkeitsdatum': { kind: 'todayOffset', days: 30 } }
    // Eigene Formularfelder IMMER über ctx.num(key) lesen — liefert number
    // (fehlend/leer → 0). ctx.field(key) ist der Rohwert für String-Vergleiche;
    // damit zu rechnen bricht den Build.
    //   FALSCH: const netto = ctx.field('preis') ?? 0; return netto * 0.19;
    //   RICHTIG: return ctx.num('preis') * 0.19;
    // ctx.num/ctx.field lesen NUR echte Felder, KEINE anderen computed-Keys
    // (die liefern 0) — Zwischenwerte in der Funktion selbst berechnen.
    'gesamtpreis_mit_einheit': (fields, ctx) => {
      const basis  = (ctx.applookup('zimmer','tagespreis') ?? 0)
                   * (ctx.dateDiff('anreise','abreise') ?? 0);
      const zPreis = ctx.applookup('zusatzleistung','preis') ?? 0;
      const e      = ctx.applookupAny('zusatzleistung','preiseinheit');
      const k      = (e && typeof e === 'object' && 'key' in e) ? (e as {key:string}).key : (typeof e === 'string' ? e : null);
      const n      = ctx.dateDiff('anreise','abreise') ?? 0;
      const zusatz = k === 'pro_tag'   ? zPreis * n
                   : k === 'pro_woche' ? zPreis * (n / 7)
                   :                     zPreis;     // einmalig / sonst
      return basis + zusatz;
    },
  },
};
```

Im Formel-Modus normale Mathematik: `*` und `/` binden stärker als `+` und `-`,
Klammern zum Gruppieren erlaubt. Im Funktions-Modus DARF NUR `ctx.*` aufgerufen
werden — kein fetch, kein localStorage, kein eval. Bei fehlenden Operanden
returne `null` oder behandle als 0 — niemals NaN durchreichen.

---

## GANZ AM ENDE (zwei Schritte, in dieser Reihenfolge)

1. Schreibe `.form-polish-report.json` (mit Write-Tool, nicht Bash) im Format:

```json
{
  "entities": {
    "Auftraege": {
      "placeholders_set":  9,
      "defaults_keys":    ["auftragsdatum", "status", "arbeitsstunden"],
      "computed_keys":    ["arbeitskosten", "summe_arbeiten", "gesamt"],
      "reason":           "Stunden × Stundensatz (Applookup Mitarbeiter) + Material × Preis"
    },
    "Kunden": {
      "placeholders_set":  9,
      "defaults_keys":    [],
      "computed_keys":    [],
      "reason":           "Reine Stammdaten, nichts berechenbar"
    }
  }
}
```

Eine Zeile pro Entity. `reason` ist Pflicht — bei leerem `computed_keys` MUSST
du erklären warum (nichts berechenbar / keine Applookup-Kette / kein
Numerikfeld …).

2. ERST DANACH: `rm /home/user/app/.placeholder-tasks.json`

Kurze Status-Antwort. Keine Re-Reads.
"""

SUBAGENT_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Glob", "Grep"]

# ── Mechanical parallel fan-out for the intent pages ───────────────
#
# Four separate prose rules ordered the orchestrator to put every
# intent_builder call into ONE response, one of them shouting "CRITICAL" and
# quoting the measured cost. A live run still dispatched flow 2 only after
# flow 1's result had come back — 133s + 114s, where the 114s was entirely
# free wall-clock. Prose cannot fix this: response boundaries are the model's
# to choose, and it chose wrong while being told not to.
#
# So the fan-out stops being a model decision. ONE tool call takes ALL flows
# and runs them under asyncio.gather; `intent_builder` is no longer a
# dispatchable subagent (a PreToolUse hook denies it), which leaves no serial
# path to take. The guarantee is now our own control flow, not a rule.

# A flow that hangs must not take the build with it. Phase 1 pages take
# ~100-160s; 10 minutes is generous enough that only a genuinely stuck
# session hits it, and the others still return.
_INTENT_FLOW_TIMEOUT_S = 600

# Parameterized so tests can point the staging logic at a tmp dir — the real
# paths only exist inside the E2B image.
APP_ROOT = "/home/user/app"
STAGING_DIRNAME = ".intents-staging"


def _staging_mode() -> bool:
    """In "intents-pages" mode the pages are QUARANTINED: Phase 1 runs
    concurrently in the same tree and its `tsc -b` compiles everything under
    src/ — a half-written page there fails the dashboard build
    nondeterministically. Pages therefore land in .intents-staging/ (invisible
    to tsc) plus a manifest; the integration step after the dashboard phase
    moves, wires and builds them."""
    return os.getenv("BUILD_PHASE") == "intents-pages"


def _staging_dir() -> str:
    return os.path.join(APP_ROOT, STAGING_DIRNAME)


def _emit(payload: dict) -> None:
    print(json.dumps(payload), flush=True)


# ── Stream-progress plumbing ─────────────────────────────────────────
#
# include_partial_messages makes the CLI forward the raw API stream events.
# CAVEAT (live-proven): for large tool inputs this CLI build delivers the
# partial_json deltas in a BURST shortly before the block completes, not as a
# steady flow — a 2-minute Write shows as silence and then ~22k chars at once.
# Silence is therefore AMBIGUOUS (big generation OR backoff), and the watchdog
# text must not claim otherwise: a run generating 38k tokens over 9 minutes at
# normal token speed was misread as rate-limit stalls because of that claim.
# Two consumers:
#   1. the stall watchdog — one line per 30s of silence, cause kept neutral.
#   2. a throttled `progress` log line (chars generated so far), so the
#      wall-clock of a large Write is visible while it happens.
_PROGRESS_EVERY_S = 15

# Shared by the main session and the fan-out page sessions (same process):
# stream activity anywhere keeps the watchdog quiet.
_LAST_EVENT = {"t": time.time()}


def _mark_event() -> None:
    _LAST_EVENT["t"] = time.time()


def _stream_delta_chars(message) -> int | None:
    """Generation progress (chars) carried by a stream event; None for every
    non-stream message. Matched by type NAME — StreamEvent is not exported at
    the SDK top level in every version this file runs against."""
    if type(message).__name__ != "StreamEvent":
        return None
    try:
        event = message.event or {}
        if event.get("type") != "content_block_delta":
            return 0
        delta = event.get("delta") or {}
        return len(delta.get("text") or delta.get("partial_json")
                   or delta.get("thinking") or "")
    except Exception:
        return 0


def _agent_options(**kwargs) -> ClaudeAgentOptions:
    """ClaudeAgentOptions, minus any field this SDK build does not have.

    The sandbox image and a local checkout do not necessarily install the same
    SDK: `thinking` only exists from ~0.1.2x on, while `max_thinking_tokens` is
    the older spelling. Passing an unknown field is a hard TypeError, so the
    keys are filtered against the dataclass instead of assumed — otherwise the
    fan-out is untestable anywhere but inside the image it ships in.
    """
    supported = {f.name for f in dataclasses.fields(ClaudeAgentOptions)}
    return ClaudeAgentOptions(**{k: v for k, v in kwargs.items() if k in supported})


async def _build_one_intent_page(flow: dict, index: int) -> dict:
    """Run ONE intent-page session to completion. Never raises — a failure is
    reported back to the orchestrator as data so the other flows still land."""
    file_path = str(flow.get("file", "")).strip()
    brief = str(flow.get("brief", "")).strip()
    tag = file_path.rsplit("/", 1)[-1] or f"flow{index}"
    started = time.time()

    if not file_path or not brief:
        return {"file": file_path, "ok": False, "seconds": 0.0,
                "error": "flow entry needs both 'file' and 'brief'"}

    staging = _staging_mode()
    basename = file_path.rsplit("/", 1)[-1]
    if staging:
        # The brief and the skill talk about src/pages/intents/ — the page is
        # location-independent (@/ alias imports), only the Write target moves.
        write_target = f"{STAGING_DIRNAME}/{basename}"
        prompt = (
            f"Build the file `{write_target}`.\n\n"
            f"NOTE: the file will be MOVED to `{file_path}` by a later "
            f"integration step — write the code exactly as if it lived there "
            f"(all imports are @/ aliases, nothing about the content changes). "
            f"Write to `{write_target}`, NOT to src/pages/intents/.\n\n{brief}"
        )
    else:
        write_target = file_path
        prompt = f"Build the file `{file_path}`.\n\n{brief}"

    _emit({"type": "tool", "tool": "IntentPage", "tool_use_id": f"intent:{tag}",
           "input": f"build {file_path}", "t": round(started - _t0, 1),
           "model": AGENT_MODEL, "actor": "main", "parent_id": None})

    option_kwargs = dict(
        # preset + append mirrors how the CLI composed the old AgentDefinition:
        # base tool behaviour stays, INTENT_BUILDER_PROMPT rides on top.
        system_prompt={"type": "preset", "preset": "claude_code",
                       "append": INTENT_BUILDER_PROMPT},
        allowed_tools=SUBAGENT_TOOLS,
        # allowed_tools does NOT block the built-in subagent dispatch: a live
        # page session spawned an Explore agent to read SKILL.md + types and
        # then read both files again itself (~20s + tokens, and a second
        # serialization path through the back door). Deny it by name — the
        # dispatch tool has been called both Task and Agent across CLI
        # versions.
        disallowed_tools=["Agent", "Task"],
        # Raw stream events for the progress plumbing (see _stream_delta_chars).
        include_partial_messages=True,
        # Same as the orchestrator session — the old subagents inherited this.
        thinking={"type": "disabled"},
        permission_mode="bypassPermissions",
        cwd=APP_ROOT,
        model=AGENT_MODEL,
    )
    if not staging:
        # Loads CLAUDE.md into the session. Correct in the sequential mode
        # (CLAUDE.md = orchestrator prompt), WRONG while Phase 1 runs
        # concurrently — CLAUDE.md is then the dashboard-builder prompt
        # ("Write DashboardOverview once", …) and would pollute every page
        # session. The skill is unaffected either way: INTENT_BUILDER_PROMPT
        # mandates an explicit Read of SKILL.md.
        option_kwargs["setting_sources"] = ["project"]
    options = _agent_options(**option_kwargs)

    texts: list[str] = []
    try:
        # The SDK terminates the CLI subprocess in a `finally` inside its
        # generator, so on timeout that generator must be closed, not abandoned.
        # CPython's refcounting does close it promptly here (verified: removing
        # aclosing does NOT fail the test below), so this is hardening, not a
        # fix for an observed leak — it stops the cleanup from depending on
        # refcount timing, which a traceback holding the frame alive, or a
        # non-refcounting runtime, would break.
        async with asyncio.timeout(_INTENT_FLOW_TIMEOUT_S), aclosing(
            sdk_query(prompt=prompt, options=options)
        ) as session:
            prog = {"chars": 0, "last": started}
            async for message in session:
                chars = _stream_delta_chars(message)
                if chars is not None:
                    _mark_event()
                    prog["chars"] += chars
                    now = time.time()
                    if prog["chars"] and now - prog["last"] >= _PROGRESS_EVERY_S:
                        prog["last"] = now
                        _emit({"type": "progress", "tool": "IntentPage",
                               "tool_use_id": f"intent:{tag}",
                               "chars": prog["chars"],
                               "t": round(now - _t0, 1),
                               "actor": "subagent", "parent_id": f"intent:{tag}"})
                    continue
                if not isinstance(message, AssistantMessage):
                    continue
                _mark_event()
                prog["chars"] = 0
                for block in message.content:
                    if isinstance(block, ToolUseBlock):
                        _emit({"type": "tool", "tool": block.name,
                               "tool_use_id": block.id,
                               "input": str(block.input)[:2000],
                               "t": round(time.time() - _t0, 1),
                               "model": AGENT_MODEL,
                               "actor": "subagent", "parent_id": f"intent:{tag}"})
                    elif isinstance(block, TextBlock):
                        texts.append(block.text)
    except TimeoutError:
        return {"file": file_path, "ok": False,
                "seconds": round(time.time() - started, 1),
                "error": f"timed out after {_INTENT_FLOW_TIMEOUT_S}s"}
    except Exception as e:
        return {"file": file_path, "ok": False,
                "seconds": round(time.time() - started, 1),
                "error": f"{type(e).__name__}: {e}"}

    if staging:
        # Self-heal instead of deny: a builder that "corrected" the unusual
        # target back to src/pages/intents/ (the path the skill talks about)
        # has still produced the right file — move it into quarantine rather
        # than failing the flow over the location.
        staged = os.path.join(_staging_dir(), basename)
        stray = os.path.join(APP_ROOT, "src", "pages", "intents", basename)
        if not os.path.exists(staged) and os.path.exists(stray):
            os.makedirs(_staging_dir(), exist_ok=True)
            os.replace(stray, staged)
            print(f"[KLAR] Staging heal: moved {stray} -> {staged}", flush=True)
        if not os.path.exists(staged):
            return {"file": file_path, "ok": False,
                    "seconds": round(time.time() - started, 1),
                    "error": "page session ended without writing the file"}

    seconds = round(time.time() - started, 1)
    _emit({"type": "tool_result", "tool": "IntentPage",
           "tool_use_id": f"intent:{tag}",
           "output": f"{file_path} done in {seconds}s",
           "t": round(time.time() - _t0, 1),
           "actor": "main", "parent_id": None})
    return {"file": file_path, "ok": True, "seconds": seconds,
            "summary": ("\n".join(texts))[-1500:]}


# The wiring metadata the integration step feeds to wire-intent.mjs. Slug and
# icon are validated here because the manifest is model-authored and its
# values end up in shell commands and in App.tsx — garbage must die at the
# tool boundary, not in the integration band.
_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]*$")
_ICON_RE = re.compile(r"^Icon[A-Za-z0-9]+$")


def _wiring_error(flow: dict) -> str | None:
    """None when the flow carries valid wiring metadata; else the reason."""
    slug = str(flow.get("slug", "")).strip()
    label = str(flow.get("label", "")).strip()
    icon = str(flow.get("icon", "")).strip()
    description = str(flow.get("description", "")).strip()
    if not (slug and label and icon and description):
        return "staging mode needs slug, label, icon and description per flow"
    if not _SLUG_RE.match(slug):
        return f"invalid slug {slug!r} (lowercase letters, digits, dashes)"
    if not _ICON_RE.match(icon):
        return f"invalid icon {icon!r} (Tabler component name like IconCalendarPlus)"
    return None


def _write_staging_manifest(entries: list[dict]) -> None:
    """Persist wiring data for the integration step. MERGED by file, not
    overwritten: a re-call of the tool for one FAILED flow must not erase the
    entries of the flows that already succeeded."""
    os.makedirs(_staging_dir(), exist_ok=True)
    path = os.path.join(_staging_dir(), "manifest.json")
    merged: dict[str, dict] = {}
    try:
        with open(path) as fh:
            for entry in json.load(fh).get("flows", []):
                merged[entry.get("file", "")] = entry
    except (OSError, ValueError):
        pass
    for entry in entries:
        merged[entry.get("file", "")] = entry
    merged.pop("", None)
    with open(path, "w") as fh:
        json.dump({"flows": list(merged.values())}, fh, indent=2)


@tool(
    "build_intent_pages",
    "Build EVERY intent flow page. Pass all flows in this ONE call — they run "
    "concurrently, so the wall-clock is the slowest page, not their sum. "
    "Each entry: {file: 'src/pages/intents/XPage.tsx', brief: '<the full brief>', "
    "slug: 'kebab-case-route', label: '{\"de\":\"Neue Buchung\",\"en\":\"New booking\"}', "
    "icon: 'IconCalendarPlus', description: 'one German line'}. "
    "There is no other way to create intent pages.",
    {
        "type": "object",
        "properties": {
            "flows": {
                # Live-proven repeatedly (the 408s Handwerk-Pro run, and twice
                # on the parallel-intents track): the orchestrator stringifies
                # the array despite any description telling it not to, and the
                # schema rejection costs ~30s per attempt — the 408s run spent
                # ~350s debugging around it. Accept the string and parse it in
                # the handler — tolerating beats re-prompting.
                "type": ["array", "string"],
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "file": {"type": "string",
                                 "description": "src/pages/intents/{PascalCase}Page.tsx"},
                        "brief": {"type": "string",
                                  "description": "The complete brief for this one page."},
                        "slug": {"type": "string",
                                 "description": "Route slug, kebab-case (e.g. neue-buchung)."},
                        # The label reaches wire-intent.mjs verbatim, and the
                        # sidebar switches languages at runtime — so it is a
                        # JSON OBJECT string with both UI languages, not one
                        # German phrase. A plain string still wires (it then
                        # renders unchanged in every language), which is the
                        # fallback, not the target.
                        "label": {"type": "string",
                                  "description": "Sidebar label as a JSON object with both UI "
                                                 "languages, 1-3 words each: "
                                                 "{\"de\":\"Neue Buchung\",\"en\":\"New booking\"}"},
                        "icon": {"type": "string",
                                 "description": "Tabler icon COMPONENT name (IconCalendarPlus)."},
                        "description": {"type": "string",
                                        "description": "One German line for the registry entry."},
                    },
                    "required": ["file", "brief"],
                },
            }
        },
        "required": ["flows"],
    },
)
async def _build_intent_pages(args: dict) -> dict:
    flows = args.get("flows") or []
    if isinstance(flows, str):
        # The schema admits a JSON-encoded string (see the schema comment).
        try:
            flows = json.loads(flows)
        except ValueError:
            flows = []
        if not isinstance(flows, list):
            flows = []
        flows = [f for f in flows if isinstance(f, dict)]
    if not isinstance(flows, list) or not flows:
        return {"content": [{"type": "text", "text": "No flows given — pass one entry per intent page."}],
                "is_error": True}

    staging = _staging_mode()

    # Fail wiring-metadata problems BEFORE spawning a session — a 100s page
    # build that cannot be wired afterwards is money spent on a dead file.
    invalid: list[dict] = []
    runnable: list[dict] = []
    if staging:
        for flow in flows:
            err = _wiring_error(flow)
            if err:
                invalid.append({"file": str(flow.get("file", "")), "ok": False,
                                "seconds": 0.0, "error": err, "flow": flow})
            else:
                runnable.append(flow)
    else:
        runnable = flows

    batch_started = time.time()
    print(f"[KLAR] Intent fan-out: {len(runnable)} page(s) in parallel", flush=True)

    results = await asyncio.gather(
        *(_build_one_intent_page(flow, i) for i, flow in enumerate(runnable))
    )

    total = round(time.time() - batch_started, 1)
    slowest = max((r["seconds"] for r in results), default=0.0)
    serial = round(sum(r["seconds"] for r in results), 1)
    print(f"[KLAR] Intent fan-out done: {total}s wall-clock "
          f"(slowest page {slowest}s, serial would have been {serial}s)", flush=True)

    all_results = list(results) + [
        {k: v for k, v in inv.items() if k != "flow"} for inv in invalid
    ]

    if staging:
        entries = []
        for flow, result in list(zip(runnable, results)) + [
            (inv["flow"], inv) for inv in invalid
        ]:
            basename = str(flow.get("file", "")).rsplit("/", 1)[-1]
            entries.append({
                "file": str(flow.get("file", "")),
                "component": basename[:-4] if basename.endswith(".tsx") else basename,
                "slug": str(flow.get("slug", "")).strip(),
                "label": str(flow.get("label", "")).strip(),
                "icon": str(flow.get("icon", "")).strip(),
                "description": str(flow.get("description", "")).strip(),
                "ok": bool(result.get("ok")),
                "error": result.get("error"),
            })
        _write_staging_manifest(entries)

    lines = [f"{len(runnable)} intent page(s) built in {total}s (parallel).", ""]
    for r in all_results:
        if r["ok"]:
            lines.append(f"OK  {r['file']}  ({r['seconds']}s)")
        else:
            lines.append(f"FAILED  {r['file']}  ({r['seconds']}s): {r['error']}")
    if any(not r["ok"] for r in all_results):
        lines += ["", "A failed page does NOT exist on disk. Do not wire it — either call this",
                  "tool again with just that flow, or drop it and wire only the pages that built."]
    if staging:
        lines += ["", "Your job is DONE — the integration step after the dashboard phase",
                  "moves, wires and builds these pages. Do NOT wire or build anything. STOP now."]
    else:
        lines += ["", "Next: wire each page that built with scripts/wire-intent.mjs, then `node scripts/heal-tsc.mjs && node scripts/i18n-tx.mjs wrap && npm run build` (heal-tsc mechanically fixes the missing-.fields.-prefix, raw-vs-Enriched and ??-null-in-payload classes; fix only what it prints below its JSON report)."]
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


# ── Component fan-out (Phase 1 / dashboard mode) ─────────────────────
#
# Same lesson as the intent fan-out, applied to Phase 1's own bottleneck: the
# main agent designs large custom UI blocks (a heatmap, a custom timeline) and
# then generates them token by token INSIDE the DashboardOverview Write — the
# single dominant item on the critical path (~120s of a 220s build measured).
# The design stays the agent's; only the generation moves into parallel
# sessions. The agent dictates the props interface verbatim in the brief and
# composes the page against its own dictation while the lanes build — tsc
# proves the seam afterwards.
#
# Unlike build_intent_pages this must NOT block: the caller has work left (the
# Overview). So it is a two-tool design — build_components starts the lanes
# fire-and-forget, await_components joins them before gates/build. Two hooks
# make the ordering mechanical instead of prose: builds/gates are denied while
# lanes run un-joined, and the target directory is untouchable until the join.
#
# Gated by COMPONENT_FANOUT=1 (set by the backend from ENABLE_COMPONENT_FANOUT)
# so the flag-off state is byte-identical behavior.

_COMPONENT_TIMEOUT_S = 300
COMPONENT_DIRNAME = "src/components/custom"
COMPONENT_MANIFEST = ".components-manifest.json"
_COMPONENT_FILE_RE = re.compile(r"^src/components/custom/[A-Z][A-Za-z0-9]*\.tsx$")
_PROPS_INTERFACE_RE = re.compile(r"export\s+interface\s+([A-Za-z0-9_]+)Props\b")
# Cap: more lanes than this means the composition is being outsourced instead
# of designed — keep the biggest blocks, inline the rest.
_MAX_COMPONENT_BRIEFS = 3

# Shared by the two tool handlers (one build = one process). `task` is the
# asyncio.gather of all lanes; `joined` flips when await_components returns.
_component_state: dict = {"task": None, "entries": [], "joined": False}


COMPONENT_BUILDER_PROMPT = (
    "You build ONE presentational React component for a generated dashboard.\n"
    "\n"
    f"LANGUAGE & TONE: UI text in {UI_LANGUAGE_NAME}.{_TONE_RULE}\n"
    "UI TEXT (multilingual): every UI string you write (labels, headings, empty states, "
    "tooltips, aria-labels) is written ONCE in the build language and MARKED with tx from "
    "'@/i18n': {tx('Auslastung')}, title={tx('Überfällig')}, and the tagged form "
    "tx`${n} Sätze` for interpolation. NEVER write translations or makeT tables yourself. "
    "tx at module scope freezes one language — call it inside the component body.\n"
    """
## THE CONTRACT

The brief contains a props interface as literal TypeScript. The page that
composes this component is being written against that interface RIGHT NOW, in
parallel — reproduce it EXACTLY: same name, same members, same types, exported.
Any deviation is a guaranteed type error that costs a repair round.

MANDATORY RULES:
- Export `interface {Name}Props` exactly as briefed AND `function {Name}(...)` as a
  NAMED export (no default export). The page imports
  `import { {Name} } from '@/components/custom/{Name}'`.
- PROPS-ONLY: all data arrives via props, all interaction leaves via callback props.
  FORBIDDEN imports (a gate rejects them): '@/services/livingAppsService',
  '@/hooks/useDashboardData', '@/lib/enrich', '@/lib/publicClient', '@/lib/actions-agent'.
- Allowed imports: types from '@/types/app' and '@/types/enriched', helpers from
  '@/lib/formatters', tx from '@/i18n', icons from '@tabler/icons-react', date-fns,
  ui/ primitives, react.
- NO toISOString() ANYWHERE in the file — the check-components gate is file-wide and
  context-free. Day keys: date-fns format(d, 'yyyy-MM-dd'). Timestamps:
  format(d, "yyyy-MM-dd'T'HH:mm").
- The file MUST START with a /** … */ docblock (above the imports): purpose in one
  line, then one line per prop. Follow-up sessions read this block.
- Create the file with the Write tool — one shot, no read-back. NEVER use Bash for
  file operations. Do NOT run npm/tsc/gates. Do NOT touch any other file.
- Rules of Hooks: ALL hooks BEFORE any early return.
- IMPORT HYGIENE: only import what you use — strict mode errors on unused imports.
- TOUCH-FRIENDLY: never hide interactive elements behind hover.
- Match the pre-built widgets visually: existing design tokens only (bg-card,
  border-border, text-muted-foreground, rounded-2xl, the primary scale) — no
  hand-picked hex colors, no color-mix().
"""
)


def _component_error(entry: dict) -> str | None:
    """None when the entry can be built; else the reason. Validated at the tool
    boundary — a lane spawned on a brief without a literal props interface
    produces a file the page cannot compose, i.e. money spent on a type error."""
    file_path = str(entry.get("file", "")).strip()
    brief = str(entry.get("brief", "")).strip()
    if not file_path or not brief:
        return "component entry needs both 'file' and 'brief'"
    if not _COMPONENT_FILE_RE.match(file_path):
        return (f"invalid file {file_path!r} — must be "
                "src/components/custom/{PascalCase}.tsx")
    match = _PROPS_INTERFACE_RE.search(brief)
    if not match:
        return ("brief carries no literal props interface — include the exact "
                "TypeScript `export interface {Name}Props { … }` the page "
                "composes against")
    component = file_path.rsplit("/", 1)[-1][:-4]
    if match.group(1) != component:
        return (f"props interface '{match.group(1)}Props' does not match the "
                f"component name '{component}' from the file path")
    return None


async def _build_one_component(entry: dict, index: int) -> dict:
    """Run ONE component-lane session to completion. Never raises — a failure
    is reported back as data so the other lanes still land."""
    file_path = str(entry.get("file", "")).strip()
    brief = str(entry.get("brief", "")).strip()
    tag = file_path.rsplit("/", 1)[-1] or f"component{index}"
    started = time.time()

    prompt = f"Build the file `{file_path}`.\n\n{brief}"

    _emit({"type": "tool", "tool": "CustomComponent",
           "tool_use_id": f"component:{tag}",
           "input": f"build {file_path}", "t": round(started - _t0, 1),
           "model": AGENT_MODEL, "actor": "main", "parent_id": None})

    options = _agent_options(
        system_prompt={"type": "preset", "preset": "claude_code",
                       "append": COMPONENT_BUILDER_PROMPT},
        allowed_tools=SUBAGENT_TOOLS,
        disallowed_tools=["Agent", "Task"],
        include_partial_messages=True,
        thinking={"type": "disabled"},
        permission_mode="bypassPermissions",
        cwd=APP_ROOT,
        model=AGENT_MODEL,
        # NO setting_sources: CLAUDE.md is the dashboard-builder prompt of the
        # very session that dispatched this lane — loading it would give the
        # lane the wrong job ("Write DashboardOverview once").
    )

    try:
        async with asyncio.timeout(_COMPONENT_TIMEOUT_S), aclosing(
            sdk_query(prompt=prompt, options=options)
        ) as session:
            prog = {"chars": 0, "last": started}
            async for message in session:
                chars = _stream_delta_chars(message)
                if chars is not None:
                    _mark_event()
                    prog["chars"] += chars
                    now = time.time()
                    if prog["chars"] and now - prog["last"] >= _PROGRESS_EVERY_S:
                        prog["last"] = now
                        _emit({"type": "progress", "tool": "CustomComponent",
                               "tool_use_id": f"component:{tag}",
                               "chars": prog["chars"],
                               "t": round(now - _t0, 1),
                               "actor": "subagent",
                               "parent_id": f"component:{tag}"})
                    continue
                if not isinstance(message, AssistantMessage):
                    continue
                _mark_event()
                prog["chars"] = 0
                for block in message.content:
                    if isinstance(block, ToolUseBlock):
                        _emit({"type": "tool", "tool": block.name,
                               "tool_use_id": block.id,
                               "input": str(block.input)[:2000],
                               "t": round(time.time() - _t0, 1),
                               "model": AGENT_MODEL,
                               "actor": "subagent",
                               "parent_id": f"component:{tag}"})
    except TimeoutError:
        return {"file": file_path, "ok": False,
                "seconds": round(time.time() - started, 1),
                "error": f"timed out after {_COMPONENT_TIMEOUT_S}s"}
    except Exception as e:
        return {"file": file_path, "ok": False,
                "seconds": round(time.time() - started, 1),
                "error": f"{type(e).__name__}: {e}"}

    if not os.path.exists(os.path.join(APP_ROOT, file_path)):
        return {"file": file_path, "ok": False,
                "seconds": round(time.time() - started, 1),
                "error": "component session ended without writing the file"}

    seconds = round(time.time() - started, 1)
    _emit({"type": "tool_result", "tool": "CustomComponent",
           "tool_use_id": f"component:{tag}",
           "output": f"{file_path} done in {seconds}s",
           "t": round(time.time() - _t0, 1),
           "actor": "main", "parent_id": None})
    return {"file": file_path, "ok": True, "seconds": seconds}


def _write_component_manifest(entries: list[dict]) -> None:
    """Persist per-component results for the gate (interface check) and the
    log. MERGED by file, not overwritten — a re-call for one failed component
    must not erase the entries of the components that already succeeded."""
    path = os.path.join(APP_ROOT, COMPONENT_MANIFEST)
    merged: dict[str, dict] = {}
    try:
        with open(path) as fh:
            for entry in json.load(fh).get("components", []):
                merged[entry.get("file", "")] = entry
    except (OSError, ValueError):
        pass
    for entry in entries:
        merged[entry.get("file", "")] = entry
    merged.pop("", None)
    with open(path, "w") as fh:
        json.dump({"components": list(merged.values())}, fh, indent=2)


@tool(
    "build_components",
    "Start building EVERY custom dashboard component you designed — in the "
    "BACKGROUND, concurrently. Call ONCE with all components, then immediately "
    "Read+Write DashboardOverview.tsx, composing each component against the props "
    "interface you dictated in its brief. Call await_components BEFORE any gate or "
    "npm run build. Each entry: {file: 'src/components/custom/{PascalCase}.tsx', "
    "brief: '<goal + the literal `export interface {Name}Props` + behavior + "
    "allowed module paths>'}.",
    {
        "type": "object",
        "properties": {
            "components": {
                # Same tolerance as build_intent_pages: orchestrating models
                # stringify the array despite the description, and a schema
                # rejection costs ~30s per attempt.
                "type": ["array", "string"],
                "minItems": 1,
                "items": {
                    "type": "object",
                    "properties": {
                        "file": {"type": "string",
                                 "description": "src/components/custom/{PascalCase}.tsx"},
                        "brief": {"type": "string",
                                  "description": "Goal (one sentence), the literal exported "
                                                 "props interface, behavior/states, allowed "
                                                 "module paths."},
                    },
                    "required": ["file", "brief"],
                },
            }
        },
        "required": ["components"],
    },
)
async def _build_components(args: dict) -> dict:
    entries = args.get("components") or []
    if isinstance(entries, str):
        try:
            entries = json.loads(entries)
        except ValueError:
            entries = []
        if not isinstance(entries, list):
            entries = []
        entries = [e for e in entries if isinstance(e, dict)]
    if not isinstance(entries, list) or not entries:
        return {"content": [{"type": "text",
                             "text": "No components given — pass one entry per component."}],
                "is_error": True}

    task = _component_state["task"]
    if task is not None and not task.done():
        return {"content": [{"type": "text",
                             "text": "Component builds are already running — call "
                                     "await_components first, then re-call this tool "
                                     "for anything that failed."}],
                "is_error": True}

    if len(entries) > _MAX_COMPONENT_BRIEFS:
        return {"content": [{"type": "text",
                             "text": f"Too many components ({len(entries)} > "
                                     f"{_MAX_COMPONENT_BRIEFS}). Fan out only the "
                                     "LARGEST self-contained blocks; inline the rest."}],
                "is_error": True}

    # All-or-nothing on validation: the page composes EVERY component, so one
    # invalid brief means the composition cannot be finished anyway — fixing
    # the brief and re-calling is cheaper than a half-spawned batch.
    problems = []
    for entry in entries:
        err = _component_error(entry)
        if err:
            problems.append(f"{entry.get('file', '?')}: {err}")
    if problems:
        return {"content": [{"type": "text",
                             "text": "Nothing started — fix these briefs and call again:\n"
                                     + "\n".join(problems)}],
                "is_error": True}

    print(f"[KLAR] Component fan-out: {len(entries)} component(s) in background", flush=True)
    # gather() returns an already-scheduled future — the lanes start running on
    # the current loop NOW, while this handler returns to the model.
    # (asyncio.create_task would be a TypeError here: it wants a coroutine.)
    _component_state["task"] = asyncio.gather(
        *(_build_one_component(entry, i) for i, entry in enumerate(entries))
    )
    _component_state["entries"] = entries
    _component_state["joined"] = False

    files = ", ".join(str(e.get("file", "")) for e in entries)
    return {"content": [{"type": "text", "text": (
        f"{len(entries)} component(s) building in the background: {files}\n\n"
        "Continue NOW — do not wait:\n"
        "1. Read then Write src/pages/DashboardOverview.tsx, importing each component "
        "as `import { Name } from '@/components/custom/Name'` and composing it EXACTLY "
        "against the props interface from your brief.\n"
        "2. Call await_components BEFORE any gate or npm run build (a hook denies them "
        "until you do). Do NOT Read or Edit src/components/custom/ before the join."
    )}]}


@tool(
    "await_components",
    "Join the background component builds started by build_components. Call after "
    "writing DashboardOverview.tsx and BEFORE any gate or npm run build. Reports "
    "ok/error per component; failed components can be repaired with Edit or "
    "re-briefed via build_components.",
    {"type": "object", "properties": {}},
)
async def _await_components(args: dict) -> dict:
    task = _component_state["task"]
    if task is None:
        _component_state["joined"] = True
        return {"content": [{"type": "text",
                             "text": "No component builds pending — nothing to await."}]}

    try:
        # Belt and suspenders: every lane already carries its own timeout, so
        # the gather resolves in bounded time; this outer limit only guards
        # against a lane whose own timeout machinery failed.
        async with asyncio.timeout(_COMPONENT_TIMEOUT_S + 60):
            results = await task
    except TimeoutError:
        task.cancel()
        results = [{"file": str(e.get("file", "")), "ok": False, "seconds": 0.0,
                    "error": "join timed out — lane cancelled"}
                   for e in _component_state["entries"]]
    except Exception as e:
        results = [{"file": str(entry.get("file", "")), "ok": False, "seconds": 0.0,
                    "error": f"{type(e).__name__}: {e}"}
                   for entry in _component_state["entries"]]

    _component_state["task"] = None
    _component_state["joined"] = True

    manifest_entries = []
    for entry, result in zip(_component_state["entries"], results):
        file_path = str(entry.get("file", ""))
        basename = file_path.rsplit("/", 1)[-1]
        manifest_entries.append({
            "file": file_path,
            "component": basename[:-4] if basename.endswith(".tsx") else basename,
            "ok": bool(result.get("ok")),
            "error": result.get("error"),
        })
    _write_component_manifest(manifest_entries)

    lines = [f"{len(results)} component build(s) joined."]
    for r in results:
        if r.get("ok"):
            lines.append(f"OK  {r['file']}  ({r['seconds']}s)")
        else:
            lines.append(f"FAILED  {r['file']}  ({r['seconds']}s): {r['error']}")
    if any(not r.get("ok") for r in results):
        lines += ["", "A failed component may be missing or broken on disk while the page "
                      "already imports it. Repair it with Edit, or re-call build_components "
                      "with just that entry, then await_components again — BEFORE the build."]
    else:
        lines += ["", "All components landed. Continue with the gates and the build."]
    return {"content": [{"type": "text", "text": "\n".join(lines)}]}


# Commands that read the whole tree — meaningless (and misleading) while
# component lanes are still writing into it. Prose said "join first"; this is
# the mechanical version, same lesson as the intent fan-out hooks.
_COMPONENT_BUILD_GATE_RE = re.compile(
    r"npm\s+run\s+build|\btsc\b|vite\s+build|check-[\w-]+\.mjs|heal-tsc\.mjs|i18n-tx\.mjs"
)


async def _deny_build_before_component_join(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Deny gates/build while component lanes run un-joined."""
    task = _component_state["task"]
    if task is None or _component_state["joined"]:
        return {}
    if input_data.get("tool_name") != "Bash":
        return {}
    command = str((input_data.get("tool_input") or {}).get("command", ""))
    if not _COMPONENT_BUILD_GATE_RE.search(command):
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "Component builds are still running in the background — the tree is "
                "incomplete. Call mcp__klar__await_components first (it joins them and "
                "reports ok/error per file), then run gates and build."
            ),
        }
    }


async def _deny_component_dir_before_join(input_data: dict, tool_use_id: str | None = None, context: dict | None = None) -> dict:
    """Deny touching src/components/custom/ while lanes write into it. After
    the join the directory belongs to the main agent (repair path)."""
    task = _component_state["task"]
    if task is None or _component_state["joined"]:
        return {}
    if input_data.get("tool_name") not in ("Read", "Write", "Edit", "MultiEdit"):
        return {}
    target = str((input_data.get("tool_input") or {}).get("file_path", ""))
    if "src/components/custom/" not in target:
        return {}
    return {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": "deny",
            "permissionDecisionReason": (
                "The component lanes are still writing this directory. Compose against "
                "the props interface from YOUR brief — you dictated it, no read needed. "
                "After await_components the directory is yours (repair path)."
            ),
        }
    }


# ── System prompt variants ──────────────────────────────────────────

# Phase 1 (dashboard): identical to actions branch — full detailed rules
SYSTEM_APPEND_DASHBOARD = (
    "MANDATORY RULES (highest priority):\n"
    "- No design_brief.md — analyze data in 1-2 sentences, then implement directly\n"
    "- DashboardOverview.tsx: Call Read('src/pages/DashboardOverview.tsx') FIRST, then Write ONCE with complete content. Never read back after writing. Keep the DashboardSkeleton/DashboardError import (@/components/DashboardStates) and the two early-returns — never re-implement them.\n"
    "- NEVER use Bash for file operations (no cat, echo, heredoc, >, >>). ALWAYS use Read/Write/Edit tools. If a tool fails, retry with the SAME tool — never fall back to Bash.\n"
    "- index.css: NEVER touch — pre-generated design system (font, colors, sidebar). Use existing tokens.\n"
    "- Layout.tsx: APP_TITLE is pre-set to the appgroup name. Do NOT edit unless you need a different title.\n"
    "- CRUD pages/dialogs: NEVER touch — complete with all logic\n"
    "- App.tsx, PageShell.tsx, StatCard.tsx, ConfirmDialog.tsx: NEVER touch\n"
    "- No Read-back after Write/Edit. A gate/tsc error is the exception: repair the flagged LINES with Edit (they are quoted for you) — never re-Write the whole file\n"
    "- No Read of files whose contents are in .scaffold_context or the .scaffold_files_p* parts\n"
    "- Read .scaffold_context FIRST, then each .scaffold_files_p* part it lists (one Read each) to understand all generated files\n"
    "- useDashboardData.ts, enriched.ts, enrich.ts, formatters.ts, ai.ts, ChatWidget.tsx: NEVER touch — use as-is\n"
    "- src/config/ai-features.ts: MAY edit — set AI_PHOTO_SCAN['Entity'] = true to enable photo scan in dialogs\n"
    "- Rules of Hooks: ALL hooks (useState, useEffect, useMemo, useCallback) MUST be BEFORE any early returns (loading/error). Never place a hook after 'if (loading) return' or 'if (error) return'.\n"
    "- IMPORT HYGIENE: Only import what you actually use. TypeScript strict mode errors on unused imports. BEFORE calling Write, mentally trace every import — if it doesn't appear in the JSX/logic body, remove it.\n"
    "- Dashboard is the PRIMARY WORKSPACE — build interactive domain-specific UI, not an info page\n"
    "- ALWAYS reuse pre-generated {Entity}Dialog from '@/components/dialogs/{Entity}Dialog' for create/edit forms in the dashboard — never build custom forms\n"
    "- TOUCH-FRIENDLY: NEVER hide action buttons/icons behind hover (no opacity-0 group-hover:opacity-100). All interactive elements must be visible without hovering.\n"
    "- After 'npm run build' succeeds, STOP immediately. Do not write summaries."
)

# Phase 2 (intents) / "all" mode: lighter orchestrator rules
SYSTEM_APPEND_ORCHESTRATOR = (
    "MANDATORY RULES (highest priority):\n"
    "- NEVER use Bash for file operations (no cat, echo, heredoc, >, >>). ALWAYS use Read/Write/Edit tools.\n"
    "- index.css: NEVER touch — pre-generated design system. CRUD pages/dialogs: NEVER touch.\n"
    "- Layout.tsx: NEVER touch — sidebar navigation is pre-generated.\n"
    "- useDashboardData.ts, enriched.ts, enrich.ts, formatters.ts, ai.ts, ChatWidget.tsx: NEVER touch\n"
    "- Rules of Hooks: ALL hooks MUST be BEFORE any early returns.\n"
    "- IMPORT HYGIENE: Only import what you actually use.\n"
    "- After 'npm run build' succeeds, STOP immediately."
)


async def main():
    # Build phase support for two-phase builds
    build_phase = os.getenv('BUILD_PHASE', 'all')  # "dashboard", "intents", or "all"

    # Subagent definitions. form_polish is registered in every phase (also
    # "dashboard") so the main-agent can dispatch it via subagent_type="form_polish"
    # without having to read a prompt file from disk. intent_builder is only
    # needed when the build includes the intents phase.
    agents = {
        "form_polish": AgentDefinition(
            description="Polishes generated CRUD forms: fills placeholder=\"\" with helpful hints, writes per-entity formEnhancements configs (fieldOrder, defaults, computed formulas), and produces .form-polish-report.json. Runs from .placeholder-tasks.json as task list.",
            prompt=FORM_POLISH_PROMPT,
            tools=SUBAGENT_TOOLS,
            model="haiku",
        ),
    }
    # NOTE: there is deliberately no `intent_builder` AgentDefinition. Intent
    # pages are built by the build_intent_pages tool below, which fans out with
    # asyncio.gather — see the comment there for why a rule was not enough.
    mcp_servers = {}
    klar_tools = []
    if build_phase in ("intents", "intents-pages", "all"):
        klar_tools.append(_build_intent_pages)
    if build_phase == "dashboard" and os.getenv("COMPONENT_FANOUT") == "1":
        # Component fan-out is Phase-1-only and flag-gated (ENABLE_COMPONENT_FANOUT
        # in the backend → COMPONENT_FANOUT env here). Without the flag Phase 1
        # keeps having NO MCP server — byte-identical behavior.
        klar_tools.extend([_build_components, _await_components])
    if klar_tools:
        mcp_servers["klar"] = create_sdk_mcp_server(
            name="klar", version="1.0.0", tools=klar_tools
        )

    # Select system prompt based on build phase
    if build_phase == "dashboard":
        system_append = SYSTEM_APPEND_DASHBOARD
    else:
        system_append = SYSTEM_APPEND_ORCHESTRATOR
    if build_phase == "intents-pages":
        # The detailed orchestrator rules normally travel as CLAUDE.md
        # (SANDBOX_PROMPT_INTENTS.md → CLAUDE.md). While Phase 1 runs
        # concurrently, CLAUDE.md is the DASHBOARD prompt and must stay
        # untouched — so the rules ride in the system append instead, from a
        # neutral file the backend writes during setup.
        try:
            with open(os.path.join(APP_ROOT, ".intents-orchestrator.md"), encoding="utf-8") as fh:
                system_append = system_append + "\n\n" + fh.read()
        except OSError:
            print("[KLAR] WARN: .intents-orchestrator.md fehlt — Orchestrator läuft ohne Detailregeln")

    option_kwargs = dict(
        hooks={
            "PreToolUse": [
                HookMatcher(matcher="Read", hooks=[_block_subagent_files_for_main_agent], timeout=10),
                HookMatcher(matcher=None, hooks=[_deny_serial_intent_dispatch], timeout=10),
                HookMatcher(matcher="Bash", hooks=[_deny_tree_commands_in_pages_mode], timeout=10),
                HookMatcher(matcher=None, hooks=[_deny_intent_surface_in_dashboard_mode], timeout=10),
                # No-ops unless a component fan-out task is pending (dashboard
                # mode with COMPONENT_FANOUT=1 only).
                HookMatcher(matcher="Bash", hooks=[_deny_build_before_component_join], timeout=10),
                HookMatcher(matcher=None, hooks=[_deny_component_dir_before_join], timeout=10),
            ],
            "PostToolUse": [HookMatcher(matcher=None, hooks=[_on_post_tool_use], timeout=60)],
        },
        system_prompt={
            "type": "preset",
            "preset": "claude_code",
            "append": system_append,
        },
        thinking={"type": "disabled"},
        permission_mode="bypassPermissions",
        disallowed_tools=["TodoWrite", "NotebookEdit", "WebFetch", "ExitPlanMode", "SlashCommand"],
        cwd="/home/user/app",
        model=AGENT_MODEL,
    )
    if build_phase != "intents-pages":
        # Auto-loads CLAUDE.md. In intents-pages mode CLAUDE.md is the
        # dashboard-builder prompt of the concurrently running Phase 1 —
        # loading it would give the orchestrator the wrong job description.
        option_kwargs["setting_sources"] = ["project"]
    options = ClaudeAgentOptions(**option_kwargs)

    options.agents = agents
    # Raw stream events for the progress plumbing (see _stream_delta_chars).
    # Guarded like _agent_options: an image with an older SDK just runs
    # without streaming (and the watchdog says so in its [WAIT] text).
    if any(f.name == "include_partial_messages"
           for f in dataclasses.fields(ClaudeAgentOptions)):
        options.include_partial_messages = True
    if mcp_servers:
        options.mcp_servers = mcp_servers

    # Session-Resume Unterstützung
    # BUG: agents + resume crashes the Claude CLI (tested SDK 0.1.50 + 0.1.58).
    # When `form_polish` runs as a formal AgentDefinition in Phase 1, the JSONL
    # contains `subagent_type="form_polish"` tool-use blocks. On resume the CLI
    # replays those blocks and tries to resolve the agent — if we drop `agents`,
    # the type lookup fails inside __aenter__ and the SDK crashes before any of
    # our code runs.
    #
    # The reverse trade-off works: keep agents registered, drop the resume.
    # Phase 2 then starts as a fresh session (no Phase-1 conversation history),
    # but the agent registry stays consistent and `intent_builder` can still run.
    resume_session_id = os.getenv('RESUME_SESSION_ID')
    if agents and resume_session_id:
        print(f"[KLAR] Skipping resume (agents + resume = SDK crash)")
        resume_session_id = None
    if resume_session_id:
        options.resume = resume_session_id
        print(f"[KLAR] Resuming session: {resume_session_id}")

    # User Prompt - prefer file over env var (handles special chars better)
    user_prompt = None

    prompt_file = "/home/user/app/.user_prompt"
    if os.path.exists(prompt_file):
        try:
            # encoding pinned: the container locale is not UTF-8, and the
            # default decode turned "Aufträge" into "AuftrÃ¤ge" — mojibake
            # that travels into flow labels and UI texts.
            with open(prompt_file, 'r', encoding='utf-8') as f:
                user_prompt = f.read().strip()
            if user_prompt:
                print(f"[KLAR] Prompt aus Datei gelesen: {len(user_prompt)} Zeichen")
        except Exception as e:
            print(f"[KLAR] Fehler beim Lesen der Prompt-Datei: {e}")

    if not user_prompt:
        user_prompt = os.getenv('USER_PROMPT')
        if user_prompt:
            print(f"[KLAR] Prompt aus ENV gelesen")

    # Build instructions — optional user notes for fresh builds (NOT continue mode)
    user_instructions = None
    instructions_file = "/home/user/app/.user_instructions"
    if os.path.exists(instructions_file):
        try:
            with open(instructions_file, 'r', encoding='utf-8') as f:
                user_instructions = f.read().strip()
            if user_instructions:
                print(f"[KLAR] User instructions aus Datei gelesen: {len(user_instructions)} Zeichen")
        except Exception as e:
            print(f"[KLAR] Fehler beim Lesen der User-Instructions-Datei: {e}")

    if not user_instructions:
        user_instructions = os.getenv('USER_INSTRUCTIONS')
        if user_instructions:
            print(f"[KLAR] User instructions aus ENV gelesen")

    if user_prompt:
        # Continue/Resume-Mode: Custom prompt vom User (no subagents, direct editing)
        query = f"""🚨 AUFGABE: Du MUSST das existierende Dashboard ändern!

User-Anfrage: "{user_prompt}"

PFLICHT-SCHRITTE (alle müssen ausgeführt werden):

1. LESEN: Lies src/pages/DashboardOverview.tsx um die aktuelle Struktur zu verstehen
2. ÄNDERN: Implementiere die User-Anfrage mit dem Edit-Tool
3. TESTEN: Führe 'npm run build' aus um sicherzustellen dass es kompiliert
4. BAUEN: Führe 'npm run build' aus. Bei Fehler: fixen und erneut bauen bis es klappt.

⚠️ KRITISCH:
- Du MUSST Änderungen am Code machen (Edit-Tool verwenden!)
- Analysieren alleine reicht NICHT - du musst HANDELN!
- Deployment passiert automatisch nach deiner Arbeit — deploye NICHT manuell!

Das Dashboard existiert bereits. Mache NUR die angeforderten Änderungen, nicht mehr.
Starte JETZT mit Schritt 1!"""
        print(f"[KLAR] Continue-Mode mit User-Prompt: {user_prompt}")

    elif build_phase == "dashboard":
        # Phase 1: Identical to actions branch — direct agent, no orchestrator overhead
        query = (
            "Read .scaffold_context (plus the .scaffold_files_p* parts it lists, one Read each) and app_metadata.json. "
            "Analyze data, decide UI paradigm in 1-2 sentences, then implement directly. "
            "Follow .claude/skills/frontend-impl/SKILL.md. "
            "Use existing types and services from src/types/ and src/services/. "
            "Only import what you actually use — TypeScript strict mode errors on unused imports. "
            "Run 'npm run build' when done. Deployment is automatic."
        )

        if os.getenv("COMPONENT_FANOUT") == "1":
            query += (
                "\n\nCOMPONENT FAN-OUT: if your composition includes a LARGE custom UI block "
                "(a self-contained concept of ~60+ lines — a heatmap, a custom timeline, a "
                "special visualization no widget covers), do NOT inline it. Dictate its props "
                "interface and dispatch it via the build_components tool (ONE call, every "
                "component), then write DashboardOverview.tsx immediately while they build, "
                "and call await_components before any gate or npm run build. Brief format and "
                "rules: CLAUDE.md Step 1b. Small blocks stay inline as before."
            )

        if user_instructions:
            query += (
                f"\n\nADDITIONAL user instructions (treat as MINIMUM requirements, not as limits):\n"
                f"<user-instructions>\n{user_instructions}\n</user-instructions>\n"
                f"The user wrote these for the WHOLE build — other build tracks run alongside you. "
                f"Wishes that are guided multi-step FLOWS (Abläufe/wizards), automations/tools (Werkzeuge) "
                f"or public pages are THEIRS: do not build intent pages, do not touch src/config/intents.ts "
                f"or the App.tsx custom markers — a hook denies it. Take only the dashboard-related wishes. "
                f"You MUST still build the full dashboard with all features you think are useful for the users — "
                f"analyze the data, decide the best UI paradigm, and implement everything you normally would. "
                f"The user instructions above are ADDITIONS on top of your normal work, not replacements. "
                f"Implement both: everything you would build anyway PLUS what the user asked for."
            )
            print(f"[KLAR] Phase 1: Dashboard build MIT User Instructions: {user_instructions}")
        else:
            print(f"[KLAR] Phase 1: Dashboard build (direct, no subagent)")

    elif build_phase == "intents-pages":
        # Parallel track: pages into staging while Phase 1 builds the
        # dashboard in the same tree. NO wiring, NO gates, NO build — the
        # integration step after the dashboard phase does that (a hook denies
        # those commands, this is informational).
        query = """\
You are the FLOW-PAGES BUILDER (runs PARALLEL to the dashboard phase). \
Read .entity_summary (short, ~30 lines) for entity info. Do NOT read .scaffold_context or app_metadata.json. \
Do NOT touch any file under src/ — the dashboard builder owns the tree right now.

Your ONLY deliverable: decide which intent flows this app needs (same rules as ever — \
distinct multi-entity workflow phases, no redundant intents, the decision gate below), then call \
`build_intent_pages` ONCE with every flow. Each entry carries file, brief AND the wiring metadata \
(slug, label, icon, description) — the integration step wires from exactly these values, you never \
run wire-intent.mjs, the gates or npm build yourself. When the tool returns, report one line per \
flow and STOP.

If the decision gate says SKIP (workflows fit in the dashboard): do NOTHING and STOP — \
the integration step clears the sidebar ghost rows itself.

The full orchestrator rules (what makes a good flow, brief format, decision gate) are in your \
system prompt below the mandatory rules — follow them for analysis and briefs, but IGNORE their \
wiring/build steps: those belong to the integration step.
"""
        if user_instructions:
            query += (
                f"\nADDITIONAL user instructions — the user wrote these for the WHOLE build. "
                f"Take what is yours (guided multi-step FLOWS); dashboard layout, tools/automations "
                f"and public pages belong to other builders — ignore those parts:\n"
                f"<user-instructions>\n{user_instructions}\n</user-instructions>"
            )
            print(f"[KLAR] Phase 2A: Flow-Seiten (parallel) MIT User Instructions")
        else:
            print(f"[KLAR] Phase 2A: Flow-Seiten (parallel)")

    elif build_phase == "intents":
        # Phase 2: Only intent builders — dashboard already deployed
        query = """\
You are the BUILD ORCHESTRATOR (Phase 2 — Intent UIs only). \
Read .entity_summary (short, ~30 lines) for entity info. Do NOT read .scaffold_context or app_metadata.json.

## WHAT ARE INTENT UIs?

Every entity ALREADY has a full CRUD page (table + search + create/edit/delete). Intent UIs are NOT more CRUD pages \
with different styling. They are TASK WORKFLOWS.

An intent UI is a MULTI-STEP WIZARD that:
- Spans MULTIPLE entities in one flow (selecting from entity A → creating linked records in entity B and C)
- Has STEPS (wizard/stepper pattern with clear step progression)
- Often creates MULTIPLE records in a single flow (e.g., inviting 20 guests = 20 invitation records)
- Shows LIVE FEEDBACK as the user progresses (running totals, counts, progress bar, budget remaining)
- Has a clear START → END (user begins task → user completes task with a result)
- Supports deep-linking to specific steps via URL params (e.g., ?eventId=xxx&step=2)

## CRITICAL: NO REDUNDANT INTENTS

Each intent MUST be a UNIQUE workflow that does NOT overlap with other intents. \
If one wizard has steps A→B→C, do NOT create separate intent pages for step B and step C — \
instead, make the wizard support deep-linking to specific steps via URL query params.

EXAMPLE — WRONG (redundant):
- "Prepare Event" wizard: pick event → invite guests → book vendors → summary
- "Manage RSVPs" page: pick event → update guest statuses  ← THIS IS JUST STEP 2 OF THE WIZARD!
- "Book Vendors" page: pick event → browse vendors → book them  ← THIS IS JUST STEP 3 OF THE WIZARD!

EXAMPLE — CORRECT (each intent is unique):
- "Prepare Event" wizard: pick event → invite guests → book vendors → summary
  - Dashboard links to specific steps: ?eventId=xxx&step=2 for guest management
- "Close Event" wizard: pick event → review payment statuses → finalize RSVPs → set event to completed → generate report
  - This is a DIFFERENT lifecycle phase, not a subset of "Prepare"

RULE: Before finalizing your intent list, check each pair — if intent B is a subset of intent A's steps, \
DELETE intent B and add deep-link support to intent A instead.

BAD (these are just CRUD with lipstick — DO NOT BUILD THESE):
- ❌ A table of records with nicer filters (= the CRUD page already does this)
- ❌ A kanban board showing one entity grouped by status (= a dashboard widget, not a workflow)
- ❌ A single-entity form with extra styling (= that's just the existing dialog)
- ❌ A read-only status overview (= belongs on the dashboard, not a separate page)

## YOUR JOB (INTENT PHASE ONLY)

The DashboardOverview.tsx is ALREADY BUILT and deployed. Do NOT rebuild it from scratch.

1. ANALYZE entities, fields, relationships. Identify 2-3 DISTINCT multi-entity workflow phases.

**DECISION GATE — MOST WORKFLOWS BELONG IN THE DASHBOARD, NOT IN INTENT UIs:** \
The dashboard already has interactive, domain-specific UIs with full CRUD. \
Intent UIs are separate pages — they are ONLY justified when a workflow is SO COMPLEX \
that it would overload the dashboard (5+ steps, 3+ entities in a single flow, \
branching logic, or heavy state tracking like budgets/progress across steps). \
\
Ask yourself: "Can this workflow be handled by the dashboard + existing CRUD dialogs?" \
If YES → skip intent UIs, just run 'npm run build' and STOP. \
\
SKIP intent UIs when: \
- The app has fewer than 4 entities \
- Workflows can be handled by the dashboard + existing CRUD dialogs \
- There are no workflows spanning 3+ entities in a single multi-step sequence \
\
Only proceed if there is at least ONE workflow that genuinely \
cannot fit in the dashboard because of its complexity. \
\
**IF SKIPPING:** The sidebar currently shows ghost rows ("Abläufe — werden erstellt …"). \
You MUST clean them up before stopping: \
1. Run `node scripts/wire-intent.mjs --no-flows` — it flips INTENTS_PENDING to false, \
   which removes the ghost rows (do NOT edit src/config/intents.ts by hand) \
2. Run 'npm run build' and STOP.

2. IF intent UIs are justified, call the tool `build_intent_pages` ONCE with every flow in its \
`flows` array — one entry per page, `{file, brief}`. The pages are built concurrently, so the cost \
is the slowest page instead of their sum. There is no 'intent_builder' subagent; dispatching one \
is denied. Per flow:
   - File path: src/pages/intents/{PascalCaseName}Page.tsx
   - DETAILED step-by-step description: what are the STEPS of the workflow, which entities are touched \
in each step, what records get created/updated, what live feedback to show between steps
   - For EVERY selection step: WHICH records are eligible. That is your decision, not the user's — \
a close-an-order flow that lists already-closed orders lets them be closed twice. Name the filter, \
or say explicitly that all records qualify and why.
   - COPY VERBATIM from .entity_summary: module paths, service method names, the `!` required markers, \
applookup target app_ids, and the lookup keys listed after a lookup field's type \
([lookup/select: a|b|c]) — a step that writes or filters a lookup field gets its exact keys \
in the brief. Those are verified facts and quoting them is the point of that file.
   - NOTHING ELSE. The page builder Reads `.claude/skills/intent-ui/SKILL.md` before it \
writes any code, so it already owns the block contracts (IntentWizardShell, EntitySelectStep, \
BudgetTracker, StatusBadge), the no-{Entity}Dialog rule, the lookup-write form and the import style — \
from a source that is maintained, unlike your memory of it. Never name a type, helper or path you did \
not read in .entity_summary: a brief that told the builder to import `EnrichedKunden` named a type \
that does not exist.
   - KEEP EACH BRIEF UNDER ~350 WORDS: file path, one-sentence goal, the steps (eligible records \
with exact keys, fields as name![type: keys], service calls with app_ids), the module-paths block. \
No "German UI" reminders, no date/hook/import rules, no required-fields recap — the ! markers \
already carry it. A measured run spent ~40s just generating two briefs.

DO NOT dispatch 'dashboard_builder'.

3. After build_intent_pages returns (it reports OK/FAILED per page):
   - Wire EACH flow with the script — one call per flow, do NOT edit src/App.tsx or
     src/config/intents.ts by hand:
       node scripts/wire-intent.mjs {PascalCaseName}Page {slug} '{1-3 words in the UI language}' {IconX} '{one line}'
     It adds the lazy import + route to App.tsx, the icon import + registry entry to
     src/config/intents.ts (the sidebar "Abläufe" section renders from that registry; do NOT
     add navigation cards to the dashboard) and flips INTENTS_PENDING to false — that swaps
     the sidebar's ghost rows for your real entries. Pick a fitting Tabler icon (COMPONENT
     name like IconCalendarPlus). If the script fails it names the exact problem — fix that
     and re-run; never edit outside the marker blocks, everything else is scaffold.
   - Run 'npm run build', fix any TypeScript errors, keep fixing until build succeeds

4. After 'npm run build' succeeds, STOP immediately."""

        print(f"[KLAR] Phase 2: Intents-only build")

    else:
        # Build-Mode (all): Orchestrator dispatches subagents for dashboard + intent UIs
        query = """\
You are the BUILD ORCHESTRATOR. Read .entity_summary (short, ~30 lines) for entity info. Do NOT read .scaffold_context or app_metadata.json — they are too large and waste time.

## WHAT ARE INTENT UIs?

Every entity ALREADY has a full CRUD page (table + search + create/edit/delete). Intent UIs are NOT more CRUD pages \
with different styling. They are TASK WORKFLOWS.

An intent UI is a MULTI-STEP WIZARD that:
- Spans MULTIPLE entities in one flow (selecting from entity A → creating linked records in entity B and C)
- Has STEPS (wizard/stepper pattern with clear step progression)
- Often creates MULTIPLE records in a single flow (e.g., inviting 20 guests = 20 invitation records)
- Shows LIVE FEEDBACK as the user progresses (running totals, counts, progress bar, budget remaining)
- Has a clear START → END (user begins task → user completes task with a result)
- Supports deep-linking to specific steps via URL params (e.g., ?eventId=xxx&step=2)

## CRITICAL: NO REDUNDANT INTENTS

Each intent MUST be a UNIQUE workflow that does NOT overlap with other intents. \
If one wizard has steps A→B→C, do NOT create separate intent pages for step B and step C — \
instead, make the wizard support deep-linking to specific steps via URL query params.

EXAMPLE — WRONG (redundant):
- "Prepare Event" wizard: pick event → invite guests → book vendors → summary
- "Manage RSVPs" page: pick event → update guest statuses  ← THIS IS JUST STEP 2 OF THE WIZARD!
- "Book Vendors" page: pick event → browse vendors → book them  ← THIS IS JUST STEP 3 OF THE WIZARD!

EXAMPLE — CORRECT (each intent is unique):
- "Prepare Event" wizard: pick event → invite guests → book vendors → summary
  - Dashboard links to specific steps: ?eventId=xxx&step=2 for guest management
- "Close Event" wizard: pick event → review payment statuses → finalize RSVPs → set event to completed → generate report
  - This is a DIFFERENT lifecycle phase, not a subset of "Prepare"

RULE: Before finalizing your intent list, check each pair — if intent B is a subset of intent A's steps, \
DELETE intent B and add deep-link support to intent A instead. Only keep intents that represent \
DIFFERENT phases or completely different multi-entity workflows.

BAD (these are just CRUD with lipstick — DO NOT BUILD THESE):
- ❌ A table of records with nicer filters (= the CRUD page already does this)
- ❌ A kanban board showing one entity grouped by status (= a dashboard widget, not a workflow)
- ❌ A single-entity form with extra styling (= that's just the existing dialog)
- ❌ A read-only status overview (= belongs on the dashboard, not a separate page)

## YOUR JOB

1. ANALYZE entities, fields, relationships. Think: what real-world MULTI-ENTITY WORKFLOWS do users perform? \
A workflow always involves creating/updating records across 2+ entities in a sequence of steps. \
Identify 2-3 DISTINCT workflow phases (e.g., preparation phase vs. closing phase vs. reporting phase). \
Check for redundancy — if two workflows share most steps, merge them into one wizard with deep-linking.

**DECISION GATE — MOST WORKFLOWS BELONG IN THE DASHBOARD, NOT IN INTENT UIs:** \
The dashboard agent already builds interactive, domain-specific UIs with full CRUD. \
Intent UIs are separate pages — they are ONLY justified when a workflow is SO COMPLEX \
that it would overload the dashboard (5+ steps, 3+ entities in a single flow, \
branching logic, or heavy state tracking like budgets/progress across steps). \
\
Ask yourself: "Can the dashboard agent build this as a section or interactive widget \
on the main page?" If YES → it belongs in the dashboard, NOT in an intent UI. \
\
SKIP intent UIs when: \
- The app has fewer than 4 entities \
- Workflows can be handled by the dashboard + existing CRUD dialogs \
- There are no workflows spanning 3+ entities in a single multi-step sequence \
\
Only proceed with intent UIs if there is at least ONE workflow that genuinely \
cannot fit in the dashboard because of its complexity. \
\
**IF SKIPPING:** The sidebar currently shows ghost rows ("Abläufe — werden erstellt …"). \
You MUST clean them up before stopping: \
1. Run `node scripts/wire-intent.mjs --no-flows` — it flips INTENTS_PENDING to false, \
   which removes the ghost rows (do NOT edit src/config/intents.ts by hand) \
2. Run 'npm run build' and STOP.

2. IF intent UIs are justified, call the tool `build_intent_pages` ONCE with every flow in its \
`flows` array — one entry per page, `{file, brief}`. The pages are built concurrently, so the cost \
is the slowest page instead of their sum. There is no 'intent_builder' subagent; dispatching one \
is denied.
   a) For EACH intent, one `flows` entry with:
      - File path: src/pages/intents/{PascalCaseName}Page.tsx
      - DETAILED step-by-step description: what are the STEPS of the workflow, which entities are touched \
in each step, what records get created/updated, what live feedback to show between steps
      - For EVERY selection step: WHICH records are eligible. That is your decision, not the user's — \
a close-an-order flow that lists already-closed orders lets them be closed twice. Name the filter, \
or say explicitly that all records qualify and why.
      - COPY VERBATIM from .entity_summary: module paths, service method names, the `!` required markers, \
applookup target app_ids, and the lookup keys listed after a lookup field's type \
([lookup/select: a|b|c]) — a step that writes or filters a lookup field gets its exact keys \
in the brief. Those are verified facts and quoting them is the point of that file.
      - NOTHING ELSE. The page builder Reads `.claude/skills/intent-ui/SKILL.md` before \
it writes any code, so it already owns the block contracts (IntentWizardShell, EntitySelectStep, \
BudgetTracker, StatusBadge), the no-{Entity}Dialog rule, the lookup-write form and the import style — \
from a source that is maintained, unlike your memory of it. Never name a type, helper or path you did \
not read in .entity_summary: a brief that told the builder to import `EnrichedKunden` named a type \
that does not exist.
      - KEEP EACH BRIEF UNDER ~350 WORDS: file path, one-sentence goal, the steps (eligible records \
with exact keys, fields as name![type: keys], service calls with app_ids), the module-paths block. \
No "German UI" reminders, no date/hook/import rules, no required-fields recap — the ! markers \
already carry it. A measured run spent ~40s just generating two briefs.

3. After build_intent_pages returns (it reports OK/FAILED per page):
   - Wire EACH flow with the script — one call per flow, do NOT edit src/App.tsx or
     src/config/intents.ts by hand:
       node scripts/wire-intent.mjs {PascalCaseName}Page {slug} '{1-3 words in the UI language}' {IconX} '{one line}'
     It adds the lazy import + route to App.tsx, the icon import + registry entry to
     src/config/intents.ts (the sidebar "Abläufe" section renders from that registry; do NOT
     add navigation cards to the dashboard) and flips INTENTS_PENDING to false — that swaps
     the sidebar's ghost rows for your real entries. Pick a fitting Tabler icon (COMPONENT
     name like IconCalendarPlus). If the script fails it names the exact problem — fix that
     and re-run; never edit outside the marker blocks, everything else is scaffold.
   - Run 'npm run build', fix any TypeScript errors, keep fixing until build succeeds

4. After 'npm run build' succeeds, STOP immediately.

CRITICAL: Dispatch ALL subagents in a SINGLE response for maximum parallelism."""

        if user_instructions:
            query += (
                f"\n\nADDITIONAL user instructions:\n"
                f"<user-instructions>\n{user_instructions}\n</user-instructions>"
            )
            print(f"[KLAR] Orchestrator-Mode MIT User Instructions: {user_instructions}")
        else:
            print(f"[KLAR] Orchestrator-Mode: Dashboard + Intent UIs")

    t_agent_total_start = time.time()
    print(f"[KLAR] Initialisiere Client")

    async with ClaudeSDKClient(options=options) as client:

        await client.query(query)

        t_last_step = t_agent_total_start

        # Stall watchdog: the SDK retries rate-limited API calls silently, so
        # a 429-backoff looks like a multi-minute hole in the stream. One
        # line per 30s of silence makes the wait visible as it happens.
        # With streaming enabled, generation keeps _LAST_EVENT fresh (deltas
        # arrive continuously), so a [WAIT] is a REAL stall — the text says
        # which of the two worlds this build runs in.
        _mark_event()

        async def _stall_watchdog():
            reported = 0.0
            while True:
                await asyncio.sleep(15)
                silent = time.time() - _LAST_EVENT["t"]
                if silent >= 30 and silent >= reported + 30:
                    reported = silent
                    # Deliberately neutral: this CLI build delivers partial_json
                    # deltas of big tool inputs as an end-of-block burst, so
                    # silence here usually IS a large generation in progress
                    # (see the stream-progress plumbing note above).
                    print(
                        f"[WAIT] {round(silent)}s ohne Stream-Event — meist eine große Generierung (Tool-Input-Deltas kommen gebündelt), sonst Rate-Limit-Backoff",
                        flush=True,
                    )
                elif silent < 30:
                    reported = 0.0

        watchdog = asyncio.create_task(_stall_watchdog())
        main_prog = {"chars": 0, "last": time.time()}

        async for message in client.receive_response():
            now = time.time()
            _mark_event()

            # Stream deltas: feed the watchdog + throttled progress line, but
            # do NOT touch t_last_step — `dt` keeps meaning "time since the
            # previous REAL event", which is the number used to spot expensive
            # single tool calls in the log.
            chars = _stream_delta_chars(message)
            if chars is not None:
                main_prog["chars"] += chars
                if main_prog["chars"] and now - main_prog["last"] >= _PROGRESS_EVERY_S:
                    main_prog["last"] = now
                    print(json.dumps({
                        "type": "progress", "chars": main_prog["chars"],
                        "t": round(now - t_agent_total_start, 1),
                        **_actor_fields(getattr(message, "parent_tool_use_id", None)),
                    }), flush=True)
                continue

            elapsed = round(now - t_agent_total_start, 1)
            dt = round(now - t_last_step, 1)
            t_last_step = now

            if isinstance(message, AssistantMessage):
                main_prog["chars"] = 0
                actor = _actor_fields(message.parent_tool_use_id)
                for block in message.content:
                    if isinstance(block, TextBlock):
                        print(json.dumps({"type": "think", "content": block.text, "t": elapsed, "dt": dt, "model": message.model, **actor}), flush=True)

                    elif isinstance(block, ToolUseBlock):
                        print(json.dumps({"type": "tool", "tool": block.name, "tool_use_id": block.id, "input": str(block.input), "t": elapsed, "dt": dt, "model": message.model, **actor}), flush=True)

            elif isinstance(message, UserMessage):
                if isinstance(message.content, list):
                    actor = _actor_fields(message.parent_tool_use_id)
                    for block in message.content:
                        if isinstance(block, ToolResultBlock) and _LOG_LEVEL == "debug":
                            content = str(block.content)[:4000] if block.content else ""
                            print(json.dumps({"type": "tool_result", "tool_use_id": block.tool_use_id, "output": content, "is_error": block.is_error, "t": elapsed, **actor}), flush=True)

            elif isinstance(message, ResultMessage):
                status = "success" if not message.is_error else "error"
                print(f"[KLAR] Session ID: {message.session_id}")

                if message.session_id:
                    try:
                        # Phase-suffixed in the parallel mode: two CLI
                        # processes share this tree, and the last writer of
                        # ONE file would hand Phase 1's session save the
                        # WRONG session id.
                        session_file = "/home/user/app/.claude_session_id"
                        if build_phase == "intents-pages":
                            session_file += "_intents"
                        with open(session_file, "w") as f:
                            f.write(message.session_id)
                        print(f"[KLAR] ✅ Session ID in Datei gespeichert")
                    except Exception as e:
                        print(f"[KLAR] ⚠️ Fehler beim Speichern der Session ID: {e}")

                t_agent_total = time.time() - t_agent_total_start
                print(json.dumps({
                    "type": "result",
                    "status": status,
                    "cost": message.total_cost_usd,
                    "session_id": message.session_id,
                    "duration_s": round(t_agent_total, 1),
                    # cache_read vs cache_creation vs input tells whether prompt
                    # caching carried the resumed history or every turn paid full
                    "usage": getattr(message, "usage", None)
                }), flush=True)

        watchdog.cancel()

if __name__ == "__main__":
    import sys
    try:
        asyncio.run(main())
    except Exception as e:
        print(f"\n[KLAR] FATAL ERROR: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
        import traceback
        traceback.print_exc(file=sys.stderr)
        sys.exit(1)
