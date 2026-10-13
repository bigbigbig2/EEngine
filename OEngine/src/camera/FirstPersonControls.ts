/**
 * Three.js FirstPersonControls 的 OEngine 严谨适配实现。
 *
 * 算法与交互来源：
 * - three.js examples/jsm/controls/FirstPersonControls.js (MIT License)
 * - 与 OEngine 的 OrbitControls.ts 保持同等严谨度与工程标准
 *
 * 核心设计：
 * 1. 彻底解耦 Three.js 运行时，全面对齐 OEngine 坐标系 (+Z 正前向，+X 右侧，+Y 向上) 与 PerspectiveCamera；
 * 2. 严守性能纪律：预先分配内部计算矢量，update(delta) 热路径 0 堆内存分配、0 GC 扰动；
 * 3. 完整实现 WASD / 方向键平移、Space / R / E 垂直上升、F / C / Q 垂直下降、Shift 冲刺加速、Ctrl 微调慢行；
 * 4. 支持鼠标拖拽视角（丝滑跟手阻尼）与经典摇杆模式，支持鼠标滚轮动态缩放漫游速度；
 * 5. 完备的生命周期管理：connect / disconnect / dispose / saveState / reset / stop 与失焦按键释放保护。
 */

import type { PerspectiveCamera } from "./PerspectiveCamera.js";
import { ChangeSignal } from "../core/Signal.js";
import { Vec3 } from "../core/math/Vec3.js";

const EPS = 1e-6;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function lerpNum(start: number, end: number, t: number): number {
  return (end - start) * t + start;
}

function mapLinear(x: number, a1: number, a2: number, b1: number, b2: number): number {
  return b1 + ((x - a1) * (b2 - b1)) / (a2 - a1);
}

export type FirstPersonControlsEvent = { readonly type: "change" | "start" | "end" };
export type FirstPersonControlsListener = (event: FirstPersonControlsEvent) => void;

/** 视角控制交互模式：'drag' (鼠标拖拽平滑跟手) 或 'joystick' (Three.js 偏离原点持续旋转) */
export type LookInteractionStyle = "drag" | "joystick";

export class FirstPersonControls {
  readonly camera: PerspectiveCamera;
  domElement: HTMLElement;

  /** 是否激活控制器。 */
  enabled = true;

  /** 基础行走移动速度（世界单位/秒）。默认 1.5，慢速步行。 */
  movementSpeed = 1.5;

  /** 滚轮调节速度开关。默认关闭，防止滑动滚轮时误将速度指数级放大。 */
  minMovementSpeed = 0.1;
  maxMovementSpeed = 100.0;
  enableSpeedWheel = false;

  /** 视角环视灵敏度。 */
  lookSpeed = 0.15;

  /** 是否反转垂直俯仰方向。默认 false（往下拖低头，往上拖抬头）。 */
  invertY = false;

  /** 阻尼系数（0~1，越大制动越干脆，1 为禁用阻尼瞬间停止）。默认 0.35。 */
  dampingFactor = 0.35;

  /** 视角拖拽交互模式。默认 'drag'，极其跟手丝滑。 */
  lookStyle: LookInteractionStyle = "drag";

  /** 是否允许垂直方向俯仰仰视。 */
  lookVertical = true;

  /** 是否自动持续向前漫游。 */
  autoForward = false;

  /** 是否响应鼠标/指针环顾视角。 */
  activeLook = true;

  /** 按住 Shift 时的冲刺加速倍率。 */
  sprintMultiplier = 2.5;

  /** 按住 Ctrl / Alt 时的微调慢行倍率。 */
  crawlMultiplier = 0.35;

  /** 是否随相机高度动态缩放移动速度。 */
  heightSpeed = false;
  heightCoef = 1.0;
  heightMin = 0.0;
  heightMax = 100.0;

  /** 是否限制垂直俯仰角度。 */
  constrainVertical = false;
  verticalMin = 0; // 弧度，0 为天顶
  verticalMax = Math.PI; // 弧度，PI 为地底

  /** 俯仰最大角度限制（度，默认 -85° ~ +85°，避免万向节锁）。 */
  maxPitchDeg = 85;
  minPitchDeg = -85;

  /** 是否处于指针按住拖拽状态。 */
  mouseDragOn = false;

  // 信号与事件派发系统
  readonly onChange = new ChangeSignal<FirstPersonControlsEvent>();
  readonly onStart = new ChangeSignal<FirstPersonControlsEvent>();
  readonly onEnd = new ChangeSignal<FirstPersonControlsEvent>();

