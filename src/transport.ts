import { watch, constants, FSWatcher } from "node:fs";
import { mkdtemp, chmod, lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  Envelope,
  Operation,
  Request,
  rBridgeCode,
  validateEnvelope,
} from "./protocol";
export interface Dispatch {
  (code: string, sessionId: string): PromiseLike<unknown> | void;
}
export interface RequestInput {
  operation: Operation;
  context?: string;
  handle?: string;
  limit?: number;
  row_limit?: number;
  file_path?: string;
}
export class BridgeTransport {
  private tail: Promise<unknown> = Promise.resolve();
  private disposed = false;
  private controllers = new Set<AbortController>();
  constructor(
    private dispatch: Dispatch,
    private timeoutMs = 30000,
    private temporaryRoot = tmpdir(),
  ) {}
  request(
    sessionId: string,
    input: RequestInput,
    signal?: AbortSignal,
  ): Promise<Envelope> {
    if (this.disposed)
      return Promise.reject(new Error("DataRaft transport is disposed."));
    const task = this.tail
      .catch(() => undefined)
      .then(() => this.run(sessionId, input, signal));
    this.tail = task.catch(() => undefined);
    return task;
  }
  dispose(): void {
    this.disposed = true;
    for (const controller of this.controllers) controller.abort();
  }
  private async run(
    sessionId: string,
    input: RequestInput,
    outer?: AbortSignal,
  ): Promise<Envelope> {
    if (this.disposed) throw new Error("DataRaft transport is disposed.");
    if (outer?.aborted) throw new Error("DataRaft request cancelled.");
    const controller = new AbortController();
    this.controllers.add(controller);
    const abort = () => controller.abort();
    outer?.addEventListener("abort", abort, { once: true });
    let directory: string | undefined;
    let watcher: FSWatcher | undefined;
    let timer: NodeJS.Timeout | undefined;
    try {
      directory = await mkdtemp(join(this.temporaryRoot, "dataraft-ide-"));
      await chmod(directory, 0o700);
      if (controller.signal.aborted)
        throw new Error("DataRaft request cancelled.");
      const requestId = randomUUID(),
        path = join(directory, "response.json");
      const request: Request = {
        version: 1,
        request_id: requestId,
        response_path: path,
        ...input,
      };
      return await new Promise<Envelope>((resolve, reject) => {
        let settled = false,
          reading = false;
        const done = (error: Error | null, response?: Envelope) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener("abort", cancel);
          if (error) reject(error);
          else resolve(response!);
        };
        const cancel = () =>
          done(
            new Error(
              "DataRaft request cancelled. Already queued R work may still finish.",
            ),
          );
        const read = async () => {
          if (settled || reading) return;
          reading = true;
          try {
            const info = await lstat(path);
            if (!info.isFile() || info.isSymbolicLink() || info.size > 1048576)
              throw new Error("Unsafe or oversized DataRaft response file.");
            const file = await open(
              path,
              constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
            );
            let content: string;
            try {
              const stat = await file.stat();
              if (!stat.isFile() || stat.size > 1048576)
                throw new Error("Unsafe DataRaft response file.");
              content = await file.readFile("utf8");
              if (Buffer.byteLength(content) > 1048576)
                throw new Error("DataRaft response exceeds 1 MiB.");
            } finally {
              await file.close();
            }
            let parsed: unknown;
            try {
              parsed = JSON.parse(content);
            } catch {
              throw new Error("DataRaft response is not valid JSON.");
            }
            done(
              null,
              validateEnvelope(parsed, {
                requestId,
                operation: input.operation,
              }),
            );
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT")
              done(
                error instanceof Error
                  ? error
                  : new Error("DataRaft response failed."),
              );
          } finally {
            reading = false;
          }
        };
        controller.signal.addEventListener("abort", cancel, { once: true });
        timer = setTimeout(() => {
          void read().finally(() =>
            done(
              new Error(
                "DataRaft response timed out. Check the selected R session, dataraft.ide installation and shared filesystem. Already queued work may still finish.",
              ),
            ),
          );
        }, this.timeoutMs);
        watcher = watch(directory!, (_event, filename) => {
          if (filename?.toString() === "response.json") void read();
        });
        watcher.on("error", () =>
          done(new Error("Could not watch the DataRaft response directory.")),
        );
        if (controller.signal.aborted) {
          cancel();
          return;
        }
        try {
          const queued = this.dispatch(rBridgeCode(request), sessionId);
          Promise.resolve(queued).then(
            () => void read(),
            () =>
              done(
                new Error(
                  "Positron rejected the DataRaft request. Check the R console.",
                ),
              ),
          );
        } catch {
          done(new Error("Positron could not queue the DataRaft request."));
        }
      });
    } finally {
      if (timer) clearTimeout(timer);
      watcher?.close();
      outer?.removeEventListener("abort", abort);
      this.controllers.delete(controller);
      if (directory)
        await rm(directory, {
          recursive: true,
          force: true,
          maxRetries: 3,
          retryDelay: 10,
        });
    }
  }
}
