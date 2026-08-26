import test from "node:test";
import assert from "node:assert/strict";

import { FrameCoordinator } from "../.test-dist/render/FrameCoordinator.js";

test("frame coordinator owns one active render submission", () => {
  const commands = [];
  const coordinator = new FrameCoordinator({}, (_graphics, label) => {
    const command = new FakeCommand(label);
    commands.push(command);
    return command;
  });

  const frame = coordinator.beginFrame(7, "Renderer/main-0");
  assert.equal(frame.command, commands[0]);
  assert.throws(
    () => coordinator.beginFrame(8, "Renderer/main-0"),
    /still active/
  );

  const evidence = coordinator.submitFrame(frame);
  assert.deepEqual(evidence, {
    frameIndex: 7,
    submitLabel: "Renderer/main-0",
    closed: true,
    submitted: true
  });
  assert.equal(commands[0].finishCount, 1);
  assert.throws(() => coordinator.submitFrame(frame), /stale/);

  const next = coordinator.beginFrame(8, "Renderer/main-0");
  coordinator.abortFrame(next, new Error("encode failed"));
  assert.equal(commands[1].abortCount, 1);
  assert.match(String(commands[1].abortCause), /encode failed/);
});

test("destroy aborts an open frame and rejects future work", () => {
  const command = new FakeCommand("Renderer/main-0");
  const coordinator = new FrameCoordinator({}, () => command);
  coordinator.beginFrame(1, "Renderer/main-0");
  coordinator.destroy();

  assert.equal(command.abortCount, 1);
  assert.match(String(command.abortCause), /destroyed during frame 1/);
  assert.throws(
    () => coordinator.beginFrame(2, "Renderer/main-0"),
    /destroyed/
  );
});

test("a failed close remains abortable by the render error boundary", () => {
  const command = new FakeCommand("Renderer/main-0");
  command.finishError = new Error("encoder close failed");
  const coordinator = new FrameCoordinator({}, () => command);
  const frame = coordinator.beginFrame(3, "Renderer/main-0");

  assert.throws(() => coordinator.submitFrame(frame), /encoder close failed/);
  coordinator.abortFrame(frame, command.finishError);
  assert.equal(command.abortCount, 1);

  const next = coordinator.beginFrame(4, "Renderer/main-0");
  assert.equal(next.frameIndex, 4);
});

class FakeCommand {
  finishCount = 0;
  abortCount = 0;
  abortCause = null;
  finishError = null;

  constructor(label) {
    this.label = label;
  }

  finish() {
    this.finishCount++;
    if (this.finishError) throw this.finishError;
  }

  abort(cause) {
    this.abortCount++;
    this.abortCause = cause;
  }
}