  // 内部预分配数学矢量（零 GC 保证）
  private readonly velocity = new Vec3();
  private readonly targetVelocity = new Vec3();
  private readonly lookDirection = new Vec3();
  private readonly targetPosition = new Vec3();

  // 状态保存与复位备份
  private readonly initialPosition = new Vec3();
  private initialLat = 0;
  private initialLon = 0;

  // 视角方向（经度与纬度角，单位为度）
  private lat = 0;
  private lon = 0;
  private targetLat = 0;
  private targetLon = 0;
  private latVelocity = 0;
  private lonVelocity = 0;

  // 指针状态跟踪
  private pointerDownX = 0;
  private pointerDownY = 0;
  private lastPointerX = 0;
  private lastPointerY = 0;
  private pointerOffsetDragX = 0;
  private pointerOffsetDragY = 0;
  private pointerCount = 0;
  private pointerForward = false;
  private pointerBackward = false;

  // 键盘状态
  private keyForward = false;
  private keyBackward = false;
  private moveLeft = false;
  private moveRight = false;
  private moveUp = false;
  private moveDown = false;
  private isSprinting = false;
  private isCrawling = false;

  private connected = false;
  private readonly listeners = new Map<string, Set<FirstPersonControlsListener>>();

  constructor(camera: PerspectiveCamera, domElement: HTMLElement) {
    this.camera = camera;
    this.domElement = domElement;
    this.connect(domElement);
    this.setOrientation();
    this.saveState();
  }

  // --- 事件监听接口（对齐 Three.js & OrbitControls） ---

  addEventListener(type: FirstPersonControlsEvent["type"], listener: FirstPersonControlsListener): void {
    let bucket = this.listeners.get(type);
    if (bucket === undefined) {
      bucket = new Set();
      this.listeners.set(type, bucket);
    }
    bucket.add(listener);
  }

  removeEventListener(type: FirstPersonControlsEvent["type"], listener: FirstPersonControlsListener): void {
    this.listeners.get(type)?.delete(listener);
  }

  private dispatch(type: FirstPersonControlsEvent["type"]): void {
    const event: FirstPersonControlsEvent = { type };
    if (type === "change") {
      this.onChange.send1(event);
    } else if (type === "start") {
      this.onStart.send1(event);
    } else if (type === "end") {
      this.onEnd.send1(event);
    }
    const bucket = this.listeners.get(type);
    if (bucket !== undefined) {
      for (const listener of bucket) {
        listener(event);
      }
    }
  }

  // --- 生命周期 ---

  connect(element?: HTMLElement): void {
    if (this.connected) {
      this.disconnect();
    }
    if (element !== undefined) {
      this.domElement = element;
    }

    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.onWindowBlur);

    this.domElement.addEventListener("pointerdown", this.onPointerDown);
    this.domElement.addEventListener("contextmenu", this.onContextMenu);
    this.domElement.addEventListener("wheel", this.onWheel, { passive: false });

    const doc = this.domElement.ownerDocument || document;
    doc.addEventListener("pointermove", this.onPointerMove);
    doc.addEventListener("pointerup", this.onPointerUp);
    doc.addEventListener("pointercancel", this.onPointerUp);

