#!/usr/bin/env node
// Mechanical healer for the record-shape TS error classes (run BEFORE
// `npm run build`: `node scripts/heal-tsc.mjs && node scripts/i18n-tx.mjs wrap && npm run build`).
//
// The generated data model has one rigid shape: record fields live under
// `.fields`, resolved lookup names live as extras on the Enriched* types
// (src/types/enriched.ts), write payloads take `undefined` — never `null`.
// Live builds keep slipping on exactly these spots, all provable — so they
// are pipeline input, not repair tasks:
//
//   A. TS2339 `auftrag.auftragsnummer` where the field lives on
//      `auftrag.fields.auftragsnummer` — the missing `.fields.` prefix.
//      Fix: insert `fields.` before the property name (works for `?.` too).
//   B. TS2339 `record: RechnungsPdfErstellen` in a type-literal member while
//      the body reads the Enriched-only field (`p.rechnungName`) — the raw
//      type where the data flowing in is enriched. Fix: retype the `record:`
//      member(s) to the Enriched* type and ensure its import.
//   C. TS2322 `{ status: prev ?? null }` in a service-call payload — the
//      field type wants `undefined`, never `null` (live: two undo paths cost
//      ~40s). Fix: `?? null` → `?? undefined`, only when the reported target
//      type accepts undefined and rejects null.
//
// A/B only apply when the property PROVABLY exists at the target (parsed
// from the generated src/types/app.ts + src/types/enriched.ts) — no
// guessing, and everything else in the tsc output is passed through
// verbatim for the agent. A rewrite is only written out if it re-parses.
// `remaining` in the report counts ALL open tsc errors — a build failing on
// something this script cannot heal must never read as "0 remaining" (live:
// a TS2774-only failure printed remaining:0 above the real error).
//
//   default              — run tsc, fix, re-run tsc; exit 0 iff clean.
//   --errors-file <f>    — test mode: read tsc output from <f>, apply fixes,
//                          print the report, exit 0 (no tsc runs;
//                          remaining: -1 = unknown, nothing re-ran).
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
// typescript is CJS; default-import interop breaks on some node/ts combos.
const ts = createRequire(import.meta.url)('typescript');

const APP_TYPES = 'src/types/app.ts';
const ENRICHED_TYPES = 'src/types/enriched.ts';

// ── Generated type shapes ───────────────────────────────────────────

