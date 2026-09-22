import { mkdir, open } from "node:fs/promises";
import path from "node:path";

/**
 * 追加式事件日志：每个状态变更先落盘（write + fsync）再应用，
 * 进程在交接中途退出后，重启时重放日志即可恢复未完成的流转。
 * 末尾半行（崩溃时写了一半）会在打开时被截断，不影响已完整提交的记录。
 */
export class Journal {
  constructor(filePath) {
    this.filePath = filePath;
    this.handle = null;
    this.queue = Promise.resolve();
  }

  async open() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    let handle;
    try {
      handle = await open(this.filePath, "r+");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      handle = await open(this.filePath, "w+");
    }
    this.handle = handle;

    const { size } = await handle.stat();
    const events = [];
    this.appendPosition = size;
    if (size === 0) return events;

    const buffer = Buffer.alloc(size);
    await handle.read(buffer, 0, size, 0);
    const text = buffer.toString("utf8");

    let offset = 0;
    let validBytes = 0;
    for (const line of text.split("\n")) {
      if (line === "") {
        offset += 1;
        continue;
      }
      try {
        events.push(JSON.parse(line));
        validBytes = offset + Buffer.byteLength(line) + 1;
      } catch {
        // 只容忍末尾的半截记录（进程在写入中途退出）；中间损坏属于数据事故。
        if (offset + Buffer.byteLength(line) < size) {
          throw new Error(`事件日志在中间位置损坏，无法恢复（字节偏移 ${offset}）`);
        }
        break;
      }
      offset += Buffer.byteLength(line) + 1;
    }
    if (validBytes < size) {
      await handle.truncate(validBytes);
    }
    // 带 position 的 read 不移动文件指针，追加位置必须显式记录，
    // 否则重开日志后的第一次写入会覆盖文件开头。
    this.appendPosition = validBytes;
    return events;
  }

  /** 顺序追加一批事件并 fsync；同一批事件一次写入，保证要么全在要么全不在。 */
  appendAll(events) {
    const payload = events.map((event) => JSON.stringify(event)).join("\n") + "\n";
    const bytes = Buffer.byteLength(payload);
    const write = this.queue.then(async () => {
      await this.handle.write(payload, this.appendPosition, "utf8");
      this.appendPosition += bytes;
      await this.handle.sync();
    });
    this.queue = write.catch(() => {});
    return write;
  }

  async close() {
    await this.queue;
    if (this.handle) {
      await this.handle.close();
      this.handle = null;
    }
  }
}