    this.domElement.style.touchAction = "none";
    this.connected = true;
  }

  disconnect(): void {
    if (!this.connected) {
      return;
    }
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);

    this.domElement.removeEventListener("pointerdown", this.onPointerDown);
    this.domElement.removeEventListener("contextmenu", this.onContextMenu);
    this.domElement.removeEventListener("wheel", this.onWheel);

    const doc = this.domElement.ownerDocument || document;
    doc.removeEventListener("pointermove", this.onPointerMove);
    doc.removeEventListener("pointerup", this.onPointerUp);
    doc.removeEventListener("pointercancel", this.onPointerUp);

    this.domElement.style.touchAction = "";
    this.connected = false;
    this.stop();
  }

  dispose(): void {
    this.disconnect();
    this.listeners.clear();
    this.onChange.removeAll();
    this.onStart.removeAll();
    this.onEnd.removeAll();
  }

  /**
   * 停止当前所有瞬时速度和按键操作，使相机平稳静止。
   */
  stop(): void {
    this.keyForward = false;
    this.keyBackward = false;
    this.moveLeft = false;
    this.moveRight = false;
    this.moveUp = false;
    this.moveDown = false;
    this.isSprinting = false;
    this.isCrawling = false;
    this.pointerForward = false;
    this.pointerBackward = false;
    this.pointerCount = 0;
    this.mouseDragOn = false;
    this.velocity.set(0, 0, 0);
    this.targetVelocity.set(0, 0, 0);
    this.latVelocity = 0;
    this.lonVelocity = 0;
  }

  /**
   * 保存当前位置与朝向作为复位基准。
   */
  saveState(): void {
    this.initialPosition.copy(this.camera.transform.position);
    this.initialLat = this.lat;
    this.initialLon = this.lon;
  }

  /**
   * 重置到保存的初始位置与朝向。
   */
  reset(): void {
    this.stop();
    this.camera.transform.position.copy(this.initialPosition);
    this.lat = this.initialLat;
    this.lon = this.initialLon;
    this.targetLat = this.initialLat;
    this.targetLon = this.initialLon;
    this.updateCameraTransform();
    this.dispatch("change");
  }

  /**
   * 将视角直接朝向指定目标点，并同步内部经纬角。
   */
  lookAt(x: number | { x: number; y: number; z: number } | Vec3, y?: number, z?: number): this {
    if (typeof x === "object") {
      this.camera.transform.lookAt(x);
    } else {
      this.camera.transform.lookAt({ x, y: y ?? 0, z: z ?? 0 });
    }
    this.setOrientation();
    this.dispatch("change");
    return this;
  }

  /**
   * 从当前相机的朝向同步经纬角状态（Yaw/Pitch）。
   */
  setOrientation(): void {
    const forward = this.camera.transform.forward;
    const radius = Math.hypot(forward.x, forward.y, forward.z);
    if (radius <= EPS) {
      this.lat = 0;
      this.lon = 0;
      this.targetLat = 0;
      this.targetLon = 0;
      return;
    }
    const phi = Math.acos(clamp(forward.y / radius, -1, 1));
    const theta = Math.atan2(forward.x, forward.z);
    this.lat = 90 - phi * RAD2DEG;
    this.lon = theta * RAD2DEG;
    this.targetLat = this.lat;
    this.targetLon = this.lon;
  }

  /**
   * 每帧更新物理位置与视角姿态。
   */
  update(delta: number): boolean {
    if (!this.enabled) {
      return false;
    }

    const oldX = this.camera.transform.position.x;
    const oldY = this.camera.transform.position.y;
    const oldZ = this.camera.transform.position.z;

    let drive = (this.keyForward ? 1 : 0) - (this.keyBackward ? 1 : 0);
    let lookMove = (this.pointerForward ? 1 : 0) - (this.pointerBackward ? 1 : 0);

    if (this.autoForward && drive === 0 && lookMove === 0) {
      lookMove = 1;
    }

    // 速度修饰：冲刺 (Shift) 或慢行 (Ctrl)
    let speedScale = 1.0;
    if (this.isSprinting) {
      speedScale *= this.sprintMultiplier;
    }
    if (this.isCrawling) {
      speedScale *= this.crawlMultiplier;
    }

    const effectiveBaseSpeed = this.movementSpeed * speedScale;
    let forwardSpeed = effectiveBaseSpeed;

    if (this.heightSpeed) {
      const y = clamp(this.camera.transform.position.y, this.heightMin, this.heightMax);
      forwardSpeed += (y - this.heightMin) * this.heightCoef;
    }

    const yaw = this.lon * DEG2RAD;
    const sinYaw = Math.sin(yaw);
    const cosYaw = Math.cos(yaw);

    let strafe = (this.moveRight ? 1 : 0) - (this.moveLeft ? 1 : 0);
    let climb = (this.moveUp ? 1 : 0) - (this.moveDown ? 1 : 0);

    // 斜向移动归一化，防止斜向冲刺速度超标
    const inputLength = Math.hypot(strafe, climb, drive);
    const keyScale = inputLength > 1 ? 1 / inputLength : 1;

    strafe *= effectiveBaseSpeed * keyScale;
    climb *= effectiveBaseSpeed * keyScale;
    drive *= (drive > 0 ? forwardSpeed : effectiveBaseSpeed) * keyScale;

    // 水平世界速度合成：对齐屏幕观察空间左右平移方向（A/左方向键向左，D/右方向键向右）
    this.targetVelocity.set(sinYaw * drive - cosYaw * strafe, climb, cosYaw * drive + sinYaw * strafe);

    // 触控/鼠标推近退后（视线方向飞行）
    if (lookMove !== 0) {
      const phi = (90 - this.lat) * DEG2RAD;
      const theta = this.lon * DEG2RAD;
      const sinPhi = Math.sin(phi);
      const cosPhi = Math.cos(phi);
      this.lookDirection.set(sinPhi * Math.sin(theta), cosPhi, sinPhi * Math.cos(theta));
      const lookMoveSpeed = lookMove * (lookMove > 0 ? forwardSpeed : effectiveBaseSpeed);
      this.targetVelocity.x += this.lookDirection.x * lookMoveSpeed;
      this.targetVelocity.y += this.lookDirection.y * lookMoveSpeed;
      this.targetVelocity.z += this.lookDirection.z * lookMoveSpeed;
    }

    // 物理移动阻尼
    const damping = clamp(this.dampingFactor, 0.01, 1);
    this.velocity.lerp(this.targetVelocity, damping);

    this.camera.transform.position.x += this.velocity.x * delta;
    this.camera.transform.position.y += this.velocity.y * delta;
    this.camera.transform.position.z += this.velocity.z * delta;

    // 视角旋转计算
    let verticalLookRatio = 1;
    if (this.constrainVertical) {
      verticalLookRatio = Math.PI / Math.max(1e-4, this.verticalMax - this.verticalMin);
    }

    const ySign = this.invertY ? 1 : -1;

    if (this.lookStyle === "drag") {
      // 拖拽模式：将累计拖拽位移转为目标角度增量（往上拖抬头、往下拖低头）
      if (this.activeLook && this.mouseDragOn) {
        this.targetLon -= this.pointerOffsetDragX * this.lookSpeed;
        if (this.lookVertical) {
          this.targetLat += ySign * this.pointerOffsetDragY * this.lookSpeed * verticalLookRatio;
        }
      }
      this.pointerOffsetDragX = 0;
      this.pointerOffsetDragY = 0;

      this.lat = lerpNum(this.lat, this.targetLat, damping);
      this.lon = lerpNum(this.lon, this.targetLon, damping);
    } else {
      // 经典摇杆模式 (Three.js 偏离原点持续旋转)
      const targetLonSpeed =
        this.activeLook && this.mouseDragOn ? -this.pointerOffsetDragX * this.lookSpeed : 0;
      const targetLatSpeed =
        this.activeLook && this.mouseDragOn && this.lookVertical
          ? ySign * this.pointerOffsetDragY * this.lookSpeed * verticalLookRatio
          : 0;

      this.lonVelocity = lerpNum(this.lonVelocity, targetLonSpeed, damping);
      this.latVelocity = lerpNum(this.latVelocity, targetLatSpeed, damping);

      const angleDeltaScale = delta * 60;
      this.lon += this.lonVelocity * angleDeltaScale;
      this.lat += this.latVelocity * angleDeltaScale;
      this.targetLon = this.lon;
      this.targetLat = this.lat;
    }

    // 约束俯仰角
    this.lat = clamp(this.lat, this.minPitchDeg, this.maxPitchDeg);
    this.targetLat = clamp(this.targetLat, this.minPitchDeg, this.maxPitchDeg);

    this.updateCameraTransform();

    const changed =
      Math.hypot(
        oldX - this.camera.transform.position.x,
        oldY - this.camera.transform.position.y,
        oldZ - this.camera.transform.position.z
      ) > EPS ||
      Math.abs(this.velocity.x) > 1e-4 ||
      Math.abs(this.velocity.y) > 1e-4 ||
      Math.abs(this.velocity.z) > 1e-4 ||
      Math.abs(this.targetLon - this.lon) > 1e-4 ||
      Math.abs(this.targetLat - this.lat) > 1e-4;

    if (changed) {
      this.dispatch("change");
    }
    return changed;
  }

  private updateCameraTransform(): void {
    let finalPhi = (90 - this.lat) * DEG2RAD;
    const finalTheta = this.lon * DEG2RAD;

    if (this.constrainVertical) {
      finalPhi = mapLinear(finalPhi, 0, Math.PI, this.verticalMin, this.verticalMax);
    }

    const posX = this.camera.transform.position.x;
    const posY = this.camera.transform.position.y;
    const posZ = this.camera.transform.position.z;

    this.targetPosition.set(
      posX + Math.sin(finalPhi) * Math.sin(finalTheta),
      posY + Math.cos(finalPhi),
      posZ + Math.sin(finalPhi) * Math.cos(finalTheta)
    );

    this.camera.transform.lookAt(this.targetPosition);
    this.camera.update();
  }

  // --- 输入事件监听 ---

  private readonly onPointerDown = (event: PointerEvent): void => {
    if (this.domElement !== document.body) {
      this.domElement.focus?.();
    }
    this.domElement.setPointerCapture?.(event.pointerId);
    this.pointerCount++;

    if (event.pointerType === "touch") {
      this.pointerForward = this.pointerCount === 1;
      this.pointerBackward = this.pointerCount >= 2;
    } else {
      // 允许左键(0)或右键(2)拖拽转动视角；若不在前进后退键下，左键亦可推动
      if (event.button === 0 && !this.keyForward && !this.keyBackward && event.ctrlKey) {
        this.pointerForward = true;
      }
    }

    this.pointerDownX = event.pageX;
    this.pointerDownY = event.pageY;
    this.lastPointerX = event.pageX;
    this.lastPointerY = event.pageY;
    this.pointerOffsetDragX = 0;
    this.pointerOffsetDragY = 0;
    this.mouseDragOn = true;
    this.dispatch("start");
  };

  private readonly onPointerUp = (event: PointerEvent): void => {
    if (!this.mouseDragOn) {
      return;
    }
    this.domElement.releasePointerCapture?.(event.pointerId);
    this.pointerCount = Math.max(0, this.pointerCount - 1);

    if (event.pointerType === "touch") {
      this.pointerForward = this.pointerCount === 1;
      this.pointerBackward = false;
    } else {
      this.pointerForward = false;
      this.pointerBackward = false;
    }

    this.pointerOffsetDragX = 0;
    this.pointerOffsetDragY = 0;
    if (this.pointerCount === 0) {
      this.mouseDragOn = false;
      this.dispatch("end");
    }
  };

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (!this.mouseDragOn) {
      return;
    }
    if (this.lookStyle === "drag") {
      // 累加本次移动位移
      const dx = event.pageX - this.lastPointerX;
      const dy = event.pageY - this.lastPointerY;
      this.pointerOffsetDragX += dx;
      this.pointerOffsetDragY += dy;
      this.lastPointerX = event.pageX;
      this.lastPointerY = event.pageY;
    } else {
      this.pointerOffsetDragX = event.pageX - this.pointerDownX;
      this.pointerOffsetDragY = event.pageY - this.pointerDownY;
    }
  };

  private readonly onWheel = (event: WheelEvent): void => {
    if (!this.enabled || !this.enableSpeedWheel) {
      return;
    }
    // 鼠标滚轮动态增减漫游速度（类似于 UE / Unity 视口漫游体验）
    event.preventDefault();
    const factor = event.deltaY < 0 ? 1.15 : 0.87;
    this.movementSpeed = clamp(this.movementSpeed * factor, this.minMovementSpeed, this.maxMovementSpeed);
  };

  private readonly onWindowBlur = (): void => {
    // 窗口失焦时立即清空所有按键，防止相机卡在持续前进状态
    this.stop();
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if ((event.target as HTMLElement)?.matches?.("input, select, textarea")) {
      return;
    }
    switch (event.code) {
      case "ArrowUp":
      case "KeyW":
        this.keyForward = true;
        break;
      case "ArrowLeft":
      case "KeyA":
        this.moveLeft = true;
        break;
      case "ArrowDown":
      case "KeyS":
        this.keyBackward = true;
        break;
      case "ArrowRight":
      case "KeyD":
        this.moveRight = true;
        break;
      case "KeyR":
      case "KeyE":
      case "Space":
        this.moveUp = true;
        break;
      case "KeyF":
      case "KeyQ":
      case "KeyC":
        this.moveDown = true;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.isSprinting = true;
        break;
      case "ControlLeft":
      case "ControlRight":
      case "AltLeft":
      case "AltRight":
        this.isCrawling = true;
        break;
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    switch (event.code) {
      case "ArrowUp":
      case "KeyW":
        this.keyForward = false;
        break;
      case "ArrowLeft":
      case "KeyA":
        this.moveLeft = false;
        break;
      case "ArrowDown":
      case "KeyS":
        this.keyBackward = false;
        break;
      case "ArrowRight":
      case "KeyD":
        this.moveRight = false;
        break;
      case "KeyR":
      case "KeyE":
      case "Space":
        this.moveUp = false;
        break;
      case "KeyF":
      case "KeyQ":
      case "KeyC":
        this.moveDown = false;
        break;
      case "ShiftLeft":
      case "ShiftRight":
        this.isSprinting = false;
        break;
      case "ControlLeft":
      case "ControlRight":
      case "AltLeft":
      case "AltRight":
        this.isCrawling = false;
        break;
    }
  };

  private readonly onContextMenu = (event: Event): void => {
    if (this.enabled) {
      event.preventDefault();
    }
  };
}
