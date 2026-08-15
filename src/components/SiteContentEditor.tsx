'use client';

import { useState, useTransition } from 'react';

import { updateSiteContent } from '@/app/admin/actions';
import type { SiteContent } from '@/lib/types';

type FieldKey = Exclude<keyof SiteContent, 'updatedAt' | 'updatedBy'>;

const FIELDS: { key: FieldKey; label: string; hint?: string; multiline?: boolean }[] = [
  { key: 'brandName', label: 'Brand name' },
  { key: 'tagline', label: 'Tagline', hint: 'Short line above the headline.' },
  { key: 'heroHeading', label: 'Hero heading' },
  { key: 'heroSubheading', label: 'Hero subheading', multiline: true },
  { key: 'heroCtaLabel', label: 'Hero button label' },
  { key: 'heroCtaHref', label: 'Hero button link', hint: 'For example /signup' },
  { key: 'aboutHeading', label: 'About heading' },
  { key: 'aboutBody', label: 'About body', multiline: true },
  { key: 'contactEmail', label: 'Contact email', hint: 'Leave blank to hide it.' },
];

export default function SiteContentEditor({
  initial,
  disabled = false,
}: {
  initial: SiteContent;
  disabled?: boolean;
}) {
  const [values, setValues] = useState<SiteContent>(initial);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [pending, startTransition] = useTransition();

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setStatus(null);

    startTransition(async () => {
      const patch = Object.fromEntries(
        FIELDS.map((field) => [field.key, values[field.key] ?? '']),
      );
      setStatus(await updateSiteContent(patch));
    });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {FIELDS.map((field) => {
        const id = `content-${field.key}`;
        const shared = {
          id,
          name: field.key,
          value: values[field.key] ?? '',
          disabled: disabled || pending,
          onChange: (
            event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
          ) => setValues((prev) => ({ ...prev, [field.key]: event.target.value })),
          className:
            'mt-1.5 w-full rounded-lg border border-border bg-surface px-3.5 py-2.5 disabled:opacity-60',
        };

        return (
          <div key={field.key}>
            <label htmlFor={id} className="block text-sm font-medium">
              {field.label}
            </label>
            {field.hint ? <p className="text-xs text-muted">{field.hint}</p> : null}
            {field.multiline ? <textarea rows={4} {...shared} /> : <input type="text" {...shared} />}
          </div>
        );
      })}

      <div className="flex items-center gap-4">
        <button
          type="submit"
          disabled={disabled || pending}
          className="rounded-full bg-accent px-6 py-2.5 font-medium text-accent-ink disabled:opacity-60"
        >
          {pending ? 'Saving...' : 'Save changes'}
        </button>

        {status ? (
          <p
            role="status"
            className={`text-sm ${status.ok ? 'text-accent' : 'text-red-600'}`}
          >
            {status.message}
          </p>
        ) : null}
      </div>

      {initial.updatedAt ? (
        <p className="text-xs text-muted">
          Last saved {new Date(initial.updatedAt).toLocaleString()}
          {initial.updatedBy ? ` by ${initial.updatedBy}` : ''}.
        </p>
      ) : null}
    </form>
  );
}
