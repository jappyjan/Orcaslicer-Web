/**
 * The build plate, full-bleed.
 *
 * All that is left in the WebGL chunk after the layout change: a canvas, the scene that
 * owns it, and the four inputs the scene reconciles against. Every control that used to
 * sit under the canvas is now a panel in the dock (`ObjectPanel`) and edits go through
 * `state/plate-editor.ts`, which keeps three.js out of the first bundle.
 *
 * The finger in here still only moves the camera — one finger orbits, two pan and zoom, a
 * tap selects. That was hard constraint #5's answer to drag gizmos before the canvas took
 * over the screen, and a bigger canvas is not an argument for putting 20px handles on it.
 */

import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';
import type { BufferGeometry } from 'three';
import type { BedSpec } from '@orca-web/shared';
import type { FitProblem, Instance } from '../state/plate.ts';
import { PlaterScene } from '../three/plater-scene.ts';
import { useViewportInsets } from './Workspace.tsx';

/** What the workspace's camera buttons call. */
export interface StageView {
  topView: () => void;
  resetView: () => void;
}

export interface PlaterStageProps {
  bed: BedSpec | null;
  instances: readonly Instance[];
  geometries: ReadonlyMap<string, BufferGeometry>;
  selectedId: string | null;
  problems: ReadonlyMap<string, FitProblem>;
  onSelect: (id: string | null) => void;
  onWebglFailure: (cause: unknown) => void;
  viewRef: RefObject<StageView | null>;
}

export function PlaterStage({
  bed,
  instances,
  geometries,
  selectedId,
  problems,
  onSelect,
  onWebglFailure,
  viewRef,
}: PlaterStageProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<PlaterScene | null>(null);
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const insets = useViewportInsets();

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let scene: PlaterScene;
    try {
      scene = new PlaterScene(canvas, { onSelect: (id) => selectRef.current(id) });
    } catch (cause) {
      // A browser with WebGL disabled or blocklisted still gets a usable app: the dock's
      // numbers are the part that decides where things print.
      onWebglFailure(cause);
      return;
    }
    sceneRef.current = scene;
    viewRef.current = { topView: () => scene.topView(), resetView: () => scene.resetView() };

    const observer = new ResizeObserver(() => scene.resize());
    observer.observe(canvas);
    return () => {
      observer.disconnect();
      sceneRef.current = null;
      viewRef.current = null;
      scene.dispose();
    };
    // Mounted once, deliberately: the scene owns a GL context, and rebuilding it on every
    // state change would drop the camera the user just set up. Everything it needs
    // afterwards arrives through the effects below or through `selectRef`.
  }, []);

  /*
   * The canvas is the whole viewport, but the *visible* part of it is whatever the dock
   * and the bar are not covering. Without this the plate would centre itself behind the
   * bottom sheet on a phone, which is the one way a full-bleed canvas is worse than a
   * boxed one.
   *
   * Declared *before* the bed effect on purpose: on mount both run in declaration order,
   * and `setBed` is what fits the camera — given the insets, it frames the plate into the
   * free rectangle; given zeroes, it frames it into the sheet.
   */
  useEffect(() => {
    sceneRef.current?.setViewport(insets);
  }, [insets]);

  useEffect(() => {
    sceneRef.current?.setBed(bed);
  }, [bed]);

  useEffect(() => {
    sceneRef.current?.sync(instances, geometries, selectedId, problems);
  }, [instances, geometries, selectedId, problems]);

  return (
    <canvas
      ref={canvasRef}
      data-testid="plater-canvas"
      className="block h-full w-full"
      aria-label="Build plate"
    />
  );
}
