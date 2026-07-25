/**
 * The toolpath, full-bleed.
 *
 * The WebGL half of M5's preview: a canvas, the scene, and the controller that keeps a
 * window of layers in memory and nothing else. What is *not* here is anything that reacts
 * to the window — the sliders, the legend and the byte counts are ordinary React in the
 * dock, and the geometry never passes through a render.
 *
 * The budget is unchanged by the new layout: a 40 MB G-code opens on a 4 GB phone because
 * `PreviewController` fetches the difference between two windows and disposes what scrolls
 * out before it fetches what scrolls in.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { BedSpec } from '@orca-web/shared';
import type { PreviewIndex } from '@orca-web/gcode';
import type { ColourMode, LayerWindow } from '../state/preview.ts';
import { PreviewScene } from '../three/preview-scene.ts';
import { PreviewController, type PreviewStatus } from '../three/preview-controller.ts';
import { useViewportInsets } from './Workspace.tsx';
import type { StageView } from './PlaterStage.tsx';

export interface PreviewStageProps {
  jobId: string;
  plate: number;
  index: PreviewIndex;
  bed: BedSpec | null;
  window: LayerWindow;
  mode: ColourMode;
  onStatus: (status: PreviewStatus) => void;
  onWebglFailure: (cause: unknown) => void;
  viewRef: RefObject<StageView | null>;
  /** Set to a function that re-runs the last failed fetch, or to null. */
  retryRef: RefObject<(() => void) | null>;
}

export function PreviewStage({
  jobId,
  plate,
  index,
  bed,
  window: layerWindow,
  mode,
  onStatus,
  onWebglFailure,
  viewRef,
  retryRef,
}: PreviewStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PreviewScene | null>(null);
  const controllerRef = useRef<PreviewController | null>(null);
  const insets = useViewportInsets();
  /** The window at mount time, read without making the scene depend on it. */
  const windowRef = useRef(layerWindow);
  windowRef.current = layerWindow;
  const statusRef = useRef(onStatus);
  statusRef.current = onStatus;
  const insetsRef = useRef(insets);
  insetsRef.current = insets;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: PreviewScene;
    try {
      scene = new PreviewScene(canvas);
    } catch (cause) {
      onWebglFailure(cause);
      return;
    }
    sceneRef.current = scene;
    scene.setBed(bed);
    // VERIFIED DEVIATION #15: G-code X/Y are plate X/Y minus `extruder_offset`. Without
    // this the whole toolpath sits 2 mm off the objects it belongs to on a stock X1C.
    scene.setExtruderOffset(bed?.extruderOffset ?? [0, 0]);
    scene.setIndex(index);
    scene.setViewport(insetsRef.current);

    const start = windowRef.current;
    scene.frameToolpath(index, start);
    const controller = new PreviewController(scene, jobId, plate, index, start, (status) =>
      statusRef.current(status),
    );
    controllerRef.current = controller;
    controller.setColourMode(mode);
    viewRef.current = { topView: () => scene.topView(), resetView: () => scene.resetView() };
    retryRef.current = () => controller.retry();

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      controller.dispose();
      controllerRef.current = null;
      sceneRef.current = null;
      viewRef.current = null;
      retryRef.current = null;
      scene.dispose();
    };
    // Built once per index. The window and the colour mode are read through refs rather
    // than taken as dependencies: changing either must move the window, not tear down a
    // GL context.
  }, [index, jobId, plate, bed]);

  // The scene is given the insets before `frameToolpath` runs, above; this keeps them in
  // step afterwards, when the sheet moves.
  useEffect(() => {
    sceneRef.current?.setViewport(insets);
  }, [insets]);

  useEffect(() => {
    controllerRef.current?.setWindow(layerWindow);
  }, [layerWindow]);

  useEffect(() => {
    controllerRef.current?.setColourMode(mode);
  }, [mode]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="preview-canvas"
      className="block h-full w-full"
      aria-label="G-code toolpath"
    />
  );
}
