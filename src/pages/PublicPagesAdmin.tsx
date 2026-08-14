import { useEffect, useState } from 'react';
import {
  IconWorld, IconCheck, IconLink, IconExternalLink, IconLoader2, IconAlertTriangle,
  IconAdjustments, IconEye,
} from '@tabler/icons-react';
import { PageShell } from '@/components/PageShell';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from '@/components/ui/dialog';
import {
  listPublicPages, setPublished, getFields, updateFields,
  type PublicPageSummary, type FieldCatalogEntry,
} from '@/lib/publicPagesAdmin';
import { t } from '@/i18n';

// Owner-facing management of the dashboard's public pages. Same-origin fetch
// to /claude carries the LA session automatically. Anonymous visitors never
// reach this — it lives inside the authenticated Layout.
//
// All text resolves through t() at render time — a module-scope map of
// translated strings would go stale on a language switch.

function originLabel(o: string): string {
  return o === 'auto' ? t('ppa_origin_auto') : o === 'agent' ? t('ppa_origin_agent') : t('ppa_origin_user');
}

// Plain-language summary of what a page's link grants — the owner confirms
// THIS, never the underlying policy. Built from the field/endpoint config.
function capabilities(page: PublicPageSummary): { submit?: string; view?: string } {
  const out: { submit?: string; view?: string } = {};
  if (page.type === 'custom' && page.endpoints) {
    const create = page.endpoints.find(e => e.op === 'create');
    const list = page.endpoints.find(e => e.op === 'list');
    if (create) out.submit = create.fields.map(f => f.label).join(', ');
    if (list) out.view = list.scope_description || list.fields.map(f => f.label).join(', ');
  } else {
    out.submit = page.fields.map(f => f.label).join(', ');
  }
  return out;
}

