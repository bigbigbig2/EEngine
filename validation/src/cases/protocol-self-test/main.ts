import { createValidationController } from "../../host/protocol.ts";

const status = document.querySelector<HTMLElement>("#status");
let listenerAttached = true;
const onVisibility = (): void => undefined;
document.addEventListener("visibilitychange", onVisibility);

const controller = createValidationController({
  caseId: "protocol-self-test",
  workloadId: "protocol-self-test-v1"
}, () => {
  document.removeEventListener("visibilitychange", onVisibility);
  listenerAttached = false;
  if (status) status.textContent = "disposed";
  return { listeners: listenerAttached ? 1 : 0, rafPending: 0, gpuOwners: 0 };
});

try {
  controller.transition("negotiating");
  controller.addEvidence("secureContext", window.isSecureContext);
  controller.transition("ready");
  controller.transition("warming");
  await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
  controller.transition("sampling");
  controller.addEvidence("freshDocument", performance.getEntriesByType("navigation").length === 1);
  controller.addEvidence("navigationCount", controller.snapshot.navigationCount);
  controller.addEvidence("documentId", controller.snapshot.documentId);
  controller.transition("draining");
  controller.addEvidence("listenerAttachedBeforeDispose", listenerAttached);
  if (status) status.textContent = "passed";
  controller.pass();
} catch (error) {
  controller.fail(error instanceof Error ? error.message : String(error));
}
