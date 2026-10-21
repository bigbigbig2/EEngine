import { resolve, relative, isAbsolute, basename } from "node:path";
import { rm } from "node:fs/promises";

/** Only a successful invocation's UUID child can retire. Never accept a root,
 * ancestor, nested arbitrary directory, or symlink traversal as a job owner. */
export async function retireSuccessfulImageJob(root, job) {
  const parent = resolve(root);
  const target = resolve(job);
  const child = relative(parent, target);
  if (
    isAbsolute(child) ||
    child !== basename(target) ||
    !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(child)
  ) {
    throw new Error("Image scratch retirement requires its direct UUID job child");
  }
  const { lstat, realpath } = await import("node:fs/promises");
  if (
    (await lstat(target)).isSymbolicLink() ||
    relative(await realpath(parent), await realpath(target)) !== child
  ) {
    throw new Error("Image scratch retirement cannot follow a redirected job");
  }
  await rm(target, { recursive: true });
}
