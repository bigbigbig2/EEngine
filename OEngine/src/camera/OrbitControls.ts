/**
 * Three.js OrbitControls 的 OEngine 适配实现。
 *
 * 算法来源：three.js examples/jsm/controls/OrbitControls.js（MIT）。
 * 这里保留 OrbitControls 的交互语义和稳定的球坐标/阻尼模型，但把
 * THREE.Camera/Vector3 替换成 OEngine 的 PerspectiveCamera/Transform3D/Vec3，
 * 避免把 three.js 运行时对象带入 OEngine 热路径。
 */

import type { PerspectiveCamera } from "./PerspectiveCamera.js";
import { ChangeSignal } from "../core/Signal.js";
import { hashFloat } from "../core/hashMix.js";
import { Transform3D } from "../core/math/Transform3D.js";
import { Vec3 } from "../core/math/Vec3.js";

const EPS = 1e-6;
const TWO_PI = Math.PI * 2;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** three.js OrbitControls 的距离区间兼容对象。 */
export class NumericInterval {
  readonly onChanged = new ChangeSignal();
  constructor(public min = 0.1, public max = 1000) {}

  get isNumericInterval(): boolean { return true; }
  set(min: number, max: number): this {
    const oldMin = this.min; const oldMax = this.max;
    this.min = min; this.max = max;
    if ((oldMin !== min || oldMax !== max) && this.onChanged.hasHandlers()) this.onChanged.send4(min, max, oldMin, oldMax);
    return this;
  }
  multiplyScalar(value: number): this {
    const min = this.min * value; const max = this.max * value;
    return min <= max ? this.set(min, max) : this.set(max, min);
  }
  normalizeValue(value: number): number { const span = this.max - this.min; return span === 0 ? 0 : (value - this.min) / span; }
  isZero(): boolean { return this.min === 0 && this.max === 0; }
  isExact(): boolean { return this.min === this.max; }
  fromJSON(value: { min: number; max: number }): void { this.set(value.min, value.max); }
  toJSON(): { min: number; max: number } { return { min: this.min, max: this.max }; }
  equals(other: { min: number; max: number }): boolean { return this.min === other.min && this.max === other.max; }
  hash(): number { return (hashFloat(this.min) * 31 + hashFloat(this.max)) | 0; }
  get span(): number { return this.max - this.min; }
  get middle(): number { return (this.min + this.max) * 0.5; }
  computeAverage(): number { return this.middle; }
  static readonly zero_zero = Object.freeze(new NumericInterval(0, 0));
  static readonly zero_one = Object.freeze(new NumericInterval(0, 1));
  static readonly one_one = Object.freeze(new NumericInterval(1, 1));
}

export type OrbitControlsEvent = { readonly type: "change" | "start" | "end" };
export type OrbitControlsListener = (event: OrbitControlsEvent) => void;

type PointerState = { x: number; y: number; pointerType: string };

/**
 * 面向 OEngine Camera 的 OrbitControls。
 *
 * 兼容旧 OrbitalCameraController 的 `look`、`distanceLimits`、
 * `movement_speed_scale` 和 `pointer/keyboard.stop()` 入口；新代码推荐使用
 * three.js 风格的 `minDistance`、`maxDistance`、`enableDamping`、`dispose()`。
 */
export class OrbitControls {
  readonly camera: PerspectiveCamera;
  readonly domElement: HTMLElement;
  readonly target = new Vec3();
  readonly distanceLimits = new NumericInterval();

  enabled = true;
  enableDamping = true;
  dampingFactor = 0.08;
  enableZoom = true;
  zoomSpeed = 1;
  enableRotate = true;
  rotateSpeed = 1;
  enablePan = true;
  panSpeed = 1;
  screenSpacePanning = true;
  keyPanSpeed = 7;
  autoRotate = false;
  autoRotateSpeed = 2;
  minPolarAngle = 0;
  maxPolarAngle = Math.PI;
  minAzimuthAngle = -Infinity;
  maxAzimuthAngle = Infinity;
  minTargetRadius = 0;
  maxTargetRadius = Infinity;

  readonly onChange = new ChangeSignal<OrbitControlsEvent>();
  readonly onStart = new ChangeSignal<OrbitControlsEvent>();
  readonly onEnd = new ChangeSignal<OrbitControlsEvent>();

  /** 旧控制器清理入口；stop() 只停止对应输入源。 */
  readonly pointer = {
    start: (): void => this.connectPointer(),
    stop: (): void => this.disconnectPointer()
  };
  readonly keyboard = {
    start: (): void => this.connectKeyboard(),
    stop: (): void => this.disconnectKeyboard()
  };

