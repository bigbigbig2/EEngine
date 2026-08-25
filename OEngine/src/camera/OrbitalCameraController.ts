/**
 * 轨道相机控制器：统一处理鼠标、触摸和键盘输入，并更新环绕、平移与缩放状态。
 */

import type { PerspectiveCamera } from "./PerspectiveCamera.js";
import { ChangeSignal } from "../core/Signal.js";
import { hashFloat } from "../core/hashMix.js";
import { Transform3D } from "../core/math/Transform3D.js";
import { Vec2 } from "../core/math/Vec2.js";
import { Vec3 } from "../core/math/Vec3.js";

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function lerp(a: number, b: number, t: number): number {
  return (b - a) * t + a;
}

const timeSource = typeof performance === "undefined" ? Date : performance;

function nowSeconds(): number {
  return 0.001 * timeSource.now();
}

function hermite(
  t: number,
  value0: number,
  value1: number,
  tangent0: number,
  tangent1: number
): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return (
    (2 * t3 - 3 * t2 + 1) * value0 +
    (t3 - 2 * t2 + t) * tangent0 +
    (t3 - t2) * tangent1 +
    (3 * t2 - 2 * t3) * value1
  );
}

function evaluateZoomCurve(value: number): number {
  if (value <= 0) return 0.01;
  if (value >= 1) return 1;
  if (value < 0.5) {
    const t = value / 0.5;
    return hermite(t, 0.01, 0.2, 0.38 * 0.5, 0.38 * 0.5);
  }
  const t = (value - 0.5) / 0.5;
  return hermite(t, 0.2, 1, 1.6 * 0.5, 1.6 * 0.5);
}

export class NumericInterval {
  readonly onChanged = new ChangeSignal();

  constructor(
    public min = Number.NEGATIVE_INFINITY,
    public max = Number.POSITIVE_INFINITY
  ) {}

  get isNumericInterval(): boolean {
    return true;
  }

  set(min: number, max: number): this {
    const oldMin = this.min;
    const oldMax = this.max;
    if (min === oldMin && max === oldMax) return this;
    this.min = min;
    this.max = max;
    if (this.onChanged.hasHandlers()) {
      this.onChanged.send4(min, max, oldMin, oldMax);
    }
    return this;
  }

  multiplyScalar(value: number): this {
    const min = this.min * value;
    const max = this.max * value;
    return min > max ? this.set(max, min) : this.set(min, max);
  }

  normalizeValue(value: number): number {
    const span = this.max - this.min;
    return span === 0 ? 0 : (value - this.min) / span;
  }

  isZero(): boolean {
    return this.min === 0 && this.max === 0;
  }

  isExact(): boolean {
    return this.min === this.max;
  }

  sampleRandom(random: () => number): number {
    return this.min + random() * (this.max - this.min);
  }

  fromJSON(value: { min: number; max: number }): void {
    this.set(value.min, value.max);
  }

  toJSON(): { min: number; max: number } {
    return { min: this.min, max: this.max };
  }

  fromArray(source: ArrayLike<number>, offset = 0): this {
    return this.set(source[offset] as number, source[offset + 1] as number);
  }

  toArray(target: number[] = [], offset = 0): number[] {
    target[offset] = this.min;
    target[offset + 1] = this.max;
    return target;
  }

  toString(): string {
    return `NumericInterval{ min=${this.min}, max=${this.max} }`;
  }

  toBinaryBuffer(buffer: { writeFloat64(value: number): void }): void {
    buffer.writeFloat64(this.min);
    buffer.writeFloat64(this.max);
  }

  fromBinaryBuffer(buffer: { readFloat64(): number }): void {
    this.min = buffer.readFloat64();
    this.max = buffer.readFloat64();
  }

  copy(other: { min: number; max: number }): this {
    return this.set(other.min, other.max);
  }

  union(other: { min: number; max: number }): this {
    return this.set(
      Math.min(this.min, other.min),
      Math.max(this.max, other.max)
    );
  }

  overlaps(other: { min: number; max: number }): boolean {
    return this.min < other.max && this.max > other.min;
  }

