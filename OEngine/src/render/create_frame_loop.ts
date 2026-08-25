/**
 * create_frame_loop：负责渲染管线编排、视图状态或渲染目标管理。
 */

export function create_frame_loop(
  callback: (time_delta_s: number, raw_refresh_time_s: number) => void,
  frame_cap: number = Number.POSITIVE_INFINITY
): () => void {
  const interval = Number.isFinite(frame_cap) ? 1000 / frame_cap : 0;
  const slack = 0.05 * interval;
  let scheduledTime = performance.now();
  let rawTime = scheduledTime;
  let requestId = requestAnimationFrame(function frame(now: number): void {
    requestId = requestAnimationFrame(frame);
    const elapsed = now - scheduledTime;
    if (elapsed >= interval - slack) {
      callback(0.001 * elapsed, 0.001 * (now - rawTime));
      if (elapsed > 1.5 * interval) scheduledTime = now;
      else scheduledTime += interval;
      rawTime = now;
    }
  });
  return () => cancelAnimationFrame(requestId);
}
