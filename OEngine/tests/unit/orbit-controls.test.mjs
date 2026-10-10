import assert from "node:assert/strict";
import test from "node:test";
import { OrbitControls } from "../../.test-dist/camera/OrbitControls.js";
import { PerspectiveCamera } from "../../.test-dist/camera/PerspectiveCamera.js";

function harness() {
  const handlers = new Map();
  const document = { addEventListener() {}, removeEventListener() {} };
  let sizeReads = 0;
  const element = {
    ownerDocument: document,
    get clientHeight() {
      sizeReads++;
      return 600;
    },
    getBoundingClientRect() {
      throw new Error("pointer must not query layout");
    },
    addEventListener(type, listener) {
      handlers.set(type, listener);
    },
    removeEventListener(type) {
      handlers.delete(type);
    }
  };
  const camera = new PerspectiveCamera();
  camera.transform.position.set(0, 0, 10);
  camera.transform.lookAt({ x: 0, y: 0, z: 0 });
  camera.update();
  const controls = new OrbitControls(camera, element);
  const emit = (type, data) =>
    handlers.get(type)?.({
      pointerId: 1,
      pointerType: "mouse",
      button: 0,
      clientX: 100,
      clientY: 100,
      preventDefault() {},
      ...data
    });
  return { camera, controls, emit, handlers, sizeReads: () => sizeReads };
}

test("pointer rotation, right pan and wheel accumulate until the interaction tick", () => {
  const { camera, controls, emit, sizeReads } = harness();
  controls.enableDamping = false;
  const initial = camera.transform.position.clone();
  emit("pointerdown", {});
  emit("pointermove", { clientX: 130 });
  assert.ok(camera.transform.position.equals(initial));
  controls.update(1 / 60);
  assert.ok(controls.getAzimuthalAngle() < 0);
  emit("pointerup", {});
  emit("pointerdown", { button: 2 });
  emit("pointermove", { clientX: 120, clientY: 115 });
  controls.update(1 / 60);
  assert.ok(controls.target.length() > 0);
  emit("pointerup", {});
  const distance = controls.distance;
  emit("wheel", { deltaY: -100 });
  controls.update(1 / 60);
  assert.ok(controls.distance < distance);
  emit("wheel", { deltaY: 100 });
  controls.update(1 / 60);
  assert.ok(Math.abs(controls.distance - distance) < 1e-10);
  assert.equal(sizeReads(), 1, "moves and pan do not read element geometry");
  controls.dispose();
});

test("rotate/pan/dolly damping consumes equal impulses over equal real time at 30–144 Hz", () => {
  const results = [];
  for (const hz of [30, 60, 90, 120, 144]) {
    const { controls, camera } = harness();
    controls.rotateLeft(0.5);
    controls.rotateUp(0.1);
    controls.pan(30, 20);
    controls.dollyIn(0.9);
    for (let tick = 0; tick < hz; tick++) controls.update(1 / hz);
    results.push({
      theta: controls.getAzimuthalAngle(),
      radius: controls.distance,
      position: [...camera.transform.position],
      target: [...controls.target]
    });
    controls.dispose();
  }
  const reference = results[1];
  for (const value of results) {
    assert.ok(Math.abs(value.theta - reference.theta) < 1e-10);
    assert.ok(Math.abs(value.radius - reference.radius) < 1e-10);
    for (const key of ["position", "target"]) {
      value[key].forEach((component, axis) => assert.ok(Math.abs(component - reference[key][axis]) < 1e-9));
    }
  }
});

test("60 Hz rotation preserves dampingFactor; zero time, reset and external camera edits are safe", () => {
  const { controls, camera } = harness();
  controls.rotateLeft(1);
  controls.update(0);
  assert.equal(controls.getAzimuthalAngle(), 0);
  controls.update(1 / 60);
  assert.ok(Math.abs(controls.getAzimuthalAngle() + controls.dampingFactor) < 1e-12);
  controls.reset();
  const afterReset = camera.transform.position.clone();
  controls.update(1 / 60);
  assert.ok(camera.transform.position.distanceTo(afterReset) < 1e-10);
  camera.transform.position.set(4, 2, 8);
  camera.transform.lookAt(controls.target);
  controls.reset();
  assert.ok(Math.abs(controls.distance - Math.sqrt(84)) < 1e-10);
  camera.transform.position.set(3, 2, 7);
  controls.update(1 / 60);
  assert.ok(camera.transform.position.distanceTo({ x: 3, y: 2, z: 7 }) < 1e-10);
  assert.throws(() => controls.update(NaN), /deltaTime/);
  assert.throws(() => controls.update(-1), /deltaTime/);
  controls.dispose();
});

test("two-finger pan and pinch preserve both pointer references without layout reads", () => {
  const { controls, emit, handlers } = harness();
  controls.enableDamping = false;
  emit("pointerdown", { pointerType: "touch" });
  emit("pointerdown", { pointerType: "touch", pointerId: 2, clientX: 200 });
  emit("pointermove", { pointerType: "touch", pointerId: 2, clientX: 220, clientY: 120 });
  controls.update();
  assert.ok(controls.target.length() > 0);
  assert.ok(controls.distance < 10);
  controls.dispose();
  assert.equal(handlers.size, 0);
});