  contains(other: { min: number; max: number }): boolean {
    return this.min <= other.min && this.max >= other.max;
  }

  equals(other: { min: number; max: number }): boolean {
    return this.min === other.min && this.max === other.max;
  }

  hash(): number {
    let hash = hashFloat(this.min);
    hash = (hash << 5) - hash + hashFloat(this.max);
    return hash | 0;
  }

  get span(): number {
    return this.max - this.min;
  }

  get middle(): number {
    return 0.5 * (this.max + this.min);
  }

  computeAverage(): number {
    return this.middle;
  }

  static readonly zero_zero = Object.freeze(new NumericInterval(0, 0));
  static readonly zero_one = Object.freeze(new NumericInterval(0, 1));
  static readonly one_one = Object.freeze(new NumericInterval(1, 1));
}

export class ButtonState {
  readonly down = new ChangeSignal();
  readonly up = new ChangeSignal();
  is_down = false;

  get is_up(): boolean {
    return !this.is_down;
  }

  press(): void {
    if (this.is_down) return;
    this.is_down = true;
    this.down.send0();
  }

  release(): void {
    if (!this.is_down) return;
    this.is_down = false;
    this.up.send0();
  }
}

export const KEY_CODE_MAP: Record<string, number> = {
  backspace: 8,
  tab: 9,
  enter: 13,
  shift: 16,
  ctrl: 17,
  alt: 18,
  pause_break: 19,
  caps_lock: 20,
  escape: 27,
  space: 32,
  page_up: 33,
  page_down: 34,
  end: 35,
  home: 36,
  left_arrow: 37,
  up_arrow: 38,
  right_arrow: 39,
  down_arrow: 40,
  insert: 45,
  delete: 46,
  "0": 48,
  "1": 49,
  "2": 50,
  "3": 51,
  "4": 52,
  "5": 53,
  "6": 54,
  "7": 55,
  "8": 56,
  "9": 57,
  a: 65,
  b: 66,
  c: 67,
  d: 68,
  e: 69,
  f: 70,
  g: 71,
  h: 72,
  i: 73,
  j: 74,
  k: 75,
  l: 76,
  m: 77,
  n: 78,
  o: 79,
  p: 80,
  q: 81,
  r: 82,
  s: 83,
  t: 84,
  u: 85,
  v: 86,
  w: 87,
  x: 88,
  y: 89,
  z: 90,
  "left_window key": 91,
  "right_window key": 92,
  select_key: 93,
  numpad_0: 96,
  numpad_1: 97,
  numpad_2: 98,
  numpad_3: 99,
  numpad_4: 100,
  numpad_5: 101,
  numpad_6: 102,
  numpad_7: 103,
  numpad_8: 104,
  numpad_9: 105,
  multiply: 106,
  add: 107,
  subtract: 109,
  decimal_point: 110,
  divide: 111,
  f1: 112,
  f2: 113,
  f3: 114,
  f4: 115,
  f5: 116,
  f6: 117,
  f7: 118,
  f8: 119,
  f9: 120,
  f10: 121,
  f11: 122,
  f12: 123,
  num_lock: 144,
  scroll_lock: 145,
  semi_colon: 186,
  equal_sign: 187,
  comma: 188,
  dash: 189,
  period: 190,
  forward_slash: 191,
  grave_accent: 192,
  open_bracket: 219,
  backslash: 220,
  close_bracket: 221,
  single_quote: 222,
  back_quote: 223
};

const KEY_CODE_TO_NAME: string[] = [];

function isInstanceOf(value: unknown, type: Function): boolean {
  return value != null && typeof value === "object" && value instanceof type;
}

export class KeyboardInput {
  readonly on = { down: new ChangeSignal(), up: new ChangeSignal() };
  readonly keys: Record<string, ButtonState> = {};
  domElement: HTMLElement;