  private readonly spherical = { theta: 0, phi: Math.PI / 2, radius: 1 };
  private readonly sphericalDelta = { theta: 0, phi: 0 };
  private scale = 1;
  private readonly panOffset = new Vec3();
  private readonly lastPosition = new Vec3();
  private readonly lastRotation = { x: 0, y: 0, z: 0, w: 1 };
  private readonly pointers = new Map<number, PointerState>();
  private state: "none" | "rotate" | "dolly" | "pan" = "none";
  private touchDistance = 0;
  private touchMidpoint = { x: 0, y: 0 };
  private pointerConnected = false;
  private keyboardConnected = false;
  private readonly keyboardTarget: Document;
  private readonly scratchTransform = new Transform3D();
  private readonly listeners = new Map<string, Set<OrbitControlsListener>>();

  constructor(camera: PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.keyboardTarget = domElement.ownerDocument;
    this.syncFromCamera();
    this.connectPointer();
    this.connectKeyboard();
  }

  get minDistance(): number { return this.distanceLimits.min; }
  set minDistance(value: number) { this.distanceLimits.min = Math.max(0, value); }
  get maxDistance(): number { return this.distanceLimits.max; }
  set maxDistance(value: number) { this.distanceLimits.max = Math.max(this.minDistance, value); }

  /** 旧 API：相机移动速度与 three.js keyPanSpeed 对应。 */
  get movement_speed_scale(): number { return this.keyPanSpeed / 7; }
  set movement_speed_scale(value: number) { this.keyPanSpeed = Math.max(0, value * 7); }

  /** 旧 API：当前球坐标半径。 */
  get distance(): number { return this.spherical.radius; }
  set distance(value: number) { this.spherical.radius = clamp(value, this.minDistance, this.maxDistance); }

  addEventListener(type: OrbitControlsEvent["type"], listener: OrbitControlsListener): void {
    let set = this.listeners.get(type);
    if (set === undefined) { set = new Set(); this.listeners.set(type, set); }
    set.add(listener);
  }

  removeEventListener(type: OrbitControlsEvent["type"], listener: OrbitControlsListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: OrbitControlsEvent["type"]): void {
    const event = { type } as OrbitControlsEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
    if (type === "change") this.onChange.send1(event);
    else if (type === "start") this.onStart.send1(event);
    else this.onEnd.send1(event);
  }

