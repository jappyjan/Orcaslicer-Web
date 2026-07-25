/**
 * Prepare: the plate, the tools that act on it, and the print it will become.
 *
 * The composition, from the back forwards:
 *
 *  - `PlaterStage` fills the viewport. It is the only lazily-loaded piece — three.js is
 *    ~600 kB and the chrome around it is usable (choose a printer, a filament, a quality
 *    preset) before it lands, which is the whole reason the split survived the redesign.
 *  - the rail floats at the top left with the actions OrcaSlicer's desktop toolbar has, in
 *    the same order, but each one labelled.
 *  - the dock carries what the rail cannot: an object list, the transform numbers, and the
 *    print itself.
 *
 * Out-of-bounds and overlap are shown *here*, over the plate and in the colour of the
 * object, rather than surfaced as an engine exit code (-52, -64) a minute into a slice.
 */

import { Suspense, lazy, useRef, useState } from 'react';
import type { ApiError, BedSpec } from '@orca-web/shared';
import { asApiError } from '../api/http.ts';
import { fitProblems, type Plate } from '../state/plate.ts';
import type { PlateEditor } from '../state/plate-editor.ts';
import { ErrorNotice, ToolButton, ToolGroup } from './primitives.tsx';
import { ObjectPanel, summariseProblems, type TransformMode } from './ObjectPanel.tsx';
import { FloatingNotice, Workspace, useDock, type Chrome } from './Workspace.tsx';
import type { StageView } from './PlaterStage.tsx';

const PlaterStage = lazy(async () => ({
  default: (await import('./PlaterStage.tsx')).PlaterStage,
}));

export interface PrepareViewProps {
  plate: Plate;
  bed: BedSpec | null;
  bedError: ApiError | null;
  editor: PlateEditor;
  onSelect: (id: string | null) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
  onAddModel: () => void;
  onArrange: () => Promise<void>;
  chrome: Chrome;
}

export function PrepareView({
  plate,
  bed,
  bedError,
  editor,
  onSelect,
  onDuplicate,
  onDelete,
  onAddModel,
  onArrange,
  chrome,
}: PrepareViewProps) {
  const [mode, setMode] = useState<TransformMode>('move');
  const [arranging, setArranging] = useState(false);
  const [arrangeError, setArrangeError] = useState<ApiError | null>(null);
  const [webglFailed, setWebglFailed] = useState(false);
  const viewRef = useRef<StageView | null>(null);

  const problems = fitProblems(plate.instances, bed);
  const problemText = summariseProblems(plate.instances, problems);
  const selectedId = plate.selectedId;

  const runArrange = (): void => {
    setArranging(true);
    setArrangeError(null);
    onArrange()
      .catch((cause: unknown) => setArrangeError(asApiError(cause)))
      .finally(() => setArranging(false));
  };

  return (
    <Workspace
      testId="plater"
      revealSignal={chrome.revealSignal}
      stage={
        webglFailed ? (
          <NoWebgl />
        ) : (
          <Suspense fallback={<StageSkeleton />}>
            <PlaterStage
              bed={bed}
              instances={plate.instances}
              geometries={editor.geometries}
              selectedId={selectedId}
              problems={problems}
              onSelect={onSelect}
              onWebglFailure={() => setWebglFailed(true)}
              viewRef={viewRef}
            />
          </Suspense>
        )
      }
      title={chrome.title}
      tabs={chrome.tabs}
      status={chrome.status}
      rail={
        <PrepareRail
          mode={mode}
          onMode={setMode}
          hasSelection={selectedId !== null}
          canArrange={plate.instances.length > 0 && !arranging}
          onAddModel={onAddModel}
          onArrange={runArrange}
        />
      }
      viewControls={<ViewControls viewRef={viewRef} />}
      overlay={
        <div
          className="pointer-events-none absolute z-20 flex flex-col items-center gap-2"
          style={{
            left: 'calc(var(--free-left) + 0.5rem)',
            right: 'calc(var(--free-right) + 0.5rem)',
            top: 'calc(var(--free-top) + 0.25rem)',
          }}
        >
          {problemText ? (
            <FloatingNotice tone="danger" testId="plate-problem">
              {problemText}
            </FloatingNotice>
          ) : null}
          {/* The gesture hint sits at the *top* of the free rectangle and only while
              there is a plate and nothing chosen on it: the bottom-left corner belongs to
              the camera buttons, and a hint that overlaps the controls it is describing is
              worse than none. */}
          {bed !== null && selectedId === null ? (
            <p className="max-w-full truncate text-center text-[0.6875rem] text-muted/80">
              Drag to turn · pinch to zoom · tap to select
            </p>
          ) : null}
          {bed === null ? (
            <p className="max-w-full text-center text-xs text-muted/80">
              Choose a printer to see its plate.
            </p>
          ) : null}
        </div>
      }
      dock={
        <>
          {chrome.jobPanel}
          {chrome.printPanel}
          <ObjectPanel
            plate={plate}
            bed={bed}
            problems={problems}
            mode={mode}
            onMode={setMode}
            onSelect={onSelect}
            onPlace={editor.place}
            onTransform={editor.transform}
            onLayFlat={editor.layFlat}
            onDuplicate={onDuplicate}
            onDelete={onDelete}
            onAddModel={onAddModel}
            onArrange={runArrange}
            arranging={arranging}
          />
          {editor.error ? <ErrorNotice error={editor.error} onRetry={editor.dismissError} /> : null}
          {arrangeError ? (
            <ErrorNotice error={arrangeError} onRetry={() => setArrangeError(null)} />
          ) : null}
          {bedError ? <ErrorNotice error={bedError} /> : null}
        </>
      }
      dockAction={chrome.action}
    />
  );
}

