import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";

// 仅依赖 Node 标准库的持久化日志：
// - 所有状态变更先以 JSONL 追加写入并 fsync，再应用到内存；
// - 每隔若干条事件生成一次原子快照（tmp + fsync + rename）；
// - 重启时先载快照，再回放快照之后的事件；
// - 若上次进程在写入中途退出，日志末尾会留下不完整的行，启动时截断丢弃。
export class Journal {
  constructor(dir, { snapshotEvery = 50 } = {}) {
    this.dir = dir;
    this.snapshotEvery = snapshotEvery;
    this.filePath = path.join(dir, "journal.log");
    this.snapshotPath = path.join(dir, "snapshot.json");
    this.tmpSnapshotPath = path.join(dir, "snapshot.json.tmp");
    this.fd = null;
  }

  open(initialState, applyEvent) {
    mkdirSync(this.dir, { recursive: true });

    let state = initialState();
    let replayedFrom = 0;

    if (existsSync(this.snapshotPath)) {
      const snapshot = JSON.parse(readFileSync(this.snapshotPath, "utf8"));
      state = snapshot.state;
      replayedFrom = snapshot.seq;
    }

    if (existsSync(this.filePath)) {
      const buffer = readFileSync(this.filePath);
      let goodBytes = 0;
      let cursor = 0;
      while (cursor < buffer.length) {
        const lineEnd = buffer.indexOf(0x0a, cursor);
        if (lineEnd === -1) break; // 末尾没有换行：一定是未写完整的行
        const line = buffer.toString("utf8", cursor, lineEnd);
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          break; // 撕裂行，停在最后一条完整记录处
        }
        if (event.seq > replayedFrom) applyEvent(state, event);
        // 快照之前的事件不再归约，但日志没有截断，序号仍需推进
        state.seq = event.seq;
        goodBytes = lineEnd + 1;
        cursor = lineEnd + 1;
      }
      if (goodBytes < buffer.length) truncateSync(this.filePath, goodBytes);
    }

    this.fd = openSync(this.filePath, "a");
    return state;
  }

  // 多条事件一次性写入并只做一次 fsync：离线整批交接要么全部落盘，要么全部没有。
  commitMany(state, entries, applyEvent) {
    const lines = [];
    const events = [];
    for (const { type, payload } of entries) {
      state.seq += 1;
      const event = { seq: state.seq, type, payload };
      events.push(event);
      lines.push(JSON.stringify(event));
    }
    const chunk = lines.length ? `${lines.join("\n")}\n` : "";
    if (chunk) {
      writeSync(this.fd, chunk);
      fsyncSync(this.fd);
    }
    for (const event of events) applyEvent(state, event);
    if (this.snapshotEvery > 0 && state.seq % this.snapshotEvery < events.length) {
      this.#writeSnapshot(state);
    }
    return events;
  }

  commit(state, type, payload, applyEvent) {
    return this.commitMany(state, [{ type, payload }], applyEvent)[0];
  }

  #writeSnapshot(state) {
    const fd = openSync(this.tmpSnapshotPath, "w");
    try {
      writeSync(fd, JSON.stringify({ seq: state.seq, state }));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(this.tmpSnapshotPath, this.snapshotPath);
  }

  close() {
    if (this.fd !== null) {
      fsyncSync(this.fd);
      closeSync(this.fd);
      this.fd = null;
    }
  }

  // 测试辅助：强行写一份快照并在日志尾部追加一条撕裂记录。
  static corruptTail(dir) {
    const filePath = path.join(dir, "journal.log");
    const fd = openSync(filePath, "a");
    try {
      writeSync(fd, '{"seq":999,"type":"broken","paylo');
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  }

  static writeSnapshotFile(dir, state) {
    writeFileSync(path.join(dir, "snapshot.json"), JSON.stringify({ seq: state.seq, state }));
  }
}