  private readPosition(event: MouseEvent): { x: number; y: number } {
    const rect = this.domElement.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    this.domElement.setPointerCapture?.(event.pointerId);
    const p = this.readPosition(event);
    this.pointers.set(event.pointerId, { ...p, pointerType: event.pointerType });
    if (event.pointerType === "touch") {
      if (this.pointers.size === 1) this.state = "rotate";
      else if (this.pointers.size === 2) {
        this.state = "pan";
        this.updateTouchReference();
      }
    } else if (event.button === 0) {
      this.state = event.ctrlKey || event.metaKey || event.shiftKey ? "pan" : "rotate";
    } else if (event.button === 1) this.state = "dolly";
    else if (event.button === 2) this.state = "pan";
    else return;
    this.dispatch("start");
    event.preventDefault();
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    const previous = this.pointers.get(event.pointerId);
    if (previous === undefined) return;
    const current = this.readPosition(event);
    this.pointers.set(event.pointerId, { ...current, pointerType: previous.pointerType });
    const height = Math.max(1, this.domElement.clientHeight);
    if (event.pointerType === "touch") {
      if (this.pointers.size === 1 && this.state === "rotate" && this.enableRotate) {
        this.rotate((current.x - previous.x) * TWO_PI / height, (current.y - previous.y) * TWO_PI / height);
      } else if (this.pointers.size >= 2) {
        const before = this.touchMidpoint;
        const beforeDistance = this.touchDistance;
        this.updateTouchReference();
        if (this.enablePan) this.pan(this.touchMidpoint.x - before.x, this.touchMidpoint.y - before.y);
        if (this.enableZoom && beforeDistance > EPS && this.touchDistance > EPS) this.dollyOut(this.touchDistance / beforeDistance);
      }
    } else if (this.state === "rotate" && this.enableRotate) {
      this.rotate((current.x - previous.x) * TWO_PI / height, (current.y - previous.y) * TWO_PI / height);
    } else if (this.state === "pan" && this.enablePan) this.pan(current.x - previous.x, current.y - previous.y);
    else if (this.state === "dolly" && this.enableZoom) {
      const deltaY = current.y - previous.y;
      const factor = Math.pow(0.95, this.zoomSpeed * Math.abs(deltaY * 0.01));
      if (deltaY < 0) this.dollyIn(factor);
      else if (deltaY > 0) this.dollyOut(factor);
    }
    event.preventDefault();
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.pointers.delete(event.pointerId)) return;
    this.domElement.releasePointerCapture?.(event.pointerId);
    if (this.pointers.size === 0) {
      this.state = "none";
      this.dispatch("end");
    } else if (event.pointerType === "touch") {
      this.state = "rotate";
      this.updateTouchReference();
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableZoom) return;
    const normalizedDelta = Math.abs(event.deltaY * 0.01);
    const factor = Math.pow(0.95, this.zoomSpeed * normalizedDelta);
    if (event.deltaY < 0) this.dollyIn(factor);
    else if (event.deltaY > 0) this.dollyOut(factor);
    this.dispatch("start");
    this.dispatch("end");
    event.preventDefault();
  };

  private readonly onContextMenu = (event: Event): void => event.preventDefault();

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled || !this.enablePan) return;
    const distance = this.keyPanSpeed * 0.01;
    if (event.key === "ArrowLeft") this.pan(-distance, 0);
    else if (event.key === "ArrowRight") this.pan(distance, 0);
    else if (event.key === "ArrowUp") this.pan(0, -distance);
    else if (event.key === "ArrowDown") this.pan(0, distance);
    else if (event.key.toLowerCase() === "w") this.pan(0, -distance);
    else if (event.key.toLowerCase() === "s") this.pan(0, distance);
    else if (event.key.toLowerCase() === "a") this.pan(-distance, 0);
    else if (event.key.toLowerCase() === "d") this.pan(distance, 0);
    else return;
    event.preventDefault();
  };

  private updateTouchReference(): void {
    const values = [...this.pointers.values()];
    if (values.length < 2) { this.touchDistance = 0; return; }
    const a = values[0]!; const b = values[1]!;
    this.touchMidpoint = { x: (a.x + b.x) * 0.5, y: (a.y + b.y) * 0.5 };
    this.touchDistance = Math.hypot(a.x - b.x, a.y - b.y);
  }

  private connectPointer(): void {
    if (this.pointerConnected) return;
    this.pointerConnected = true;
    this.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.domElement.addEventListener("pointermove", this.onPointerMove);
    this.domElement.addEventListener("pointerup", this.onPointerUp);
    this.domElement.addEventListener("pointercancel", this.onPointerUp);
    this.domElement.addEventListener("wheel", this.onWheel, { passive: false });
    this.domElement.addEventListener("contextmenu", this.onContextMenu);
  }

  private disconnectPointer(): void {
    if (!this.pointerConnected) return;
    this.pointerConnected = false;
    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.domElement.removeEventListener("pointermove", this.onPointerMove);
    this.domElement.removeEventListener("pointerup", this.onPointerUp);
    this.domElement.removeEventListener("pointercancel", this.onPointerUp);
    this.domElement.removeEventListener("wheel", this.onWheel);
    this.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.pointers.clear(); this.state = "none";
  }

  private connectKeyboard(): void {
    if (this.keyboardConnected) return;
    this.keyboardConnected = true;
    this.keyboardTarget.addEventListener("keydown", this.onKeyDown);
  }

  private disconnectKeyboard(): void {
    if (!this.keyboardConnected) return;
    this.keyboardConnected = false;
    this.keyboardTarget.removeEventListener("keydown", this.onKeyDown);
  }

  private rotate(theta: number, phi: number): void {
    this.sphericalDelta.theta -= theta * this.rotateSpeed;
    this.sphericalDelta.phi -= phi * this.rotateSpeed;
  }

  rotateLeft(angle: number): void { this.sphericalDelta.theta -= angle * this.rotateSpeed; }
  rotateUp(angle: number): void { this.sphericalDelta.phi -= angle * this.rotateSpeed; }

  pan(deltaX: number, deltaY: number): void {
    const height = Math.max(1, this.domElement.clientHeight);
    const distance = this.spherical.radius * Math.tan(this.camera.fov * 0.5) / height * 2 * this.panSpeed;
    const matrix = this.camera.transform.matrix;
    // three.js cameras look down local -Z, while OEngine cameras look down local +Z.
    // Flip both screen axes so drag-panning follows the pointer in screen space.
    this.panOffset.x += deltaX * distance * matrix[0]!;
    this.panOffset.y += deltaX * distance * matrix[1]!;
    this.panOffset.z += deltaX * distance * matrix[2]!;
    if (this.screenSpacePanning) {
      this.panOffset.x += deltaY * distance * matrix[4]!;
      this.panOffset.y += deltaY * distance * matrix[5]!;
      this.panOffset.z += deltaY * distance * matrix[6]!;
    } else {
      this.panOffset.y += deltaY * distance;
    }
  }

  dollyIn(scale = 0.95): void { this.scale *= Math.max(scale, EPS); }
  dollyOut(scale = 0.95): void { this.scale /= Math.max(scale, EPS); }

  getPolarAngle(): number { return this.spherical.phi; }
  getAzimuthalAngle(): number { return this.spherical.theta; }

  /** 将外部设置的相机姿态同步回轨道状态。 */
  private syncFromCamera(): void {
    const offset = new Vec3().subVectors(this.camera.transform.position, this.target);
    const radius = Math.max(EPS, offset.length());
    this.spherical.radius = clamp(radius, this.minDistance, this.maxDistance);
    this.spherical.theta = Math.atan2(offset.x, offset.z);
    this.spherical.phi = Math.acos(clamp(offset.y / radius, -1, 1));
    this.lastPosition.copy(this.camera.transform.position);
    this.lastRotation.x = this.camera.transform.rotation.x;
    this.lastRotation.y = this.camera.transform.rotation.y;
    this.lastRotation.z = this.camera.transform.rotation.z;
    this.lastRotation.w = this.camera.transform.rotation.w;
  }

  /** 旧 API：从位置和目标重建 OrbitControls 状态。 */
  look(from: Vec3, to: Vec3): void {
    this.target.copy(to);
    this.camera.transform.position.copy(from);
    this.camera.transform.lookAt(to);
    this.syncFromCamera();
  }

  from_transform(transform: Transform3D): void {
    const target = transform.forward.clone().multiplyScalar(this.spherical.radius).add(transform.position);
    this.look(transform.position, target);
  }

  reset(): void {
    this.sphericalDelta.theta = 0; this.sphericalDelta.phi = 0;
    this.panOffset.set(0, 0, 0); this.scale = 1;
    this.syncFromCamera();
    this.update(0);
  }

  /**
   * 应在每帧 render 前调用。返回值表示相机是否发生变化。
   * `deltaTime` 仅用于 autoRotate/键盘平移，单位为秒。
   */
  update(deltaTime = 1 / 60): boolean {
    if (!this.enabled) return false;
    const externalChange = !this.lastPosition.equals(this.camera.transform.position) ||
      this.lastRotation.x !== this.camera.transform.rotation.x ||
      this.lastRotation.y !== this.camera.transform.rotation.y ||
      this.lastRotation.z !== this.camera.transform.rotation.z ||
      this.lastRotation.w !== this.camera.transform.rotation.w;
    if (externalChange && this.sphericalDelta.theta === 0 && this.sphericalDelta.phi === 0 && this.scale === 1 && this.panOffset.isZero()) {
      this.syncFromCamera();
    }
    if (this.autoRotate) this.sphericalDelta.theta -= (TWO_PI / 60 / 60) * this.autoRotateSpeed * (deltaTime * 60);
    const damping = this.enableDamping ? clamp(this.dampingFactor, 0, 1) : 1;
    const oldPosition = this.lastPosition.clone();
    this.spherical.theta += this.sphericalDelta.theta * damping;
    this.spherical.phi += this.sphericalDelta.phi * damping;
    this.spherical.theta = clamp(this.spherical.theta, this.minAzimuthAngle, this.maxAzimuthAngle);
    this.spherical.phi = clamp(this.spherical.phi, Math.max(EPS, this.minPolarAngle), Math.min(Math.PI - EPS, this.maxPolarAngle));
    this.spherical.radius = clamp(this.spherical.radius * (1 + (this.scale - 1) * damping), this.minDistance, this.maxDistance);
    this.target.addScaled(this.panOffset, damping);
    const targetOffset = new Vec3().subVectors(this.target, Vec3.zero);
    const targetLength = targetOffset.length();
    if (targetLength > this.maxTargetRadius) this.target.multiplyScalar(this.maxTargetRadius / targetLength);
    if (targetLength < this.minTargetRadius && targetLength > EPS) this.target.multiplyScalar(this.minTargetRadius / targetLength);
    const offset = new Vec3().setFromSphericalCoords(this.spherical.radius, this.spherical.phi, this.spherical.theta);
    this.scratchTransform.copy(this.camera.transform);
    this.scratchTransform.position.copy(this.target).add(offset);
    this.scratchTransform.lookAt(this.target);
    this.camera.transform.copy(this.scratchTransform);
    this.camera.update();
    this.lastPosition.copy(this.camera.transform.position);
    this.lastRotation.x = this.camera.transform.rotation.x;
    this.lastRotation.y = this.camera.transform.rotation.y;
    this.lastRotation.z = this.camera.transform.rotation.z;
    this.lastRotation.w = this.camera.transform.rotation.w;
    this.sphericalDelta.theta *= 1 - damping;
    this.sphericalDelta.phi *= 1 - damping;
    this.panOffset.multiplyScalar(1 - damping);
    this.scale = 1 + (this.scale - 1) * (1 - damping);
    const changed = oldPosition.distanceTo(this.lastPosition) > EPS || externalChange;
    if (changed) this.dispatch("change");
    return changed;
  }

  dispose(): void {
    this.disconnectPointer();
    this.disconnectKeyboard();
    this.listeners.clear();
    this.onChange.removeAll(); this.onStart.removeAll(); this.onEnd.removeAll();
  }
}