export default function PublicPagesAdmin() {
  const [pages, setPages] = useState<Record<string, PublicPageSummary>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [copiedSlug, setCopiedSlug] = useState<string | null>(null);
  const [confirmSlug, setConfirmSlug] = useState<string | null>(null);
  // Field editor: which page's fields we're editing, the catalog, and the
  // working selection (a Set of chosen keys).
  const [fieldsSlug, setFieldsSlug] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<FieldCatalogEntry[]>([]);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [fieldsLoading, setFieldsLoading] = useState(false);
  const [savingFields, setSavingFields] = useState(false);

  const load = async () => {
    try {
      setPages(await listPublicPages());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const applyPublished = async (slug: string, published: boolean) => {
    setBusySlug(slug);
    setConfirmSlug(null);
    try {
      const updated = await setPublished(slug, published);
      setPages(prev => ({ ...prev, [slug]: updated }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusySlug(null);
    }
  };

  const copy = async (page: PublicPageSummary) => {
    try {
      await navigator.clipboard.writeText(page.share_url);
      setCopiedSlug(page.slug);
      setTimeout(() => setCopiedSlug(c => (c === page.slug ? null : c)), 1500);
    } catch {
      // clipboard unavailable — the open link still works
    }
  };

  const openFields = async (slug: string) => {
    setFieldsSlug(slug);
    setFieldsLoading(true);
    try {
      const cat = await getFields(slug);
      setCatalog(cat.available);
      setChosen(new Set(cat.selected));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setFieldsSlug(null);
    } finally {
      setFieldsLoading(false);
    }
  };

  const toggleField = (entry: FieldCatalogEntry) => {
    if (!entry.selectable || entry.locked) return;
    setChosen(prev => {
      const next = new Set(prev);
      if (next.has(entry.key)) next.delete(entry.key);
      else next.add(entry.key);
      return next;
    });
  };

  const saveFields = async () => {
    if (!fieldsSlug) return;
    setSavingFields(true);
    try {
      const updated = await updateFields(fieldsSlug, Array.from(chosen));
      setPages(prev => ({ ...prev, [fieldsSlug]: updated }));
      setError(null);
      setFieldsSlug(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSavingFields(false);
    }
  };

  const entries = Object.values(pages).sort((a, b) => a.title.localeCompare(b.title));
  const confirmPage = confirmSlug ? pages[confirmSlug] : null;
  const caps = confirmPage ? capabilities(confirmPage) : {};

  return (
    <PageShell title={t('ppa_title')} subtitle={t('ppa_subtitle')}>
      {error ? (
        <div className="flex items-center gap-2 rounded-2xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive" role="alert">
          <IconAlertTriangle size={18} stroke={1.5} className="shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {loading ? (
        <div className="flex justify-center py-16">
          <IconLoader2 size={28} stroke={1.5} className="animate-spin text-muted-foreground" />
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-[27px] bg-card shadow-lg p-8 text-center text-muted-foreground">
          {t('ppa_empty')}
        </div>
      ) : (
        <div className="rounded-[27px] bg-card shadow-lg overflow-hidden divide-y divide-border">
          {entries.map(page => (
            <div key={page.slug} className="flex items-center gap-4 px-6 py-4 min-w-0">
              <IconWorld size={20} stroke={1.5} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="truncate font-medium">{page.title}</span>
                  <span className="shrink-0 rounded-full bg-secondary px-2 py-0.5 text-[11px] font-medium text-secondary-foreground">
                    {originLabel(page.origin)}
                  </span>
                </div>
                <span className={`text-xs ${page.published ? 'text-primary' : 'text-muted-foreground'}`}>
                  {page.published ? t('ppa_status_published') : t('ppa_status_draft')}
                </span>
              </div>

              {page.published ? (
                <div className="flex items-center gap-1 shrink-0">
                  <a
                    href={page.share_url}
                    target="_blank"
                    rel="noreferrer"
                    title={t('ppa_open')}
                    aria-label={t('ppa_open')}
                    className="p-2 rounded-xl text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    <IconExternalLink size={18} stroke={1.5} />
                  </a>
                  <button
                    type="button"
                    title={copiedSlug === page.slug ? t('ppa_copied') : t('ppa_copy')}
                    aria-label={t('ppa_copy')}
                    onClick={() => copy(page)}
                    className="p-2 rounded-xl text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                  >
                    {copiedSlug === page.slug ? <IconCheck size={18} stroke={1.5} /> : <IconLink size={18} stroke={1.5} />}
                  </button>
                </div>
              ) : null}

              {page.type !== 'custom' ? (
                <button
                  type="button"
                  title={t('ppa_fields')}
                  aria-label={t('ppa_fields')}
                  onClick={() => openFields(page.slug)}
                  className="shrink-0 p-2 rounded-xl text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                >
                  <IconAdjustments size={18} stroke={1.5} />
                </button>
              ) : null}

              <Button
                variant={page.published ? 'outline' : 'default'}
                size="sm"
                className="shrink-0"
                disabled={busySlug === page.slug}
                onClick={() =>
                  page.published ? applyPublished(page.slug, false) : setConfirmSlug(page.slug)
                }
              >
                {busySlug === page.slug ? (
                  <IconLoader2 size={16} stroke={1.5} className="animate-spin" />
                ) : page.published ? (
                  t('ppa_pause')
                ) : (
                  t('ppa_publish')
                )}
              </Button>
            </div>
          ))}
        </div>
      )}

      <Dialog open={!!confirmPage} onOpenChange={v => !v && setConfirmSlug(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ppa_confirm_title')}</DialogTitle>
            <DialogDescription>{confirmPage?.title}</DialogDescription>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {caps.submit ? (
              <p><span className="font-medium">{t('ppa_can_do')}</span> {t('ppa_can_submit')} <span className="text-muted-foreground">({caps.submit})</span></p>
            ) : null}
            {caps.view ? (
              <p><span className="font-medium">{t('ppa_can_do')}</span> {t('ppa_can_view')} <span className="text-muted-foreground">({caps.view})</span></p>
            ) : null}
            <p><span className="font-medium">{t('ppa_cannot_do')}</span> {t('ppa_cannot_line')}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmSlug(null)}>{t('ppa_cancel')}</Button>
            <Button onClick={() => confirmPage && applyPublished(confirmPage.slug, true)}>
              {t('ppa_confirm_publish')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={!!fieldsSlug} onOpenChange={v => !v && setFieldsSlug(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('ppa_fields_title')}</DialogTitle>
            <DialogDescription>{t('ppa_fields_intro')}</DialogDescription>
          </DialogHeader>
          {fieldsLoading ? (
            <div className="flex justify-center py-8">
              <IconLoader2 size={24} stroke={1.5} className="animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto space-y-1 -mx-2 px-2">
              {catalog.map(entry => {
                const checked = entry.locked ? true : chosen.has(entry.key);
                const disabled = !entry.selectable || entry.locked;
                return (
                  <label
                    key={entry.key}
                    className={`flex items-start gap-3 rounded-xl px-3 py-2 ${
                      disabled ? 'opacity-60' : 'cursor-pointer hover:bg-accent'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 shrink-0"
                      checked={checked}
                      disabled={disabled}
                      onChange={() => toggleField(entry)}
                    />
                    <span className="min-w-0">
                      <span className="block text-sm">{entry.label}</span>
                      {entry.locked ? (
                        <span className="block text-xs text-muted-foreground">{t('ppa_field_required')}</span>
                      ) : entry.reason === 'file' ? (
                        <span className="block text-xs text-muted-foreground">{t('ppa_field_file')}</span>
                      ) : entry.exposes_list ? (
                        <span className="flex items-center gap-1 text-xs text-amber-600 dark:text-amber-500">
                          <IconEye size={13} stroke={1.5} /> {t('ppa_field_exposes')}
                        </span>
                      ) : null}
                    </span>
                  </label>
                );
              })}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setFieldsSlug(null)}>{t('ppa_cancel')}</Button>
            <Button onClick={saveFields} disabled={savingFields || fieldsLoading}>
              {savingFields ? <IconLoader2 size={16} stroke={1.5} className="animate-spin" /> : t('ppa_save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}