/**
 * The floating toolbar.
 *
 * Rendered as its own component rather than inline so that it can reach the dock: on a
 * phone, choosing Rotate has to raise the sheet, because the numbers it just switched to
 * are in it. `useDock` is only meaningful inside `Workspace`, which is where this ends up.
 */
function PrepareRail({
  mode,
  onMode,
  hasSelection,
  canArrange,
  onAddModel,
  onArrange,
}: {
  mode: TransformMode;
  onMode: (mode: TransformMode) => void;
  hasSelection: boolean;
  canArrange: boolean;
  onAddModel: () => void;
  onArrange: () => void;
}) {
  const dock = useDock();
  const pick = (next: TransformMode): void => {
    onMode(next);
    dock.revealPanel('object-panel');
  };
  return (
    <ToolGroup label="Plate tools">
      <ToolButton icon="add" label="Add" testId="tool-add" onClick={onAddModel} />
      <ToolButton
        icon="move"
        label="Move"
        testId="tool-move"
        selected={mode === 'move'}
        disabled={!hasSelection}
        onClick={() => pick('move')}
      />
      <ToolButton
        icon="rotate"
        label="Rotate"
        testId="tool-rotate"
        selected={mode === 'rotate'}
        disabled={!hasSelection}
        onClick={() => pick('rotate')}
      />
      <ToolButton
        icon="scale"
        label="Scale"
        testId="tool-scale"
        selected={mode === 'scale'}
        disabled={!hasSelection}
        onClick={() => pick('scale')}
      />
      <ToolButton
        icon="arrange"
        label="Arrange"
        testId="tool-arrange"
        disabled={!canArrange}
        onClick={onArrange}
      />
    </ToolGroup>
  );
}

export function ViewControls({ viewRef }: { viewRef: { current: StageView | null } }) {
  return (
    <ToolGroup label="Camera" orientation="horizontal">
      <ToolButton
        icon="orbit"
        label="3D"
        testId="view-3d"
        onClick={() => viewRef.current?.resetView()}
      />
      <ToolButton
        icon="top"
        label="Top"
        testId="view-top"
        onClick={() => viewRef.current?.topView()}
      />
    </ToolGroup>
  );
}

function StageSkeleton() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <p className="pulse-soft text-sm text-muted" role="status">
        Loading the 3D view…
      </p>
    </div>
  );
}

function NoWebgl() {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <p className="max-w-xs text-center text-sm text-muted">
        This browser cannot show 3D. The numbers in the panel still place objects exactly, and the
        slice is unaffected.
      </p>
    </div>
  );
}