  constructor(element: HTMLElement) {
    void (
      isInstanceOf(element, HTMLInputElement) ||
      isInstanceOf(element, HTMLSelectElement) ||
      isInstanceOf(element, HTMLTextAreaElement) ||
      isInstanceOf(element, HTMLAnchorElement) ||
      isInstanceOf(element, HTMLButtonElement) ||
      isInstanceOf(element, HTMLAreaElement) ||
      element.getAttribute("tabindex")
    );
    this.domElement = element;
    for (const name in KEY_CODE_MAP) {
      KEY_CODE_TO_NAME[KEY_CODE_MAP[name]!] = name;
      this.keys[name] = new ButtonState();
    }
  }

  readonly #onKeyDown = (event: KeyboardEvent): void => {
    if (event.repeat) return;
    this.on.down.send1(event);
    let prevent = false;
    const name = KEY_CODE_TO_NAME[event.keyCode];
    if (name !== undefined) {
      const key = this.keys[name]!;
      key.press();
      if (key.down.hasHandlers()) prevent = true;
    }
    if (prevent) event.preventDefault();
  };

  readonly #onKeyUp = (event: KeyboardEvent): void => {
    this.on.up.send1(event);
    let prevent = false;
    const name = KEY_CODE_TO_NAME[event.keyCode];
    if (name !== undefined) {
      const key = this.keys[name]!;
      key.release();
      if (key.down.hasHandlers()) prevent = true;
    }
    if (prevent) event.preventDefault();
  };

  readonly #releaseAll = (): void => {
    for (const name in KEY_CODE_MAP) this.keys[name]!.release();
  };

  start(): void {
    const element = this.domElement;
    element.addEventListener("keydown", this.#onKeyDown);
    element.addEventListener("keyup", this.#onKeyUp);
    element.addEventListener("blur", this.#releaseAll);
    element.addEventListener("focusout", this.#releaseAll);
    window.addEventListener("blur", this.#releaseAll);
  }

  stop(): void {
    const element = this.domElement;
    element.removeEventListener("keydown", this.#onKeyDown);
    element.removeEventListener("keyup", this.#onKeyUp);
    element.removeEventListener("blur", this.#releaseAll);
    element.removeEventListener("focusout", this.#releaseAll);
    window.removeEventListener("blur", this.#releaseAll);
  }
}

class PointerSample {
  readonly timestamp = nowSeconds();
  readonly position = new Vec2();

  static from(position: Vec2): PointerSample {
    const sample = new PointerSample();
    sample.position.copy(position);
    return sample;
  }
}

function suppressContextMenu(event: Event): false {
  event.preventDefault();
  event.stopPropagation();
  return false;
}

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

export class PointerInput {
  readonly position = new Vec2();
  readonly on = {
    down: new ChangeSignal(),
    up: new ChangeSignal(),
    move: new ChangeSignal(),
    tap: new ChangeSignal(),
    drag: new ChangeSignal(),
    dragStart: new ChangeSignal(),
    dragEnd: new ChangeSignal(),
    wheel: new ChangeSignal(),
    pinch: new ChangeSignal(),
    pinchStart: new ChangeSignal(),
    pinchEnd: new ChangeSignal()
  };
  readonly buttons = new Array<ButtonState>(32);
  isRunning = false;

  readonly #pointerEnded = new ChangeSignal();
  #targetElement: EventTarget | null = null;
  #domElement: HTMLElement | null;

  constructor(element: HTMLElement | null) {
    for (let index = 0; index < this.buttons.length; index++) {
      this.buttons[index] = new ButtonState();
    }
    this.#domElement = element;
    this.#installTapGesture();
    this.#installDragGesture();
  }

  get mouseButtonLeft(): ButtonState {
    return this.buttons[0]!;
  }

  get mouseButtonRight(): ButtonState {
    return this.buttons[2]!;
  }

  get mouseButtonMiddle(): ButtonState {
    return this.buttons[1]!;
  }

  #installTapGesture(): void {
    const active = new Map<number, PointerSample>();
    const cancel = (pointerId: number): void => {
      if (active.delete(pointerId)) {
        this.on.up.remove(onUp);
        this.on.move.remove(onMove);
      }
    };
    const onUp = (position: Vec2, event: PointerEvent): void => {
      const pointerId = event.pointerId;
      const sample = active.get(pointerId);
      if (sample !== undefined) {
        cancel(pointerId);
        if (nowSeconds() - sample.timestamp <= 1) {
          this.on.tap.send2(position, event);
        }
      } else {
        console.warn("Unregistered up event handler");
      }
    };
    const onMove = (position: Vec2, event: PointerEvent): void => {
      const pointerId = event.pointerId;
      const sample = active.get(pointerId);
      if (sample === undefined) {
        console.warn("Unregistered move event handler");
        cancel(pointerId);
        return;
      }
      if (sample.position.distanceTo(position) > 10) cancel(pointerId);
    };
    this.on.down.add((position: Vec2, event: PointerEvent) => {
      const pointerId = event.pointerId;
      cancel(pointerId);
      active.set(pointerId, PointerSample.from(position));
      this.on.up.addOne(onUp);
      this.on.move.add(onMove);
    });
  }

  #installDragGesture(): void {
    const start = new Vec2();
    const previous = new Vec2();
    const cancelBeforeDrag = (): void => {
      this.#pointerEnded.remove(cancelBeforeDrag);
      this.on.move.remove(beginDrag);
    };
    const endDrag = (position: Vec2): void => {
      this.#pointerEnded.remove(endDrag);
      this.on.move.remove(drag);
      this.on.dragEnd.send1(position);
    };
    const beginDrag = (position: Vec2, event: PointerEvent): void => {
      this.on.move.remove(beginDrag);
      this.on.move.add(drag);
      this.#pointerEnded.remove(cancelBeforeDrag);
      this.#pointerEnded.add(endDrag);
      previous.copy(start);
      this.on.dragStart.send2(start, event);
      drag(position, event);
    };
    const drag = (position: Vec2, event: PointerEvent): void => {
      this.on.drag.send4(position, start, previous, event);
      previous.copy(position);
    };
    this.on.down.add((position: Vec2) => {
      start.copy(position);
      this.#pointerEnded.add(cancelBeforeDrag);
      this.on.move.add(beginDrag);
    });
  }

  readonly #onPointerDown = (event: PointerEvent): void => {
    const element = this.#domElement;
    if (element && !element.hasPointerCapture(event.pointerId)) {
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
      }
    }
    this.readPointerPositionFromEvent(this.position, event);
    this.buttons[event.button]?.press();
    this.on.down.send2(this.position, event);
  };

  readonly #onElementPointerUp = (event: PointerEvent): void => {
    this.readPointerPositionFromEvent(this.position, event);
    this.on.up.send2(this.position, event);
  };

  readonly #onWindowPointerUp = (event: PointerEvent): void => {
    this.readPointerPositionFromEvent(this.position, event);
    this.#pointerEnded.send2(this.position, event);
    this.buttons[event.button]?.release();
    const element = this.#domElement;
    if (element?.hasPointerCapture(event.pointerId)) {
      element.releasePointerCapture(event.pointerId);
    }
  };

  readonly #onWheel = (event: WheelEvent): void => {
    event.preventDefault();
    const delta = new Vec3(
      sign(event.deltaX),
      sign(event.deltaY),
      sign(event.deltaZ)
    );
    this.readPointerPositionFromEvent(this.position, event);
    this.on.wheel.send3(delta, this.position, event);
  };

  readonly #onPointerMove = (event: PointerEvent): void => {
    event.preventDefault();
    this.#targetElement = event.target;
    this.readPointerPositionFromEvent(this.position, event);
    this.on.move.send3(
      this.position,
      event,
      new Vec2(event.movementX, event.movementY)
    );
  };

  getTargetElement(): EventTarget | null {
    return this.#targetElement;
  }

  set domElement(element: HTMLElement | null) {
    if (this.#domElement === element) return;
    const running = this.isRunning;
    if (running) this.stop();
    this.#domElement = element;
    if (running) this.start();
  }

  get domElement(): HTMLElement | null {
    return this.#domElement;
  }

  readPointerPositionFromEvent(
    target: Vec2,
    event: MouseEvent,
    element: EventTarget | null = event.target
  ): void {
    let x = event.clientX;
    let y = event.clientY;
    if (
      element !== null &&
      typeof (element as { getBoundingClientRect?: unknown }).getBoundingClientRect ===
        "function"
    ) {
      const bounds = (element as HTMLElement).getBoundingClientRect();
      y -= bounds.top;
      x -= bounds.left;
    }
    target.set(x, y);
  }

  start(): void {
    if (this.isRunning) return;
    this.isRunning = true;
    const element = this.#domElement!;
    element.addEventListener("pointermove", this.#onPointerMove);
    element.addEventListener("pointerup", this.#onElementPointerUp);
    element.addEventListener("pointerdown", this.#onPointerDown);
    window.addEventListener("pointerup", this.#onWindowPointerUp);
    element.addEventListener("wheel", this.#onWheel, { passive: false });
    element.addEventListener("contextmenu", suppressContextMenu);
  }

  stop(): void {
    if (!this.isRunning) return;
    this.isRunning = false;
    const element = this.domElement!;
    element.removeEventListener("pointermove", this.#onPointerMove);
    element.removeEventListener("pointerup", this.#onElementPointerUp);
    element.removeEventListener("pointerdown", this.#onPointerDown);
    window.removeEventListener("pointerup", this.#onWindowPointerUp);
    element.removeEventListener("wheel", this.#onWheel);
    element.removeEventListener("contextmenu", suppressContextMenu);
  }
}

const scratchTransform = new Transform3D();

export class OrbitalCameraController {
  pointer = new PointerInput(null);
  keyboard = new KeyboardInput(document.body);
  camera: PerspectiveCamera;
  rotation_delta = new Float32Array(2);
  pan_offset = new Vec3();
  spherical = new Float32Array([0, 0, 0]);
  movement_speed_scale = 1;
  distanceLimits = new NumericInterval(0.1, 1000);
  distance = 1;
  distance_delta = 0;
  target = new Vec3();

  readonly #previousTransform = new Transform3D();
  #lastUpdateTime = 0;

  constructor(camera: PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.pointer.domElement = domElement;
    this.pointer.start();
    this.keyboard.domElement = domElement;
    this.keyboard.start();
    this.from_transform(camera.transform);

    this.pointer.on.drag.add(
      (position: Vec2, _start: Vec2, previous: Vec2): void => {
        const delta = previous.clone().sub(position);
        const radiansPerPixel = (2 * Math.PI) / domElement.clientHeight;
        if (this.pointer.mouseButtonRight.is_down) {
          this.pan(delta.x, delta.y);
        } else {
          this.rotation_delta[1]! += delta.x * radiansPerPixel;
          this.rotation_delta[0]! += delta.y * radiansPerPixel;
        }
      }
    );
    this.pointer.on.wheel.add((delta: Vec3): void => {
      const normalized = clamp01(
        this.distanceLimits.normalizeValue(this.distance)
      );
      let selected = delta.x;
      if (Math.abs(delta.y) > Math.abs(selected)) selected = delta.y;
      if (Math.abs(delta.z) > Math.abs(selected)) selected = delta.z;
      const sensitivity = evaluateZoomCurve(normalized);
      this.distance_delta +=
        0.01 * selected * sensitivity * this.distanceLimits.span;
    });
  }

  look(from: Vec3, to: Vec3): void {
    this.target.copy(to);
    const distance = Vec3.distance(from, to);
    this.distance = distance;
    const vertical = from.y - to.y;
    let azimuth = 0;
    let polar = 0;
    if (distance > 1e-9) {
      azimuth = Math.atan2(from.x - to.x, from.z - to.z);
      polar = Math.acos(clamp(vertical / distance, -1, 1));
    }
    this.spherical[0] = polar;
    this.spherical[1] = azimuth;
    this.spherical[2] = distance;
    this.#previousTransform.copy(this.camera.transform);
  }

  from_transform(transform: Transform3D): void {
    const target = new Vec3();
    target.copy(transform.forward);
    target.multiplyScalar(this.distance);
    target.add(transform.position);
    this.look(transform.position, target);
  }

  #panRight(amount: number, matrix: Float32Array): void {
    this.pan_offset[0] = this.pan_offset[0]! - amount * matrix[0]!;
    this.pan_offset[1] = this.pan_offset[1]! - amount * matrix[1]!;
    this.pan_offset[2] = this.pan_offset[2]! - amount * matrix[2]!;
  }

  #panUp(amount: number, matrix: Float32Array): void {
    this.pan_offset[0] = this.pan_offset[0]! - amount * matrix[4]!;
    this.pan_offset[1] = this.pan_offset[1]! - amount * matrix[5]!;
    this.pan_offset[2] = this.pan_offset[2]! - amount * matrix[6]!;
  }

  pan(delta_x: number, delta_y: number): void {
    const position = this.camera.transform.position;
    const offset = new Vec3();
    offset.copy(position);
    offset.sub(this.target);
    const extent = offset.length() * Math.tan(this.camera.fov / 2);
    const element = this.pointer.domElement!;
    const matrix = this.camera.transform.matrix;
    this.#panRight((2 * delta_x * extent) / element.clientHeight, matrix);
    this.#panUp((2 * delta_y * extent) / element.clientHeight, matrix);
  }

  get #movementSpeed(): number {
    const scale = lerp(
      1,
      2,
      clamp01(this.distanceLimits.normalizeValue(this.distance))
    );
    return this.movement_speed_scale * scale;
  }

  #applyKeyboard(deltaTime: number): void {
    const direction = new Vec3(
      (this.keyboard.keys.a!.is_down ? 1 : 0) +
        (this.keyboard.keys.d!.is_down ? -1 : 0),
      0,
      (this.keyboard.keys.w!.is_down ? 1 : 0) +
        (this.keyboard.keys.s!.is_down ? -1 : 0)
    );
    if (direction.isZero()) return;
    const distance = direction.length() * this.#movementSpeed * deltaTime;
    direction.normalize();
    const matrix = this.camera.transform.matrix;
    const x = matrix[0]! * direction.x + matrix[4]! * direction.y + matrix[8]! * direction.z;
    const y = matrix[1]! * direction.x + matrix[5]! * direction.y + matrix[9]! * direction.z;
    const z = matrix[2]! * direction.x + matrix[6]! * direction.y + matrix[10]! * direction.z;
    const length = Math.hypot(x, y, z);
    const worldDirection = new Vec3();
    if (length > 1e-7) {
      const inverse = 1 / length;
      worldDirection.set(x * inverse, y * inverse, z * inverse);
    } else {
      worldDirection.set(0, 0, 0);
    }
    worldDirection.multiplyScalar(distance);
    this.pan_offset.add(worldDirection);
  }

  update(): void {
    const time = nowSeconds();
    const deltaTime = time - this.#lastUpdateTime;
    this.#applyKeyboard(deltaTime);
    this.#lastUpdateTime = time;

    const transform = this.camera.transform;
    if (this.#previousTransform.equals(transform)) {
      this.distance += this.distance_delta;
      this.distance = clamp(
        this.distance,
        this.distanceLimits.min,
        this.distanceLimits.max
      );
      this.spherical[0]! += this.rotation_delta[0]!;
      this.spherical[1]! += this.rotation_delta[1]!;
      const epsilon = 1e-6;
      this.spherical[0] = Math.max(
        epsilon,
        Math.min(Math.PI - epsilon, this.spherical[0]!)
      );
      const polar = this.spherical[0]!;
      const azimuth = this.spherical[1]!;
      const radius = this.distance;
      const horizontal = Math.sin(polar) * radius;
      const offset = new Vec3(
        horizontal * Math.sin(azimuth),
        Math.cos(polar) * radius,
        horizontal * Math.cos(azimuth)
      );
      this.target.add(this.pan_offset);
      scratchTransform.copy(transform);
      scratchTransform.position.copy(this.target);
      scratchTransform.position.add(offset);
      scratchTransform.lookAt(this.target);
      transform.copy(scratchTransform);
    } else {
      this.from_transform(transform);
    }

    this.rotation_delta[0] = 0;
    this.rotation_delta[1] = 0;
    this.distance_delta = 0;
    this.pan_offset.set(0, 0, 0);
    this.#previousTransform.copy(transform);
  }
}