function sourceFile(path) {
  return ts.createSourceFile(
    path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true,
    path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

// app.ts: `export interface X { …; fields: { a?: …; b?: … }; }`
function parseRecordFields() {
  const byType = new Map();
  if (!existsSync(APP_TYPES)) return byType;
  const sf = sourceFile(APP_TYPES);
  for (const stmt of sf.statements) {
    if (!ts.isInterfaceDeclaration(stmt)) continue;
    for (const member of stmt.members) {
      if (
        ts.isPropertySignature(member) && member.name.getText(sf) === 'fields' &&
        member.type && ts.isTypeLiteralNode(member.type)
      ) {
        const names = new Set(
          member.type.members
            .filter((m) => ts.isPropertySignature(m))
            .map((m) => m.name.getText(sf)),
        );
        byType.set(stmt.name.text, names);
      }
    }
  }
  return byType;
}

// enriched.ts: `export type EnrichedX = X & { extraA: string; … };`
function parseEnriched() {
  const extras = new Map();   // EnrichedX -> Set(extraNames)
  const base = new Map();     // EnrichedX -> X
  const byBase = new Map();   // X -> EnrichedX
  if (!existsSync(ENRICHED_TYPES)) return { extras, base, byBase };
  const sf = sourceFile(ENRICHED_TYPES);
  for (const stmt of sf.statements) {
    if (!ts.isTypeAliasDeclaration(stmt) || !ts.isIntersectionTypeNode(stmt.type)) continue;
    const ref = stmt.type.types.find((t) => ts.isTypeReferenceNode(t));
    const lit = stmt.type.types.find((t) => ts.isTypeLiteralNode(t));
    if (!ref || !lit) continue;
    const names = new Set(
      lit.members.filter((m) => ts.isPropertySignature(m)).map((m) => m.name.getText(sf)),
    );
    extras.set(stmt.name.text, names);
    base.set(stmt.name.text, ref.typeName.getText(sf));
    byBase.set(ref.typeName.getText(sf), stmt.name.text);
  }
  return { extras, base, byBase };
}

// ── tsc ─────────────────────────────────────────────────────────────

function runTsc() {
  const r = spawnSync('npx', ['tsc', '-b', '--pretty', 'false'], {
    encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  });
  return { ok: r.status === 0, output: (r.stdout || '') + (r.stderr || '') };
}

const ERROR_RE = /^(.+?)\((\d+),(\d+)\): error TS2339: Property '(.+?)' does not exist on type '(.+?)'\.$/;
const NULL_RE = /^(.+?)\((\d+),(\d+)\): error TS2322: Type '(.+?)' is not assignable to type '(.+?)'\.$/;

function parseErrors(output) {
  const errors = [];
  const nullErrors = [];
  let total = 0;
  for (const line of output.split('\n')) {
    const trimmed = line.trim();
    if (/error TS\d+/.test(trimmed)) total += 1;
    const m = trimmed.match(ERROR_RE);
    if (m) {
      const [, file, lineNo, col, prop, typeName] = m;
      // Only bare identifier types — our classes never involve unions/literals.
      if (/^[A-Za-z_$][\w$]*$/.test(typeName)) {
        errors.push({ file, line: Number(lineNo), col: Number(col), prop, typeName });
      }
      continue;
    }
    const n = trimmed.match(NULL_RE);
    if (n) {
      const [, file, lineNo, col, sourceType, targetType] = n;
      // Class C shape only: the source union carries null, the target takes
      // undefined and rejects null — the fix is provably `?? null` → `?? undefined`.
      if (
        /\bnull\b/.test(sourceType) &&
        /\bundefined\b/.test(targetType) && !/\bnull\b/.test(targetType)
      ) {
        nullErrors.push({ file, line: Number(lineNo), col: Number(col) });
      }
    }
  }
  return { errors, nullErrors, total };
}

// ── Fixes ───────────────────────────────────────────────────────────

function verifyParses(src, filePath) {
  const sf = ts.createSourceFile(
    filePath, src, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const diags = sf.parseDiagnostics ?? [];
  if (diags.length) {
    throw new Error(`rewrite would not parse — ${filePath} left unchanged`);
  }
}

// The `?? null` whose null the class-C error points at: same line.
function findNullishNull(sf, line) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isBinaryExpression(n) &&
      n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      n.right.kind === ts.SyntaxKind.NullKeyword &&
      sf.getLineAndCharacterOfPosition(n.right.getStart(sf)).line + 1 === line
    ) {
      found = n.right;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// The property-access node the error points at: same line, same name.
function findAccess(sf, line, prop) {
  let found = null;
  const visit = (n) => {
    if (found) return;
    if (
      ts.isPropertyAccessExpression(n) && n.name.text === prop &&
      sf.getLineAndCharacterOfPosition(n.name.getStart(sf)).line + 1 === line
    ) {
      found = n;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

function ensureEnrichedImport(src, name) {
  if (new RegExp(`import\\s+type\\s*\\{[^}]*\\b${name}\\b[^}]*\\}\\s*from\\s*'@/types/enriched'`).test(src)) {
    return src;
  }
  const m = src.match(/import\s+type\s*\{([^}]*)\}\s*from\s*'@\/types\/enriched';/);
  if (m) {
    return src.replace(
      m[0],
      `import type { ${m[1].replace(/^\s*|[,\s]*$/g, '')}, ${name} } from '@/types/enriched';`,
    );
  }
  const sf = ts.createSourceFile('x.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let importEnd = 0;
  for (const stmt of sf.statements) {
    if (ts.isImportDeclaration(stmt)) importEnd = stmt.getEnd();
  }
  return src.slice(0, importEnd) + `\nimport type { ${name} } from '@/types/enriched';` + src.slice(importEnd);
}

// Retyping can orphan the raw-type import — the sandbox build runs with
// noUnusedLocals, so an idle import is its own TS6133. Drop the name from
// its import clause when NOTHING outside an import references it anymore.
function dropUnusedImport(src, name, filePath) {
  const sf = ts.createSourceFile(
    filePath, src, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  let used = false;
  const inImport = (n) => {
    for (let p = n.parent; p; p = p.parent) {
      if (ts.isImportDeclaration(p)) return true;
    }
    return false;
  };
  const visit = (n) => {
    if (used) return;
    if (ts.isIdentifier(n) && n.text === name && !inImport(n)) {
      used = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (used) return src;
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !stmt.importClause?.namedBindings) continue;
    const nb = stmt.importClause.namedBindings;
    if (!ts.isNamedImports(nb)) continue;
    const el = nb.elements.find((e) => e.name.text === name);
    if (!el) continue;
    if (nb.elements.length === 1 && !stmt.importClause.name) {
      let end = stmt.getEnd();
      while (end < src.length && (src[end] === '\n' || src[end] === '\r')) end += 1;
      return src.slice(0, stmt.getStart(sf)) + src.slice(end);
    }
    const idx = nb.elements.indexOf(el);
    let start = el.getStart(sf);
    let end = el.getEnd();
    if (idx < nb.elements.length - 1) end = nb.elements[idx + 1].getStart(sf);
    else start = nb.elements[idx - 1].getEnd();
    return src.slice(0, start) + src.slice(end);
  }
  return src;
}

function healFile(filePath, errors, nullErrors, shapes) {
  const before = readFileSync(filePath, 'utf8');
  const sf = ts.createSourceFile(
    filePath, before, ts.ScriptTarget.Latest, true,
    filePath.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const { fieldsByType, enriched } = shapes;
  const edits = [];          // {start, end, text}
  const fixed = [];
  const needImports = new Set();
  const retypedRaw = new Set();

  // Class C: `?? null` where the payload type wants undefined.
  for (const err of nullErrors) {
    const nullNode = findNullishNull(sf, err.line);
    if (!nullNode) continue;
    edits.push({ start: nullNode.getStart(sf), end: nullNode.getEnd(), text: 'undefined' });
    fixed.push({ file: filePath, line: err.line, kind: 'null-to-undefined' });
  }

  for (const err of errors) {
    // Class A: the property is a FIELD of the record — the `.fields.` prefix
    // is missing. Applies to raw and Enriched types alike (Enriched extends
    // the raw record, so `fields` is present either way).
    const baseName = enriched.base.get(err.typeName) ?? err.typeName;
    const fields = fieldsByType.get(baseName);
    if (fields?.has(err.prop)) {
      const node = findAccess(sf, err.line, err.prop);
      if (node) {
        const pos = node.name.getStart(sf);
        edits.push({ start: pos, end: pos, text: 'fields.' });
        fixed.push({ file: filePath, line: err.line, kind: 'fields-prefix', prop: err.prop });
      }
      continue;
    }
    // Class B: the property is an Enriched-only extra, but the expression is
    // typed with the RAW record type — the annotation is wrong, not the read.
    // The annotation idiom is the overlay-union member `record: T` (the
    // skeleton pre-generates it correctly; this heals hand-written ones and
    // legacy dashboards). Retype every `record: T` type-literal member.
    const enrichedName = enriched.byBase.get(err.typeName);
    if (enrichedName && enriched.extras.get(enrichedName)?.has(err.prop)) {
      let retyped = 0;
      const visit = (n) => {
        if (
          ts.isPropertySignature(n) && n.name.getText(sf) === 'record' &&
          n.type && ts.isTypeReferenceNode(n.type) &&
          n.type.typeName.getText(sf) === err.typeName
        ) {
          edits.push({ start: n.type.getStart(sf), end: n.type.getEnd(), text: enrichedName });
          retyped += 1;
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (retyped) {
        needImports.add(enrichedName);
        retypedRaw.add(err.typeName);
        fixed.push({ file: filePath, line: err.line, kind: 'raw-to-enriched', prop: err.prop, type: enrichedName });
      }
    }
    // Anything else: not our class — stays in the tsc output for the agent.
  }

  if (!edits.length) return fixed;

  // Overlapping/duplicate edits (two errors retyping the same member) — dedupe.
  const seen = new Set();
  const unique = edits.filter((e) => {
    const key = `${e.start}:${e.end}:${e.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  unique.sort((a, b) => b.start - a.start);
  let out = before;
  for (const e of unique) out = out.slice(0, e.start) + e.text + out.slice(e.end);
  for (const name of needImports) out = ensureEnrichedImport(out, name);
  for (const name of retypedRaw) out = dropUnusedImport(out, name, filePath);
  verifyParses(out, filePath);
  writeFileSync(filePath, out);
  return fixed;
}

// ── CLI ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const errorsFileIdx = args.indexOf('--errors-file');
const testMode = errorsFileIdx !== -1;

let output;
if (testMode) {
  output = readFileSync(args[errorsFileIdx + 1], 'utf8');
} else {
  const first = runTsc();
  if (first.ok) {
    console.log(JSON.stringify({ fixed: [], remaining: 0 }));
    process.exit(0);
  }
  output = first.output;
}

const parsed = parseErrors(output);
const shapes = {
  fieldsByType: parseRecordFields(),
  enriched: parseEnriched(),
};

const files = new Set([...parsed.errors, ...parsed.nullErrors].map((e) => e.file));
const fixed = [];
for (const file of files) {
  if (!existsSync(file)) continue;
  try {
    fixed.push(...healFile(
      file,
      parsed.errors.filter((e) => e.file === file),
      parsed.nullErrors.filter((e) => e.file === file),
      shapes,
    ));
  } catch (e) {
    console.error(`heal-tsc: ${file}: ${String(e.message ?? e)}`);
  }
}

if (testMode) {
  console.log(JSON.stringify({ fixed, remaining: -1 }));
  process.exit(0);
}

if (!fixed.length) {
  // Nothing we can prove — hand the original output straight to the agent.
  // `remaining` counts ALL open tsc errors, not this script's candidates:
  // a build failing on an unhealable class must never read as "0 remaining".
  console.log(JSON.stringify({ fixed: [], remaining: parsed.total }));
  process.stdout.write(output);
  process.exit(1);
}

const second = runTsc();
console.log(JSON.stringify({
  fixed,
  remaining: second.ok ? 0 : parseErrors(second.output).total,
}));
if (!second.ok) process.stdout.write(second.output);
process.exit(second.ok ? 0 : 1);
