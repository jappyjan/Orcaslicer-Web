/**
 * Model input: a file from the phone, or one already in the server's library.
 *
 * The file is uploaded when it is chosen, not when the slice is submitted, so that every
 * job — the first one included — refers to the model by its `sha256:` content id. That
 * makes "slice again with a different filament" a JSON request rather than a second
 * upload, which is the single biggest difference between this being usable and unusable
 * on mobile data.
 *
 * The `<input type="file">` is transparent and stretched over the whole label rather than
 * hidden behind it: that keeps the actual tap target 48px tall instead of relying on a
 * label-to-input association that some mobile browsers handle inconsistently.
 */

import { useState } from 'react';
import type { ApiError, ModelSummary } from '@orca-web/shared';
import { formatBytes } from '../format.ts';
import { ErrorNotice, OptionRow, Sheet } from './primitives.tsx';

/** Everything `apps/api/src/jobs/job-service.ts` accepts. */
const ACCEPT = '.stl,.3mf,.obj,.step,.stp,.amf';

export function ModelPicker({
  recent,
  selectedId,
  onSelect,
  onUpload,
  onClose,
}: {
  recent: readonly ModelSummary[];
  selectedId: string | null;
  onSelect: (model: ModelSummary) => void;
  onUpload: (file: File, onProgress: (fraction: number) => void) => Promise<ModelSummary>;
  onClose: () => void;
}) {
  const [uploading, setUploading] = useState<{ name: string; fraction: number } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);

  async function handleFile(file: File): Promise<void> {
    setError(null);
    setUploading({ name: file.name, fraction: 0 });
    try {
      const model = await onUpload(file, (fraction) =>
        setUploading((current) => (current ? { ...current, fraction } : current)),
      );
      setUploading(null);
      onSelect(model);
    } catch (cause) {
      setUploading(null);
      setError(
        cause instanceof Error && 'error' in cause
          ? (cause as { error: ApiError }).error
          : { code: 'INTERNAL', message: String(cause), retryable: false },
      );
    }
  }

  return (
    <Sheet title="Model" subtitle="STL or 3MF" onClose={onClose} testId="model-picker">
      <div className="space-y-4">
        {error ? <ErrorNotice error={error} /> : null}

        {uploading ? (
          <div className="rounded-xl border border-line bg-surface p-4" role="status">
            <p className="truncate text-base">{uploading.name}</p>
            <div className="mt-3 h-2 w-full overflow-hidden rounded-full bg-surface-2">
              <div
                className="h-full rounded-full bg-accent transition-[width] duration-200"
                style={{ width: `${Math.round(uploading.fraction * 100)}%` }}
              />
            </div>
            <p className="mt-2 text-sm text-muted">
              Uploading… {Math.round(uploading.fraction * 100)}%
            </p>
          </div>
        ) : (
          <label className="tap relative flex w-full items-center justify-center rounded-xl border border-dashed border-accent/60 bg-accent/5 px-4 py-4 text-center text-base font-semibold text-accent">
            Choose a file
            <input
              type="file"
              accept={ACCEPT}
              data-testid="model-file-input"
              aria-label="Choose a model file"
              className="absolute inset-0 h-full w-full opacity-0"
              onChange={(event) => {
                const file = event.target.files?.[0];
                // Reset so re-choosing the same file fires `change` again.
                event.target.value = '';
                if (file) void handleFile(file);
              }}
            />
          </label>
        )}

        {recent.length > 0 ? (
          <section>
            <h3 className="mb-2 px-1 text-xs tracking-wide text-muted uppercase">
              Already uploaded
            </h3>
            <p className="mb-2 px-1 text-sm text-muted">
              These are stored on the server by content hash — picking one costs no upload.
            </p>
            <ul className="space-y-2">
              {recent.map((model) => (
                <li key={model.id}>
                  <OptionRow
                    name={model.filename}
                    detail={formatBytes(model.bytes)}
                    selected={model.id === selectedId}
                    onClick={() => onSelect(model)}
                    testId={`model-${model.id}`}
                  />
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </Sheet>
  );
}
